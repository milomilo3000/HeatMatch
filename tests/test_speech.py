import json
from io import BytesIO
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from api import speech
from api.main import app


@pytest.fixture
def signed_in(monkeypatch):
    monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-speech-password")
    with TestClient(app) as client:
        assert client.post("/api/demo/login", json={"password": "test-speech-password"}).status_code == 200
        yield client


def test_speech_returns_elevenlabs_mp3(monkeypatch, signed_in):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "voice-test-key")
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)

    class AudioResponse(BytesIO):
        status = 200

        def getheader(self, name, default=None):
            return "audio/mpeg" if name == "Content-Type" else default

    class MockConnection:
        def __init__(self, host, timeout):
            assert host == "api.elevenlabs.io"
            assert timeout == 15

        def request(self, method, target, body, headers):
            path = urlsplit(target)
            assert method == "POST"
            assert path.path == f"/v1/text-to-speech/{speech.DEFAULT_VOICE}"
            assert parse_qs(path.query) == {"output_format": ["mp3_44100_128"]}
            assert headers["xi-api-key"] == "voice-test-key"
            assert json.loads(body) == {"text": "A heat match.", "model_id": "eleven_flash_v2_5"}

        def getresponse(self):
            return AudioResponse(b"mock MP3")

        def close(self):
            pass

    monkeypatch.setattr(speech, "HTTPSConnection", MockConnection)
    response = signed_in.post("/api/speech", json={"text": " A heat match. "})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == b"mock MP3"


def test_speech_validates_text_and_handles_missing_key(monkeypatch, signed_in):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert signed_in.post("/api/speech", json={"text": "A reply."}).status_code == 503
    assert signed_in.post("/api/speech", json={"text": " "}).status_code == 422
    assert signed_in.post("/api/speech", json={"text": "a" * 1001}).status_code == 422
