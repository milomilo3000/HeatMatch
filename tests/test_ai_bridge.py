import json
import subprocess

import pytest

from api import ai


def fake_run(payload, calls):
    def run(cmd, **kw):
        calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")
    return run


def test_cli_returns_structured_output_and_gets_no_tools(monkeypatch):
    calls = []
    monkeypatch.setenv("HEATMATCH_AI", "cli")
    monkeypatch.setattr(ai.shutil, "which", lambda _: "/usr/bin/claude")
    monkeypatch.setattr(ai.subprocess, "run", fake_run({"subtype": "success", "is_error": False, "structured_output": {"sort": "cheapest"}}, calls))
    out = ai.ask("system", "user", schema={"type": "object"})
    assert out == {"sort": "cheapest"}
    cmd = calls[0][0]
    assert cmd[cmd.index("--tools") + 1] == ""          # plain questions get no tools at all
    assert "--json-schema" in cmd and calls[0][1]["input"] == "user"


def test_cli_file_reading_is_confined_to_the_upload_folder(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setenv("HEATMATCH_AI", "cli")
    monkeypatch.setattr(ai.shutil, "which", lambda _: "/usr/bin/claude")
    monkeypatch.setattr(ai.subprocess, "run", fake_run({"subtype": "success", "is_error": False, "structured_output": {}}, calls))
    f = tmp_path / "bill.pdf"
    f.write_bytes(b"%PDF-")
    ai.ask("system", "user", schema={"type": "object"}, read_file=f)
    cmd, kw = calls[0]
    assert cmd[cmd.index("--tools") + 1] == "Read"
    assert cmd[cmd.index("--allowedTools") + 1] == f"Read(//{str(tmp_path).lstrip('/')}/**)"
    assert kw["cwd"] == str(tmp_path)


def test_errors_become_ai_unavailable(monkeypatch):
    monkeypatch.setenv("HEATMATCH_AI", "cli")
    monkeypatch.setattr(ai.shutil, "which", lambda _: "/usr/bin/claude")
    monkeypatch.setattr(ai.subprocess, "run", fake_run({"subtype": "error_during_execution", "is_error": True, "result": "not logged in"}, []))
    with pytest.raises(ai.AIUnavailable):
        ai.ask("system", "user")

    def timeout(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 1)
    monkeypatch.setattr(ai.subprocess, "run", timeout)
    with pytest.raises(ai.AIUnavailable):
        ai.ask("system", "user")


def test_no_backend_at_all(monkeypatch):
    monkeypatch.setenv("HEATMATCH_AI", "auto")
    monkeypatch.setattr(ai.shutil, "which", lambda _: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    assert ai.backend() is None
    with pytest.raises(ai.AIUnavailable):
        ai.ask("system", "user")
