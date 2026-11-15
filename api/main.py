"""HeatMatch API. Run: .venv/bin/uvicorn api.main:app --port 8000

  POST /api/proposal        draft the two owner letters
  POST /api/extract-usage   read an owner's energy file (any format) into usage numbers
  POST /api/assistant       turn a spoken request into a search intent
  POST /api/speech          synthesize an assistant reply with ElevenLabs
  POST /api/transcribe      transcribe a microphone recording locally
  GET  /api/health          which AI backend is in use

The Claude features use ANTHROPIC_API_KEY. Without it, the web app uses its offline
search, CSV import and proposal templates. Speech uses ELEVENLABS_API_KEY.
"""
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from . import ai
from .assistant import router as assistant_router
from .demo_login import router as demo_router
from .proposal import app
from .speech import router as speech_router
from .transcription import router as transcription_router
from .usage import router as usage_router

app.include_router(usage_router)
app.include_router(assistant_router)
app.include_router(speech_router)
app.include_router(transcription_router)
app.include_router(demo_router)


@app.get("/api/ai")
async def ai_status():
    return {"backend": ai.backend()}


web_build = Path(__file__).resolve().parents[1] / "web" / "dist"
if web_build.joinpath("index.html").is_file():
    app.mount("/", StaticFiles(directory=web_build, html=True), name="website")
