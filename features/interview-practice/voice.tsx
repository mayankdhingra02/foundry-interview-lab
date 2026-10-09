"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Volume2 } from "lucide-react";
import { toPcmWav } from "./voice-audio";

type VoiceProps = { sessionId: string; configured: boolean; selected: boolean; debrief: boolean; active: boolean; latestQuestion?: { id: string; text: string }; onTranscript: (text: string, source: "transcribed" | "corrected") => void };
export function VoiceControls(props: VoiceProps) {
  const { configured, selected, debrief, active } = props;
  const unavailable = !configured ? "Voice not configured · Continue in text" : !selected ? "Text selected for this attempt · Voice is off" : !debrief ? "Voice is available during the debrief. Finish coding to use it; continue in text." : !active ? "Voice is available during an active debrief. Continue in text." : null;
  if (unavailable) return <div className="voice-off"><Mic size={14} aria-hidden="true" /><span>{unavailable}</span></div>;
  // Unmounting the active controls releases capture and playback whenever the
  // saved opt-in, provider capability, stage, lifecycle, or role tab changes.
  return <ActiveVoiceControls {...props} />;
}
function ActiveVoiceControls({ sessionId, active, latestQuestion, onTranscript }: VoiceProps) {
  const [consent, setConsent] = useState(false); const [recording, setRecording] = useState(false); const [busy, setBusy] = useState(false); const [waitingForMic, setWaitingForMic] = useState(false); const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0); const [original, setOriginal] = useState(""); const [draft, setDraft] = useState(""); const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null); const streamRef = useRef<MediaStream | null>(null); const audioRef = useRef<HTMLAudioElement | null>(null); const abortRef = useRef<AbortController | null>(null); const audioUrlRef = useRef(""); const timerRef = useRef<ReturnType<typeof setInterval> | null>(null); const aliveRef = useRef(true); const captureGeneration = useRef(0);
  function releaseMic() { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; }
  function stopPlayback() { abortRef.current?.abort(); audioRef.current?.pause(); audioRef.current = null; if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = ""; setPlaying(false); }
  function cancelCapture() {
    // getUserMedia has no AbortSignal. Invalidate its continuation before a
    // late permission result can start recording or replace newer capture.
    captureGeneration.current += 1;
    if (recorderRef.current) { recorderRef.current.onstop = null; if (recorderRef.current.state === "recording") recorderRef.current.stop(); recorderRef.current = null; }
    releaseMic(); abortRef.current?.abort(); setRecording(false); setBusy(false); setWaitingForMic(false);
  }
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; captureGeneration.current += 1; if (recorderRef.current) { recorderRef.current.onstop = null; if (recorderRef.current.state === "recording") recorderRef.current.stop(); } releaseMic(); abortRef.current?.abort(); audioRef.current?.pause(); if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); }; }, []);
  async function record() {
    if (!consent || !active || busy) return;
    setError(""); stopPlayback();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined" || typeof OfflineAudioContext === "undefined") { setError("This browser cannot prepare microphone audio. Continue with text."); return; }
    const generation = ++captureGeneration.current;
    const current = () => aliveRef.current && generation === captureGeneration.current;
    setBusy(true); setWaitingForMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      setWaitingForMic(false);
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 64_000 }); recorderRef.current = recorder; const chunks: BlobPart[] = []; let size = 0; let tooLarge = false;
      recorder.ondataavailable = (event) => { size += event.data.size; if (size > 8_000_000) { tooLarge = true; if (recorder.state === "recording") recorder.stop(); } else if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        if (!current()) return; releaseMic(); setRecording(false); setBusy(true);
        const controller = new AbortController(); abortRef.current = controller;
        try {
          if (tooLarge) throw new Error("This recording exceeded the supported size. Continue in text or record a shorter answer.");
          const wav = await toPcmWav(new Blob(chunks, { type: recorder.mimeType })); chunks.length = 0;
          if (!current() || controller.signal.aborted) return;
          const form = new FormData(); form.append("audio", wav, "answer.wav"); form.append("consent", "true"); form.append("requestId", crypto.randomUUID());
          const response = await fetch(`/api/interview-practice/sessions/${sessionId}/voice/transcribe`, { method: "POST", body: form, signal: controller.signal }); const result = await response.json();
          if (!response.ok) throw new Error(result.error?.message || "Transcription is unavailable. Continue with text.");
          if (current() && !controller.signal.aborted) { setOriginal(result.text); setDraft(result.text); }
        } catch (e) { if (current() && (e as Error).name !== "AbortError") setError((e as Error).message); } finally { chunks.length = 0; if (current()) setBusy(false); }
      };
      const started = Date.now(); recorder.start(250); setSeconds(0); setRecording(true); setBusy(false);
      timerRef.current = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(Math.min(60, elapsed)); if (elapsed >= 60 && recorder.state === "recording") recorder.stop(); }, 250);
    } catch { if (current()) { releaseMic(); setBusy(false); setWaitingForMic(false); setError("Microphone access was unavailable. Check your browser permission or continue with text."); } }
  }
  async function speak() {
    if (!latestQuestion || !consent || !active) return; setError(""); stopPlayback(); setPlaying(true); const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch(`/api/interview-practice/sessions/${sessionId}/voice/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: latestQuestion.id, requestId: crypto.randomUUID(), consent: true }), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message || "Audio playback is unavailable. Read the question above."); }
      const blob = await response.blob(); if (!aliveRef.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob); audioUrlRef.current = url; const audio = new Audio(url); audioRef.current = audio; audio.onended = () => { if (audioRef.current === audio) stopPlayback(); }; audio.onerror = () => { if (audioRef.current === audio) { setError("Question audio could not play. Read the visible question."); stopPlayback(); } }; await audio.play();
    } catch (e) { if (aliveRef.current && (e as Error).name !== "AbortError") setError((e as Error).message); if (aliveRef.current && abortRef.current === controller) stopPlayback(); }
  }
  return <div className="voice-controls"><label className="voice-consent"><input type="checkbox" checked={consent} disabled={recording || busy || playing} onChange={(event) => setConsent(event.target.checked)} /><span>Allow sending recordings and selected interviewer questions to Deepgram for speech processing.</span></label><div className="voice-toolbar"><button className={`button small ${recording ? "recording" : ""}`} disabled={!consent || busy || playing} onClick={() => recording ? recorderRef.current?.stop() : record()}>{recording ? <Square size={14} /> : <Mic size={14} />}{recording ? "Stop recording" : waitingForMic ? "Waiting for microphone…" : busy ? "Transcribing…" : "Record answer"}</button><button className="icon-button" onClick={() => playing ? stopPlayback() : speak()} disabled={!consent || !latestQuestion || recording || busy} aria-label={playing ? "Stop question audio" : "Play latest question"}>{playing ? <Square size={16} /> : <Volume2 size={16} />}</button>{busy && <button className="text-button" onClick={cancelCapture}>{waitingForMic ? "Cancel microphone request" : "Cancel transcription"}</button>}</div>{recording && <p role="status">Recording · {seconds}s of 60s. Stop when you finish.</p>}{draft && <div className="transcript-review"><label htmlFor="voice-transcript">Review your transcript</label><textarea id="voice-transcript" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} /><div><button className="button small" disabled={!draft.trim()} onClick={() => { onTranscript(draft, draft === original ? "transcribed" : "corrected"); setDraft(""); setOriginal(""); }}>Use transcript</button><button className="text-button" onClick={() => { setDraft(""); setOriginal(""); }}>Discard</button></div><p className="muted">Review first, then send from the message box. Recordings are processed in memory and are not saved by Interview Lab.</p></div>}{error && <p className="error-text" role="alert">{error}</p>}</div>;
}
