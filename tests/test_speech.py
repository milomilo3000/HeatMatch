import json

import httpx
import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.speech import DEFAULT_VOICE


@pytest.fixture
def signed_in(monkeypatch):
    monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-speech-password")
    with TestClient(app) as client:
        assert client.post("/api/demo/login", json={"password": "test-speech-password"}).status_code == 200
        yield client


def test_speech_returns_elevenlabs_mp3(monkeypatch, signed_in):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "voice-test-key")
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    client_factory = httpx.AsyncClient

    def handle(request):
        assert request.url.host == "api.elevenlabs.io"
        assert request.url.path == f"/v1/text-to-speech/{DEFAULT_VOICE}"
        assert request.url.params["output_format"] == "mp3_44100_128"
        assert request.headers["xi-api-key"] == "voice-test-key"
        assert json.loads(request.content) == {"text": "A heat match.", "model_id": "eleven_flash_v2_5"}
        return httpx.Response(200, content=b"mock MP3", headers={"content-type": "audio/mpeg"})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **options: client_factory(
        **options, transport=httpx.MockTransport(handle)
    ))
    response = signed_in.post("/api/speech", json={"text": " A heat match. "})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == b"mock MP3"


def test_speech_validates_text_and_handles_missing_key(monkeypatch, signed_in):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert signed_in.post("/api/speech", json={"text": "A reply."}).status_code == 503
    assert signed_in.post("/api/speech", json={"text": " "}).status_code == 422
    assert signed_in.post("/api/speech", json={"text": "a" * 1001}).status_code == 422
