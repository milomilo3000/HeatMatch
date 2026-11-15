"""Synthesize assistant replies using the server's ElevenLabs account."""
import os
from typing import Annotated
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, StringConstraints

from .demo_login import require_demo_login

router = APIRouter()
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"


class SpeechRequest(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


@router.post("/api/speech", dependencies=[Depends(require_demo_login)])
async def speech(request: SpeechRequest):
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return JSONResponse({"error": "Voice playback is unavailable. ElevenLabs is not configured."}, status_code=503)

    voice = os.getenv("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{quote(voice, safe='')}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            audio = await client.post(
                url,
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": key, "Accept": "audio/mpeg"},
                json={"text": request.text, "model_id": "eleven_flash_v2_5"},
            )
            audio.raise_for_status()
    except httpx.HTTPError:
        return JSONResponse({"error": "Voice playback is unavailable. ElevenLabs could not generate audio."}, status_code=502)

    if not audio.headers.get("content-type", "").lower().startswith("audio/mpeg") or not audio.content:
        return JSONResponse({"error": "ElevenLabs returned no playable audio."}, status_code=502)
    return Response(audio.content, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
