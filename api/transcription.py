"""Turn short microphone recordings into text on the HeatMatch server."""
import asyncio
import json
import os
from functools import lru_cache
from io import BytesIO
from itertools import chain
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .demo_login import require_demo_login
from .download_speech_model import MODEL_DIR as VOSK_MODEL

router = APIRouter()
MODELS = Path(__file__).resolve().parents[1] / ".models"
transcription_slot = asyncio.Semaphore(1)
model_load_lock = Lock()
AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "video/webm", "video/mp4"}
MAX_BYTES = 2 * 1024 * 1024
SAMPLE_RATE = 16000


class TranscriptionUnavailable(RuntimeError):
    pass


def speech_model_path():
    hosted = os.environ.get("RENDER") == "true"
    base = MODELS / "base.en"
    tiny = MODELS / "tiny.en"
    if VOSK_MODEL.joinpath("am", "final.mdl").is_file() and (
        hosted or not any((model / "model.bin").is_file() for model in (base, tiny))
    ):
        return VOSK_MODEL
    prefer_tiny = hosted or not (base / "model.bin").is_file()
    model = tiny if prefer_tiny and (tiny / "model.bin").is_file() else base
    return model if (model / "model.bin").is_file() else None


@lru_cache(maxsize=1)
def load_model(model):
    if model is None:
        raise TranscriptionUnavailable("Speech recognition needs a model. See the HeatMatch setup guide.")
    try:
        if model == VOSK_MODEL:
            from vosk import Model, SetLogLevel

            SetLogLevel(-1)
            return Model(str(model))

        from faster_whisper import WhisperModel

        threads = 1 if os.environ.get("RENDER") == "true" else 4
        return WhisperModel(str(model), device="cpu", compute_type="int8", cpu_threads=threads)
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        raise TranscriptionUnavailable("Speech recognition could not start. See the HeatMatch setup guide.") from error


def prepare_model(path):
    with model_load_lock:
        return load_model(path)


def transcribe_audio(recording):
    path = speech_model_path()
    model = prepare_model(path)
    import av
    import numpy as np
    from av.error import FFmpegError

    samples = []
    count = 0
    resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
    try:
        with av.open(recording, mode="r") as container:
            if not container.streams.audio:
                raise ValueError("The recording contains no audio.")
            for frame in chain(container.decode(audio=0), (None,)):
                for result in resampler.resample(frame):
                    count += result.samples
                    if count > SAMPLE_RATE * 20:
                        raise ValueError("Keep microphone recordings under 20 seconds.")
                    samples.append(result.to_ndarray()[0])
    except (FFmpegError, OSError) as error:
        raise ValueError("The recording could not be read. Try recording again.") from error
    if not samples:
        return ""
    audio = np.concatenate(samples)
    if path == VOSK_MODEL:
        from vosk import KaldiRecognizer

        recognizer = KaldiRecognizer(model, SAMPLE_RATE)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        parts = []
        for offset in range(0, len(pcm), 8000):
            if recognizer.AcceptWaveform(pcm[offset:offset + 8000]):
                parts.append(json.loads(recognizer.Result())["text"])
        parts.append(json.loads(recognizer.FinalResult())["text"])
        return " ".join(filter(None, parts))

    segments, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=True,
                                   max_new_tokens=80, condition_on_previous_text=False)
    return " ".join(segment.text.strip() for segment in segments).strip()


@router.post("/api/transcribe")
async def transcribe(request: Request):
    if os.environ.get("RENDER") == "true":
        await require_demo_login(request)
    mime_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if mime_type not in AUDIO_TYPES:
        return JSONResponse({"error": "Unsupported microphone recording format."}, status_code=415)

    recording = BytesIO()
    async for chunk in request.stream():
        if recording.tell() + len(chunk) > MAX_BYTES:
            return JSONResponse({"error": "Recording is too large. Try a shorter question."}, status_code=413)
        recording.write(chunk)
    if not recording.tell():
        return JSONResponse({"error": "No microphone audio was captured."}, status_code=400)
    recording.seek(0)

    if transcription_slot.locked():
        return JSONResponse({"error": "Speech recognition is busy. Try again or type your question."}, status_code=503)
    try:
        async with transcription_slot:
            warmup = getattr(request.app.state, "speech_warmup", None)
            if warmup and not warmup.done():
                await asyncio.shield(warmup)
            text = await run_in_threadpool(transcribe_audio, recording)
    except TranscriptionUnavailable as error:
        return JSONResponse({"error": str(error)}, status_code=503)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse({"text": text}, headers={"Cache-Control": "no-store"})
