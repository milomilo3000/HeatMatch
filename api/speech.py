"""Synthesize replies and authorize live transcription with ElevenLabs."""
import json
import logging
import os
from contextlib import closing
from http.client import HTTPException, HTTPSConnection
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, StringConstraints

from .demo_login import require_demo_login

router = APIRouter()
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"


class SpeechRequest(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


@router.post("/api/scribe-token", dependencies=[Depends(require_demo_login)])
def scribe_token():
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return JSONResponse({"error": "Live transcription is unavailable. ElevenLabs is not configured."}, status_code=503)

    error = {"error": "ElevenLabs could not start live transcription."}
    headers = {"xi-api-key": key, "Accept": "application/json"}
    try:
        with closing(HTTPSConnection("api.elevenlabs.io", timeout=10)) as client:
            client.request("POST", "/v1/single-use-token/realtime_scribe", headers=headers)
            with client.getresponse() as response:
                if response.status != 200:
                    logging.getLogger(__name__).warning("ElevenLabs rejected a Scribe token request: HTTP %s", response.status)
                    return JSONResponse(error, status_code=502)
                payload = json.loads(response.read())
    except (OSError, HTTPException, ValueError):
        return JSONResponse(error, status_code=502)

    token = payload.get("token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        return JSONResponse(error, status_code=502)
    return JSONResponse({"token": token}, headers={"Cache-Control": "no-store"})


@router.post("/api/speech", dependencies=[Depends(require_demo_login)])
def speech(request: SpeechRequest):
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return JSONResponse({"error": "Voice playback is unavailable. ElevenLabs is not configured."}, status_code=503)

    voice = os.getenv("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE
    path = f"/v1/text-to-speech/{quote(voice, safe='')}?output_format=mp3_44100_128"
    headers = {"xi-api-key": key, "Accept": "audio/mpeg", "Content-Type": "application/json"}
    payload = json.dumps({"text": request.text, "model_id": "eleven_flash_v2_5"}).encode("utf-8")
    provider_error = {"error": "Voice playback is unavailable. ElevenLabs could not generate audio."}
    try:
        with closing(HTTPSConnection("api.elevenlabs.io", timeout=15)) as client:
            client.request("POST", path, body=payload, headers=headers)
            with client.getresponse() as audio:
                if audio.status != 200:
                    return JSONResponse(provider_error, status_code=502)
                mime_type = audio.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
                body = audio.read() if mime_type == "audio/mpeg" else b""
    except (OSError, HTTPException):
        return JSONResponse(provider_error, status_code=502)

    if not body:
        return JSONResponse({"error": "ElevenLabs returned no playable audio."}, status_code=502)
    return Response(body, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
