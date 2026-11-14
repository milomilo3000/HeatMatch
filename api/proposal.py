"""Proposal drafting endpoint. Run: .venv/bin/uvicorn api.proposal:app --port 8000

The browser posts a pair's facts (all computed from public data); Claude drafts one letter
to each owner and streams it back as plain text. The web app falls back to a template
letter if this endpoint is unreachable, so the demo never blocks on it.
"""
from __future__ import annotations

import json

import anthropic
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODEL = "claude-opus-5-5"
MAX_FACTS_BYTES = 20_000

SYSTEM = """You draft short, concrete outreach letters for HeatMatch NYC, a screening tool that pairs \
New York City buildings that reject waste heat with neighbors that burn fuel for heat and hot water.

You get a JSON object of facts about one pair, computed from public data (NYC LL84 benchmarking, the \
cooling-tower registry, PLUTO, NREL load profiles). Write two letters:

1. To the owner of the heat SOURCE: what they gain (lower cooling-tower water and chemical costs, a \
possible heat-sale revenue stream, a local climate story), and what it asks of them (access to \
condenser-water loop, plant-room space).
2. To the owner of the heat SINK: what they gain (fuel savings, LL97 penalty exposure avoided, share \
of their demand covered), the capital cost and payback, and the hour-by-hour fit.

Rules:
- Use only numbers that appear in the facts. Round sensibly. Never invent figures, names or programs.
- If the energy-only savings are negative, say plainly that the case rests on LL97 penalties.
- Say once that these are screening estimates that need an engineering feasibility study.
- Mention the distance and what crossing it involves (party wall, easement, or DOT street permit).
- Each letter: a "TO:" line, a "RE:" line, then 120-180 words, then a single proposed next step.
- Plain text, no markdown headings or bold. Separate the two letters with a line containing only "---".
- Sign each letter "HeatMatch NYC"."""

app = FastAPI(title="HeatMatch proposal API")
client = anthropic.AsyncAnthropic()


@app.get("/api/health")
async def health():
    return {"ok": True, "model": MODEL}


@app.post("/api/proposal")
async def proposal(request: Request):
    body = await request.body()
    if len(body) > MAX_FACTS_BYTES:
        return JSONResponse({"error": "facts payload too large"}, status_code=413)
    try:
        facts = json.loads(body)
    except json.JSONDecodeError:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    manager = client.beta.messages.stream(
        model=MODEL,
        max_tokens=8000,
        output_config={"effort": "low"},  # short letters; keep latency low for a live demo
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        messages=[{"role": "user", "content": "Facts for this pair:\n" + json.dumps(facts, indent=1)}],
    )
    # Open the stream before responding so auth/rate-limit errors become a proper HTTP status
    # (the browser then shows the template letter instead).
    try:
        stream = await manager.__aenter__()
    except anthropic.AuthenticationError:
        return JSONResponse({"error": "no Anthropic credentials configured"}, status_code=503)
    except anthropic.RateLimitError:
        return JSONResponse({"error": "rate limited"}, status_code=429)
    except anthropic.APIStatusError as e:
        return JSONResponse({"error": f"Claude API error {e.status_code}"}, status_code=502)
    except anthropic.APIConnectionError:
        return JSONResponse({"error": "cannot reach Claude API"}, status_code=502)
    except TypeError:  # the SDK raises this when no credential source is configured at all
        return JSONResponse({"error": "no Anthropic credentials configured"}, status_code=503)

    async def gen():
        try:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                yield "\n\n[The model declined to draft this letter.]"
            elif final.stop_reason == "max_tokens":
                yield "\n\n[Draft truncated.]"
        finally:
            await manager.__aexit__(None, None, None)

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")
