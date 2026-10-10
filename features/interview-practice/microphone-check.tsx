"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import "./microphone-check.css";

export function MicrophoneCheck({ onReady, onText }: { onReady: (ready: boolean) => void; onText: () => void }) {
  const [phase, setPhase] = useState<"idle" | "checking" | "ready" | "error">("idle");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const alive = useRef(true); const generation = useRef(0);
  const streamRef = useRef<MediaStream | null>(null); const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null); const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function release() {
    if (intervalRef.current) clearInterval(intervalRef.current); intervalRef.current = null;
    if (timeoutRef.current) clearTimeout(timeoutRef.current); timeoutRef.current = null;
    sourceRef.current?.disconnect(); sourceRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    void contextRef.current?.close().catch(() => {}); contextRef.current = null;
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; release(); }; }, []);

  function stop() {
    generation.current++; release(); setPhase("idle"); setLevel(0); onReady(false);
    setMessage("Microphone check stopped. Continue in text or explicitly check again.");
  }
  async function check() {
    if (phase === "checking") return;
    const token = ++generation.current; onReady(false); setPhase("checking"); setMessage(""); setLevel(0);
    const current = () => alive.current && generation.current === token;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined" || typeof OfflineAudioContext === "undefined") throw new Error("This browser cannot prepare microphone audio. Continue in text.");
      timeoutRef.current = setTimeout(() => { if (!current()) return; generation.current++; release(); setPhase("error"); setMessage("Microphone permission or input did not become available. Continue in text or explicitly try again."); }, 15_000);
      const context = new AudioContext(); contextRef.current = context; const resumed = context.resume().then(() => true, () => false);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream; const running = await resumed; if (!current()) return;
      if (!running) throw new Error("Microphone input could not start. Continue in text.");
      const source = context.createMediaStreamSource(stream); sourceRef.current = source;
      const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize); const started = Date.now(); let detected = false;
      setMessage("Speak normally for a three-second local check.");
      intervalRef.current = setInterval(() => {
        if (!current()) return;
        analyser.getByteTimeDomainData(samples); let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        setLevel(Math.min(100, Math.round(peak / 128 * 100))); detected ||= peak >= 3;
        if (Date.now() - started < 3000) return;
        generation.current++; release(); setLevel(0); setPhase(detected ? "ready" : "error"); onReady(detected);
        setMessage(detected ? "Microphone input detected. The local check is complete; microphone access has stopped." : "No input was detected. Check your microphone and try again, or continue in text.");
      }, 100);
    } catch (e) {
      if (!current()) return;
      generation.current++; release(); setPhase("error");
      setMessage(e instanceof Error && e.message.includes("Continue in text") ? e.message : "Microphone access was unavailable. Check browser permission or continue in text.");
    }
  }
  return <section className="microphone-check" aria-label="Local microphone check">
    <h3>Check your microphone</h3>
    <p>This local input check makes no recording and sends no audio. Speech processing requires a separate choice during the debrief.</p>
    {phase === "checking" && <meter min={0} max={100} value={level} aria-label="Microphone input level" />}
    {message && <p role={phase === "error" ? "alert" : "status"}>{message}</p>}
    <div className="microphone-check-actions">{phase === "checking" ? <button type="button" className="button small" onClick={stop}><Square size={14} />Stop microphone check</button> : <button type="button" className="button small" onClick={() => void check()}><Mic size={14} />{phase === "idle" ? "Check microphone locally" : "Check microphone again"}</button>}<button type="button" className="text-button" onClick={onText}>Continue in text</button></div>
  </section>;
}
