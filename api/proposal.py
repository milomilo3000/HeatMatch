"""Proposal drafting endpoint (mounted by api/main.py; run: .venv/bin/uvicorn api.main:app --port 8000).

The browser posts a pair's facts (all computed from public data); Claude drafts one letter
to each owner and streams it back as plain text. The web app falls back to a template
letter if this endpoint is unreachable, so the demo never blocks on it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack, asynccontextmanager, suppress

import anthropic
from fastapi import Depends, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

from . import ai
from .demo_login import require_demo_login
from .download_speech_model import download_model
from .transcription import VOSK_MODEL, prepare_model, speech_model_path

MAX_FACTS_BYTES = 20_000

SYSTEM = """You draft short, concrete outreach letters for HeatMatch NYC, a screening tool that pairs \
New York City buildings that reject waste heat with neighbors that burn fuel for heat and hot water.

You get a JSON object of facts about one pair, computed from public data (NYC LL84 benchmarking, the \
cooling-tower registry, PLUTO, NREL load profiles). Write two letters:

1. To the owner of the heat SOURCE: lead with their estimated annual cooling-tower savings. Follow with \
the potential to sell heat and what it asks of them (access to the condenser-water loop and plant-room space).
2. To the owner of the heat SINK: lead with their estimated annual reduction in costs. Distinguish fuel \
savings after heat-pump electricity from avoided LL97 penalty exposure. Give the estimated installed cost \
and share of demand covered as supporting details.

Rules:
- Omit payback, break-even timelines, and any estimate of how long it takes to recover the installed cost.
- Describe projected savings as estimates. Omit demo labels and scenario assumptions from the letters.
- If source.is_data_center is true, explain that steady IT waste heat makes it a reliable heat supply.
  Say whether the heat figure comes from a measured IT load or an estimate (source.role tells you).
- Use only numbers that appear in the facts. Round sensibly. Never invent figures, names or programs.
- If energy costs increase, say so. When avoided LL97 penalties offset that increase, explain the distinction.
- Say once that these are screening estimates that need an engineering feasibility study.
- Mention the distance and what crossing it involves (party wall, easement, or DOT street permit).
- Each letter: a "TO:" line, a "RE:" line, then 120-180 words, then a single proposed next step.
- Plain text, no markdown headings or bold. Separate the two letters with a line containing only "---".
- Sign each letter "HeatMatch NYC"."""

async def warm_speech():
    try:
        await run_in_threadpool(download_model)
        await run_in_threadpool(prepare_model, VOSK_MODEL)
    except (OSError, RuntimeError):
        logging.getLogger(__name__).exception("Could not warm the hosted microphone model")


@asynccontextmanager
async def lifespan(app):
    warmup = asyncio.create_task(warm_speech()) if os.environ.get("RENDER") == "true" else None
    app.state.speech_warmup = warmup
    try:
        yield
    finally:
        if warmup:
            warmup.cancel()
            with suppress(asyncio.CancelledError):
                await warmup


app = FastAPI(title="HeatMatch API", lifespan=lifespan)


@app.get("/api/health")
async def health():
    speech_model = speech_model_path()
    return {"ok": True, "backend": ai.backend(), "api_model": ai.model(),
            "transcription_model": speech_model.name if speech_model else None}


@app.post("/api/proposal", dependencies=[Depends(require_demo_login)])
async def proposal(request: Request):
    body = await request.body()
    if len(body) > MAX_FACTS_BYTES:
        return JSONResponse({"error": "facts payload too large"}, status_code=413)
    try:
        facts = json.loads(body)
    except json.JSONDecodeError:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    if not isinstance(facts, dict):
        return JSONResponse({"error": "expected a JSON object of pair facts"}, status_code=400)
    facts.pop("scenario", None)
    annual = facts.get("annual")
    if isinstance(annual, dict):
        annual.pop("payback_range_years", None)

    user = "Facts for this pair:\n" + json.dumps(facts, indent=1)
    # Open the stream before responding so auth/rate-limit errors become a proper HTTP status
    # (the browser then shows the template letter instead).
    try:
        async with AsyncExitStack() as opening:
            client = await opening.enter_async_context(anthropic.AsyncAnthropic(**ai.client_options(120)))
            stream = await opening.enter_async_context(client.messages.stream(
                model=ai.model(),
                max_tokens=8000,
                output_config={"effort": "low"},
                system=SYSTEM,
                messages=[{"role": "user", "content": user}],
            ))
            stack = opening.pop_all()
    except ai.AIUnavailable as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except anthropic.AuthenticationError:
        return JSONResponse({"error": "the Anthropic API key was rejected"}, status_code=503)
    except anthropic.RateLimitError:
        return JSONResponse({"error": "rate limited"}, status_code=429)
    except anthropic.APIStatusError as e:
        return JSONResponse({"error": f"Claude API error {e.status_code}"}, status_code=502)
    except anthropic.APIConnectionError:
        return JSONResponse({"error": "cannot reach Claude API"}, status_code=502)

    async def gen():
        async with stack:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                yield "\n\n[The model declined to draft this letter.]"
            elif final.stop_reason == "max_tokens":
                yield "\n\n[Draft truncated.]"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")
