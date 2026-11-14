import React, { useEffect, useRef, useState } from "react";

const SR = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const EXAMPLES = [
  "I run the data center at 111 Eighth Avenue. Find hotels within a block.",
  "Which data centers could heat Fulton Houses?",
  "Only ones that don't cross a street, cheapest first.",
];

// "Ask HeatMatch": speak or type what you're looking for. The parent turns the request into a
// search (onAsk) and passes back the conversation so far (log) and whether it is thinking (busy).
export default function AssistantPanel({ log, busy, onAsk, onClose, muted, setMuted }) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState("");
  const rec = useRef(null);
  const end = useRef(null);

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [log, busy]);
  useEffect(() => () => { rec.current?.abort(); window.speechSynthesis?.cancel(); }, []);

  function send(t) {
    const q = (t ?? text).trim();
    if (!q || busy) return;
    setText("");
    onAsk(q);
  }

  function toggleMic() {
    if (listening) return rec.current?.stop();
    window.speechSynthesis?.cancel();
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    r.onresult = (ev) => {
      let shown = "";
      for (const res of ev.results) { shown += res[0].transcript; if (res.isFinal) finalText += res[0].transcript; }
      setText(shown);
    };
    r.onerror = (ev) => {
      setMicError(ev.error === "not-allowed" ? "Microphone access was blocked. Allow it in the browser, or type instead."
        : ev.error === "no-speech" ? "I didn't hear anything. Try again, or type instead." : `Microphone error: ${ev.error}`);
    };
    r.onend = () => { setListening(false); if (finalText.trim()) send(finalText); };
    setMicError("");
    rec.current = r;
    try { r.start(); setListening(true); } catch { setMicError("Couldn't start the microphone."); }
  }

  return (
    <div className="assistant" role="dialog" aria-label="Ask HeatMatch">
      <div className="as-head">
        <b>Ask HeatMatch</b>
        <span className="muted">Say what you're looking for</span>
        <span style={{ flex: 1 }} />
        <button className="as-icon" onClick={() => { setMuted(!muted); window.speechSynthesis?.cancel(); }} title={muted ? "Read answers aloud" : "Stop reading answers aloud"}>
          {muted ? "🔇" : "🔊"}
        </button>
        <button className="as-icon" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="as-log">
        {!log.length && (
          <div className="as-examples">
            {EXAMPLES.map((ex) => <button key={ex} onClick={() => send(ex)}>{ex}</button>)}
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={`as-msg ${m.who}`}>
            {m.text}
            {m.chips?.length > 0 && <div className="as-chips">{m.chips.map((c) => <span key={c}>{c}</span>)}</div>}
            {m.offline && <div className="as-note">Answered without AI (simple keyword matching).</div>}
          </div>
        ))}
        {busy && <div className="as-msg bot thinking">Thinking…</div>}
        <div ref={end} />
      </div>

      {micError && <div className="as-note" style={{ padding: "0 14px 6px" }}>{micError}</div>}
      <form className="as-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {SR && (
          <button type="button" className={`mic ${listening ? "on" : ""}`} onClick={toggleMic} aria-label={listening ? "Stop listening" : "Speak"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : SR ? "Speak or type a request" : "Type a request (voice needs Chrome, Edge or Safari)"} />
        <button type="submit" className="send" disabled={busy || !text.trim()}>Ask</button>
      </form>
    </div>
  );
}
