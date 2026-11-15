import React, { useCallback, useEffect, useRef, useState } from "react";

const CAN_RECORD = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;
const MAX_RECORDING_MS = 15_000;
const EXAMPLES = [
  "I run the data center at 111 Eighth Avenue. Find hotels within a block.",
  "Which data centers could heat Fulton Houses?",
  "Only ones that don't cross a street, cheapest first.",
];

function releaseMicrophone(session) {
  clearTimeout(session.timer);
  if (session.recorder) {
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    if (session.recorder.state !== "inactive") session.recorder.stop();
  }
  session.stream?.getTracks().forEach((track) => track.stop());
}

// The parent handles searches and supplies the conversation so far.
export default function AssistantPanel({ log, busy, onAsk, onClose, muted, setMuted }) {
  const [text, setText] = useState("");
  const [micState, setMicState] = useState("idle");
  const [micError, setMicError] = useState("");
  const [speechError, setSpeechError] = useState("");
  const [speechUrl, setSpeechUrl] = useState(null);
  const recording = useRef(null);
  const end = useRef(null);
  const lastMessage = useRef(log.at(-1));
  const cancelSpeech = useRef(null);
  const audio = useRef(null);
  const attachAudio = useCallback((element) => {
    if (!element) audio.current?.pause();
    audio.current = element;
  }, []);

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [log, busy]);
  useEffect(() => () => {
    const session = recording.current;
    if (session) {
      session.controller.abort();
      releaseMicrophone(session);
    }
  }, []);

  useEffect(() => {
    const reply = log.at(-1);
    const isNew = reply !== lastMessage.current;
    lastMessage.current = reply;
    setSpeechUrl(null);
    setSpeechError("");
    if (!isNew || muted || reply?.who !== "bot") return;

    const controller = new AbortController();
    let url;
    const stop = () => {
      controller.abort();
      audio.current?.pause();
      if (url) URL.revokeObjectURL(url);
    };
    cancelSpeech.current = stop;

    async function loadSpeech() {
      try {
        const response = await fetch("/api/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: reply.text }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(response.status === 401 ? "Use Demo login to unlock spoken replies."
            : payload?.error || "Voice playback is unavailable.");
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.size || blob.type !== "audio/mpeg") {
          throw new Error("Voice playback is unavailable. The server returned no MP3 audio.");
        }
        url = URL.createObjectURL(blob);
        setSpeechUrl(url);
      } catch (error) {
        if (!controller.signal.aborted) setSpeechError(error.message);
      }
    }
    loadSpeech();
    return () => {
      stop();
      cancelSpeech.current = null;
    };
  }, [log, muted]);

  function send(t) {
    const q = (t ?? text).trim();
    if (!q || busy || micState !== "idle") return;
    setText("");
    onAsk(q);
  }

  async function toggleMic() {
    if (recording.current?.recorder?.state === "recording") {
      recording.current.recorder.stop();
      return;
    }
    if (recording.current || busy) return;
    cancelSpeech.current?.();
    setSpeechUrl(null);
    setSpeechError("");
    setMicError("");
    setMicState("opening");
    const session = { controller: new AbortController() };
    recording.current = session;
    const { signal } = session.controller;
    const chunks = [];
    function resetMic() {
      releaseMicrophone(session);
      if (recording.current === session) recording.current = null;
      if (!signal.aborted) setMicState("idle");
    }

    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (signal.aborted) {
        resetMic();
        return;
      }
      const recorder = new MediaRecorder(session.stream);
      session.recorder = recorder;
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onerror = () => {
        if (!signal.aborted) setMicError("The microphone stopped recording. Try again or type your question.");
        resetMic();
      };
      recorder.onstop = async () => {
        releaseMicrophone(session);
        setMicState("transcribing");
        try {
          const clip = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
          if (!clip.size) throw new Error("No microphone audio was captured. Try recording again.");
          const response = await fetch("/api/transcribe", { method: "POST", body: clip, signal });
          const result = await response.json().catch(() => null);
          if (signal.aborted) return;
          if (!response.ok || typeof result?.text !== "string") {
            throw new Error(response.status === 401 ? "Use Demo login to unlock microphone transcription on this site."
              : result?.error || "Can't reach speech recognition. Check that HeatMatch is running.");
          }
          if (result.text.trim()) setText(result.text);
          else setMicError("I didn't hear any speech. Check your input volume and try again.");
        } catch (error) {
          if (!signal.aborted) setMicError(error.message);
        } finally {
          resetMic();
        }
      };
      recorder.start();
      setMicState("recording");
      session.timer = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_MS);
    } catch (error) {
      if (!signal.aborted) {
        const message = error.name === "NotAllowedError" ? "Allow microphone access for this page and try again."
          : error.name === "NotFoundError" ? "No microphone was found. Connect one or type your question."
          : "Couldn't open the microphone. Check that your input device is available.";
        setMicError(message);
      }
      resetMic();
    }
  }

  const listening = micState === "recording";
  const micStatus = { opening: "Waiting for microphone permission…", recording: "Recording. Click the microphone again to stop.",
    transcribing: "Turning your recording into text…" }[micState];

  return (
    <div className="assistant" role="dialog" aria-label="Ask HeatMatch">
      <div className="as-head">
        <b>Ask HeatMatch</b>
        <span className="muted">Say what you're looking for</span>
        <span style={{ flex: 1 }} />
        <button className="as-icon" onClick={() => setMuted(!muted)} aria-label={muted ? "Read answers aloud" : "Mute spoken answers"}>
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

      {(micError || micStatus) && <div className="as-note as-speech-error" role="status">{micError || micStatus}</div>}
      {speechError && <div className="as-note as-speech-error" role="status">{speechError}</div>}
      {speechUrl && <audio className="as-audio" ref={attachAudio} src={speechUrl} controls autoPlay aria-label="Play the latest HeatMatch reply" />}
      <form className="as-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {CAN_RECORD && (
          <button type="button" className={`mic ${listening ? "on" : ""}`} onClick={toggleMic}
            disabled={!listening && (busy || micState !== "idle")} aria-label={listening ? "Stop recording" : "Record a question"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={CAN_RECORD ? "Record or type a request" : "Type a request"} />
        <button type="submit" className="send" disabled={busy || micState !== "idle" || !text.trim()}>Ask</button>
      </form>
    </div>
  );
}
