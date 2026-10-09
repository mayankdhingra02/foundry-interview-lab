"use client";

import { useRef, useState } from "react";
import type { SessionView } from "@/lib/interview-practice/types";
import type { ClarificationTopic, InteractionAction } from "@/lib/server/interactions";
import { requestId } from "./client";
import "./interactions.css";

export function InteractionControls({ session, disabled, onInteract }: {
  session: SessionView;
  disabled: boolean;
  onInteract: (action: InteractionAction, topic: ClarificationTopic | undefined, key: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState("");
  const keys = useRef<Record<string, string>>({});
  const inFlight = useRef(false);
  const latest = session.events.filter(event => event.type === "interview.interaction").at(-1);
  const unavailable = disabled || Boolean(pending) || session.lifecycle !== "active";
  const hasQuestion = session.turns.some(turn => turn.role === "interviewer");
  async function act(action: InteractionAction, topic?: ClarificationTopic) {
    if (inFlight.current) return;
    const operation = `${action}:${topic || ""}`;
    const key = keys.current[operation] || (keys.current[operation] = requestId());
    inFlight.current = true; setPending(operation);
    try { await onInteract(action, topic, key); delete keys.current[operation]; }
    catch { /* The workspace presents the error; retry retains the same request key. */ }
    finally { inFlight.current = false; setPending(""); }
  }
  return <section className="interview-controls" aria-label="Interview controls">
    <div className="task-actions">
      <button className="button small" disabled={unavailable} onClick={() => void act("working")}>I’m working</button>
      <button className="button small" disabled={unavailable || !hasQuestion} onClick={() => void act("repeat")}>Repeat question</button>
      <button className="button small" disabled={unavailable} onClick={() => void act("clarify", "requirements")}>Clarify requirements</button>
    </div>
    <details><summary>Timing and help policy</summary><div className="task-actions">
      <button className="text-button" disabled={unavailable} onClick={() => void act("clarify", "timing")}>Explain timing</button>
      <button className="text-button" disabled={unavailable} onClick={() => void act("clarify", "assistance")}>Explain assistance policy</button>
    </div></details>
    {pending && <p className="muted" role="status">Saving interview control…</p>}
    {latest && <p className="role-note interview-control-response" role="status">{latest.payload.response}</p>}
  </section>;
}
