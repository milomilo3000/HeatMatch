"""HeatMatch API. Run: .venv/bin/uvicorn api.main:app --port 8000

  POST /api/proposal        draft the two owner letters
  POST /api/extract-usage   read an owner's energy file (any format) into usage numbers
  POST /api/assistant       turn a spoken request into a search intent
  GET  /api/health          which AI backend is in use

All three use api/ai.py: the Claude Code CLI if it is installed and logged in (works with a
Claude subscription, no API key), otherwise ANTHROPIC_API_KEY. With neither, each endpoint
returns 503 and the web app falls back to its offline behaviour.
"""
from . import ai
from .assistant import router as assistant_router
from .proposal import app
from .usage import router as usage_router

app.include_router(usage_router)
app.include_router(assistant_router)


@app.get("/api/ai")
async def ai_status():
    return {"backend": ai.backend()}
