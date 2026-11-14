"""One place that talks to Claude, with two ways in:

1. The Claude Code CLI in headless mode (`claude -p`). It runs on whoever is logged in on this
   machine, so a Claude subscription works and no API key is needed. Good for a local demo;
   it counts against that subscription's limits and takes a few seconds per call.
2. The Anthropic API (set ANTHROPIC_API_KEY). Needed for anything other people use.

HEATMATCH_AI=cli|api picks one explicitly; the default tries the CLI first, then the API.
Callers catch AIUnavailable and fall back to their offline behaviour.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
from pathlib import Path

API_MODEL = "claude-opus-5-5"
# CLI model aliases: quick structured answers use the fast model, document reading a stronger one.
CLI_FAST = os.environ.get("HEATMATCH_CLI_FAST", "haiku")
CLI_SMART = os.environ.get("HEATMATCH_CLI_SMART", "sonnet")
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


class AIUnavailable(RuntimeError):
    """No working way to reach Claude (not installed, not logged in, timed out, refused)."""


def backend() -> str | None:
    want = os.environ.get("HEATMATCH_AI", "auto").lower()
    has_cli = shutil.which("claude") is not None
    has_api = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    if want == "cli":
        return "cli" if has_cli else None
    if want == "api":
        return "api" if has_api else None
    return "cli" if has_cli else "api" if has_api else None


# --- Claude Code CLI -----------------------------------------------------------------

def _cli(system: str, user: str, *, schema: dict | None, read_file: Path | None, smart: bool, timeout: int) -> dict | str:
    cmd = [
        "claude", "-p", "--output-format", "json", "--model", CLI_SMART if smart else CLI_FAST,
        "--system-prompt", system, "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ]
    cwd = None
    if read_file is not None:
        # The only tool is Read, allowed only inside the upload's own temp folder. The file is
        # untrusted input: it gets no shell, no web, no edits, and no other part of the disk.
        cwd = str(read_file.parent)
        cmd += ["--tools", "Read", "--allowedTools", f"Read(//{str(read_file.parent).lstrip('/')}/**)"]
    else:
        cmd += ["--tools", ""]
    if schema is not None:
        cmd += ["--json-schema", json.dumps(schema)]
    try:
        run = subprocess.run(cmd, input=user, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired as e:
        raise AIUnavailable("Claude Code timed out") from e
    except OSError as e:
        raise AIUnavailable(f"could not start Claude Code: {e}") from e
    try:
        out = json.loads(run.stdout)
    except json.JSONDecodeError as e:
        raise AIUnavailable((run.stderr or run.stdout or "no output from Claude Code").strip()[:300]) from e
    if out.get("is_error") or out.get("subtype") != "success":
        raise AIUnavailable(str(out.get("result") or out.get("subtype") or "Claude Code error")[:300])
    if schema is None:
        return str(out.get("result", ""))
    data = out.get("structured_output")
    if not isinstance(data, dict):
        try:
            data = json.loads(out.get("result", ""))
        except (json.JSONDecodeError, TypeError) as e:
            raise AIUnavailable("Claude Code returned no structured answer") from e
    return data


# --- Anthropic API -------------------------------------------------------------------

def _api(system: str, user: str, *, schema: dict | None, read_file: Path | None, timeout: int) -> dict | str:
    import anthropic

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
    kwargs = {}
    if schema is not None:
        kwargs["output_config"] = {"effort": "low", "format": {"type": "json_schema", "schema": schema}}
    else:
        kwargs["output_config"] = {"effort": "low"}
    try:
        client = anthropic.Anthropic(timeout=timeout)
        resp = client.messages.create(model=API_MODEL, max_tokens=8000, system=system,
                                      messages=[{"role": "user", "content": content}], **kwargs)
    except anthropic.AuthenticationError as e:
        raise AIUnavailable("the Anthropic API key was rejected") from e
    except anthropic.RateLimitError as e:
        raise AIUnavailable("the Anthropic API is rate limited") from e
    except anthropic.APIStatusError as e:
        raise AIUnavailable(f"Anthropic API error {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        raise AIUnavailable("cannot reach the Anthropic API") from e
    if resp.stop_reason == "refusal":
        raise AIUnavailable("the model declined this request")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    if schema is None:
        return text
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise AIUnavailable("the API returned no structured answer") from e


# --- public -------------------------------------------------------------------------

def ask(system: str, user: str, *, schema: dict | None = None, read_file: Path | None = None,
        smart: bool = False, timeout: int = 90) -> dict | str:
    """Ask Claude. With a schema, returns a dict that matches it; without, returns text.
    read_file: a PDF or image for Claude to read (text files should be pasted into `user`)."""
    which = backend()
    if which == "cli":
        return _cli(system, user, schema=schema, read_file=read_file, smart=smart, timeout=timeout)
    if which == "api":
        return _api(system, user, schema=schema, read_file=read_file, timeout=timeout)
    raise AIUnavailable("no Claude Code login and no ANTHROPIC_API_KEY on this machine")
