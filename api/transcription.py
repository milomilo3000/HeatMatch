"""Turn short microphone recordings into text on this device."""
import os
from functools import lru_cache
from io import BytesIO
from itertools import chain
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .demo_login import require_demo_login

router = APIRouter()
MODEL = Path(__file__).resolve().parents[1] / ".models" / "base.en"
AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "video/webm", "video/mp4"}
MAX_BYTES = 2 * 1024 * 1024
SAMPLE_RATE = 16000


class TranscriptionUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=1)
def load_model():
    if not (MODEL / "model.bin").is_file():
        raise TranscriptionUnavailable("Local speech recognition needs a model. See the HeatMatch setup guide.")
    try:
        from faster_whisper import WhisperModel

        return WhisperModel(str(MODEL), device="cpu", compute_type="int8", cpu_threads=4)
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        raise TranscriptionUnavailable("Local speech recognition could not start. See the HeatMatch setup guide.") from error


def transcribe_audio(recording):
    model = load_model()
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
    segments, _ = model.transcribe(np.concatenate(samples), language="en", beam_size=1, vad_filter=True)
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

    try:
        text = await run_in_threadpool(transcribe_audio, recording)
    except TranscriptionUnavailable as error:
        return JSONResponse({"error": str(error)}, status_code=503)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse({"text": text}, headers={"Cache-Control": "no-store"})
