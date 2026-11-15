import pytest
from fastapi.testclient import TestClient

from api import demo_login
from api.main import app


@pytest.mark.parametrize("path,payload", [
    ("/api/assistant", {"text": "Find a match."}),
    ("/api/proposal", {"annual": {}}),
    ("/api/extract-usage", {"text": "Example bill."}),
    ("/api/speech", {"text": "A heat match."}),
])
def test_provider_routes_require_login(monkeypatch, path, payload):
    monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-demo-password")
    with TestClient(app) as client:
        response = client.post(path, json=payload)
    assert response.status_code == 401


def test_demo_login_sets_secure_cookie_and_logout_clears_it(monkeypatch):
    monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-demo-password")
    with TestClient(app, base_url="https://demo.test") as client:
        assert client.get("/api/demo/session").json() == {"authenticated": False, "configured": True}
        assert client.post("/api/demo/login", json={"password": "wrong"}).status_code == 401
        login = client.post("/api/demo/login", json={"password": "test-demo-password"})
        cookie = login.headers["set-cookie"].lower()
        assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
        assert client.get("/api/demo/session").json()["authenticated"]
        assert client.post("/api/speech", json={"text": "A reply."},
                           headers={"Origin": "https://other.demo.test"}).status_code == 403
        client.post("/api/demo/logout").raise_for_status()
        assert not client.get("/api/demo/session").json()["authenticated"]


def test_session_expires_and_password_rotation_invalidates_cookies(monkeypatch):
    monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-demo-password")
    monkeypatch.setattr(demo_login.time, "time", lambda: 10_000)
    with TestClient(app) as client:
        client.post("/api/demo/login", json={"password": "test-demo-password"}).raise_for_status()
        assert client.get("/api/demo/session").json()["authenticated"]

        monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "changed-demo-password")
        assert not client.get("/api/demo/session").json()["authenticated"]

        monkeypatch.setenv("HEATMATCH_DEMO_PASSWORD", "test-demo-password")
        monkeypatch.setattr(demo_login.time, "time", lambda: 10_000 + demo_login.SESSION_SECONDS)
        assert not client.get("/api/demo/session").json()["authenticated"]


def test_no_demo_password_keeps_provider_routes_locked(monkeypatch):
    monkeypatch.delenv("HEATMATCH_DEMO_PASSWORD", raising=False)
    with TestClient(app) as client:
        assert client.post("/api/demo/login", json={"password": "demo"}).status_code == 503
        assert client.post("/api/assistant", json={"text": "Find a match."}).status_code == 401
