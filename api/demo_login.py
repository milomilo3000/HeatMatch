"""Shared-password sign-in for HeatMatch's demo AI features."""
import hashlib
import hmac
import os
import secrets
import time
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

router = APIRouter(prefix="/api/demo")
COOKIE = "heatmatch_demo"
SESSION_SECONDS = 8 * 60 * 60
PUBLIC_ORIGINS = ("https://heatmatch.us", "https://www.heatmatch.us")
PUBLIC_API_HOST = "heatmatch-i54j.onrender.com"


class LoginRequest(BaseModel):
    password: Annotated[str, StringConstraints(min_length=1, max_length=256)]


def demo_password() -> bytes:
    return os.environ.get("HEATMATCH_DEMO_PASSWORD", "").encode("utf-8")


def public_frontend(request: Request) -> bool:
    return request.url.hostname == PUBLIC_API_HOST and request.headers.get("origin") in PUBLIC_ORIGINS


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.url.netloc}" and not public_frontend(request):
        raise HTTPException(status_code=403, detail="Open HeatMatch directly to use AI.", headers={"Cache-Control": "no-store"})


def sign(password: bytes, session: str, public: bool) -> str:
    purpose = b"HeatMatch public frontend:" if public else b"HeatMatch demo session:"
    return hmac.new(password, purpose + session.encode("ascii"), hashlib.sha256).hexdigest()


def logged_in(request: Request, password: bytes) -> bool:
    public = public_frontend(request)
    if public:
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer":
            return False
    else:
        token = request.cookies.get(COOKIE, "")
    if not password or not token.isascii() or len(token) > 128:
        return False
    expires, marker, nonce_and_signature = token.partition(".")
    nonce, separator, signature = nonce_and_signature.partition(".")
    if not marker or not separator or not nonce or not expires.isdecimal():
        return False
    now = int(time.time())
    return now < int(expires) <= now + SESSION_SECONDS and hmac.compare_digest(
        signature, sign(password, f"{expires}.{nonce}", public)
    )


async def require_demo_login(request: Request) -> None:
    if not logged_in(request, demo_password()):
        raise HTTPException(status_code=401, detail="Sign in to use HeatMatch AI.", headers={"Cache-Control": "no-store"})
    check_origin(request)


def session_response(authenticated: bool, configured: bool, token: str | None = None) -> JSONResponse:
    body = {"authenticated": authenticated, "configured": configured}
    if token:
        body["token"] = token
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/session")
async def session(request: Request) -> JSONResponse:
    password = demo_password()
    return session_response(logged_in(request, password), bool(password))


@router.post("/login")
async def login(body: LoginRequest, request: Request) -> JSONResponse:
    check_origin(request)
    password = demo_password()
    if not password:
        raise HTTPException(status_code=503, detail="Demo login is unavailable on this site.")
    if not hmac.compare_digest(body.password.encode("utf-8"), password):
        raise HTTPException(status_code=401, detail="Incorrect demo password.")

    public = public_frontend(request)
    session_id = f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_urlsafe(18)}"
    token = f"{session_id}.{sign(password, session_id, public)}"
    if public:
        return session_response(True, True, token)
    response = session_response(True, True)
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                        samesite="strict", secure=request.url.scheme == "https")
    return response


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    check_origin(request)
    response = session_response(False, bool(demo_password()))
    response.delete_cookie(COOKIE, httponly=True, samesite="strict")
    return response
