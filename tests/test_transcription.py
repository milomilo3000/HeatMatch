from fastapi.testclient import TestClient

from api import transcription
from api.main import app


def test_microphone_audio_is_transcribed(monkeypatch):
    def transcribe_audio(recording):
        assert recording.read() == b"browser audio"
        return "Find data centers near Fulton Houses."

    monkeypatch.setattr(transcription, "transcribe_audio", transcribe_audio)
    with TestClient(app) as client:
        response = client.post("/api/transcribe", content=b"browser audio",
                               headers={"Content-Type": "audio/webm;codecs=opus"})
    assert response.status_code == 200
    assert response.json() == {"text": "Find data centers near Fulton Houses."}


def test_transcription_rejects_unsupported_empty_or_large_uploads(monkeypatch):
    monkeypatch.setattr(transcription, "MAX_BYTES", 16)
    with TestClient(app) as client:
        assert client.post("/api/transcribe", content=b"abc").status_code == 415
        audio = {"Content-Type": "audio/webm"}
        assert client.post("/api/transcribe", content=b"", headers=audio).status_code == 400
        assert client.post("/api/transcribe", content=b"x" * 17, headers=audio).status_code == 413
