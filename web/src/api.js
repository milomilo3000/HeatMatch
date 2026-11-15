const PUBLIC_HOSTS = ["heatmatch.us", "www.heatmatch.us"];
const remote = typeof window !== "undefined" && PUBLIC_HOSTS.includes(window.location.hostname);
const API_ORIGIN = "https://heatmatch-i54j.onrender.com";
const SESSION_KEY = "heatmatch-demo-token";
let session;

export function setDemoToken(token) {
  if (!remote) return;
  session = token || "";
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, session);
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // In restricted browsers the session still works until the page is refreshed.
  }
}

export function apiFetch(path, options = {}) {
  if (!remote) return fetch(path, options);

  if (session === undefined) {
    try { session = window.sessionStorage.getItem(SESSION_KEY) || ""; }
    catch { session = ""; }
  }
  const headers = new Headers(options.headers);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  return fetch(API_ORIGIN + path, { ...options, headers, credentials: "omit" });
}
