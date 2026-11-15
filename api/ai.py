"""Shared Claude Messages API configuration and structured responses."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import anthropic

DEFAULT_MODEL = "claude-opus-5-5"
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


class AIUnavailable(RuntimeError):
    """Claude is unconfigured or could not produce an answer."""


def backend() -> str | None:
    return "api" if os.environ.get("ANTHROPIC_API_KEY", "").strip() else None


def model() -> str:
    return os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_MODEL


def client_options(timeout: int) -> dict:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise AIUnavailable("no ANTHROPIC_API_KEY configured")
    workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID", "").strip()
    headers = {"anthropic-workspace-id": workspace} if workspace else {}
    return {"api_key": key, "timeout": timeout, "max_retries": 0, "default_headers": headers}


def ask(system: str, user: str, *, schema: dict, read_file: Path | None = None, timeout: int = 90) -> dict:
    """Request structured JSON, optionally including a PDF or image attachment."""
    options = client_options(timeout)
    content: list[dict] = []
    if read_file is not None:
        ext = read_file.suffix.lower()
        data = base64.standard_b64encode(read_file.read_bytes()).decode()
        if ext == ".pdf":
            content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}})
        elif ext in IMAGE_TYPES:
            content.append({"type": "image", "source": {"type": "base64", "media_type": IMAGE_TYPES[ext], "data": data}})
        else:
            raise AIUnavailable(f"cannot send a {ext or 'file'} to the API")
    content.append({"type": "text", "text": user})
    try:
        with anthropic.Anthropic(**options) as client:
            response = client.messages.create(
                model=model(),
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            )
    except anthropic.AuthenticationError as e:
        raise AIUnavailable("the Anthropic API key was rejected") from e
    except anthropic.RateLimitError as e:
        raise AIUnavailable("the Anthropic API is rate limited") from e
    except anthropic.APIStatusError as e:
        raise AIUnavailable(f"Anthropic API error {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        raise AIUnavailable("cannot reach the Anthropic API") from e

    if response.stop_reason in ("refusal", "max_tokens"):
        raise AIUnavailable("Claude did not complete the requested answer")
    text = "".join(block.text for block in response.content if block.type == "text")
    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        raise AIUnavailable("the API returned no structured answer") from e
    if not isinstance(result, dict):
        raise AIUnavailable("the API returned no structured answer")
    return result
