import React, { useEffect, useRef, useState } from "react";
import { apiFetch, setDemoToken } from "./api.js";

const UNAVAILABLE = { authenticated: false, configured: false };

export default function DemoLogin() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef(null);
  const field = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/demo/session", { signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() : UNAVAILABLE)
      .then(setSession)
      .catch(() => { if (!controller.signal.aborted) setSession(UNAVAILABLE); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (open && session?.configured && !session.authenticated) field.current?.focus();
  }, [open, session]);

  function close() {
    setOpen(false);
    setPassword("");
    setError("");
    trigger.current?.focus();
  }

  async function submit(event) {
    event.preventDefault();
    const action = session?.authenticated ? "logout" : "login";
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/demo/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "login" ? { password } : {}),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.authenticated !== "boolean") {
        throw new Error(typeof result?.detail === "string" ? result.detail : "Demo sign-in is unavailable.");
      }
      setDemoToken(result.token);
      setSession(result);
      close();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button ref={trigger} type="button" className="demo-trigger" aria-expanded={open}
        onClick={() => open ? close() : setOpen(true)}>
        {session?.authenticated ? "AI unlocked" : "Demo login"}
      </button>
      {open && (
        <form className="demo-panel" role="dialog" aria-label="Demo AI access" onSubmit={submit}
          onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
          <div className="demo-panel-heading">
            <strong>Demo AI access</strong>
            <button type="button" className="as-icon" aria-label="Close demo login" onClick={close}>×</button>
          </div>
          {!session && <p role="status">Checking demo access…</p>}
          {session && !session.configured && <p>Demo sign-in is unavailable on this site.</p>}
          {session?.authenticated && <p>Claude and spoken replies are unlocked in this browser.</p>}
          {session?.configured && !session.authenticated && (
            <label>Demo password
              <input ref={field} type="password" autoComplete="current-password" required maxLength={256}
                value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
          )}
          {error && <p role="alert" className="demo-error">{error}</p>}
          {session?.configured && (
            <button type="submit" className="demo-submit" disabled={busy || (!session.authenticated && !password)}>
              {session.authenticated ? "Sign out" : "Sign in"}
            </button>
          )}
        </form>
      )}
    </>
  );
}
