import json

import httpx
import pytest

from api import ai


def mock_claude(monkeypatch, handler):
    client_factory = ai.anthropic.Anthropic
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(ai.anthropic, "Anthropic", lambda **options: client_factory(
        **options, http_client=httpx.Client(transport=httpx.MockTransport(handler))
    ))


def test_structured_request_uses_claude_with_attachment(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_test")
    schema = {"type": "object", "additionalProperties": False}

    def handler(request):
        assert request.url.path == "/v1/messages"
        assert request.headers["x-api-key"] == "test-key"
        assert request.headers["anthropic-workspace-id"] == "wrkspc_test"
        payload = json.loads(request.content)
        assert payload["model"] == "claude-sonnet-4-6"
        assert payload["output_config"]["format"]["schema"] == schema
        attachment, prompt = payload["messages"][0]["content"]
        assert attachment["source"]["data"] == "JVBERi0="
        assert prompt == {"type": "text", "text": "user"}
        return httpx.Response(200, json={
            "content": [{"type": "text", "text": "{}"}],
            "stop_reason": "end_turn",
        })

    mock_claude(monkeypatch, handler)
    bill = tmp_path / "bill.pdf"
    bill.write_bytes(b"%PDF-")
    assert ai.backend() == "api"
    assert ai.ask("system", "user", schema=schema, read_file=bill) == {}


def test_rejected_key_becomes_ai_unavailable(monkeypatch):
    mock_claude(monkeypatch, lambda _: httpx.Response(401, json={"error": "rejected"}))
    with pytest.raises(ai.AIUnavailable, match="key was rejected"):
        ai.ask("system", "user", schema={"type": "object"})


def test_no_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ai.backend() is None
    with pytest.raises(ai.AIUnavailable, match="ANTHROPIC_API_KEY"):
        ai.ask("system", "user", schema={"type": "object"})
