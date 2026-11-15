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


class LoginRequest(BaseModel):
    password: Annotated[str, StringConstraints(min_length=1, max_length=256)]


def demo_password() -> bytes:
    return os.environ.get("HEATMATCH_DEMO_PASSWORD", "").encode("utf-8")


def sign(password: bytes, session: str) -> str:
    return hmac.new(password, b"HeatMatch demo session:" + session.encode("ascii"), hashlib.sha256).hexdigest()


def logged_in(request: Request, password: bytes) -> bool:
    token = request.cookies.get(COOKIE, "")
    if not password or not token.isascii() or len(token) > 128:
        return False
    expires, marker, nonce_and_signature = token.partition(".")
    nonce, separator, signature = nonce_and_signature.partition(".")
    if not marker or not separator or not nonce or not expires.isdecimal():
        return False
    now = int(time.time())
    return now < int(expires) <= now + SESSION_SECONDS and hmac.compare_digest(
        signature, sign(password, f"{expires}.{nonce}")
    )


async def require_demo_login(request: Request) -> None:
    if not logged_in(request, demo_password()):
        raise HTTPException(status_code=401, detail="Sign in to use HeatMatch AI.", headers={"Cache-Control": "no-store"})
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
        raise HTTPException(status_code=403, detail="Open HeatMatch directly to use AI.", headers={"Cache-Control": "no-store"})


def session_response(authenticated: bool, configured: bool) -> JSONResponse:
    return JSONResponse({"authenticated": authenticated, "configured": configured},
                        headers={"Cache-Control": "no-store"})


@router.get("/session")
async def session(request: Request) -> JSONResponse:
    password = demo_password()
    return session_response(logged_in(request, password), bool(password))


@router.post("/login")
async def login(body: LoginRequest, request: Request) -> JSONResponse:
    password = demo_password()
    if not password:
        raise HTTPException(status_code=503, detail="Demo login is unavailable on this site.")
    if not hmac.compare_digest(body.password.encode("utf-8"), password):
        raise HTTPException(status_code=401, detail="Incorrect demo password.")

    token = f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_urlsafe(18)}"
    response = session_response(True, True)
    response.set_cookie(COOKIE, f"{token}.{sign(password, token)}", max_age=SESSION_SECONDS, httponly=True,
                        samesite="strict", secure=request.url.scheme == "https")
    return response


@router.post("/logout")
async def logout() -> JSONResponse:
    response = session_response(False, bool(demo_password()))
    response.delete_cookie(COOKIE, httponly=True, samesite="strict")
    return response
