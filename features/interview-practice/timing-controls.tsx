"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui";
import type { SessionView } from "@/lib/interview-practice/types";
import { describeTiming, MAX_ADVISORY_MINUTES } from "@/lib/interview-practice/timing";

export function TimingControls({ session, disabled, pending, onExtend }: { session: SessionView; disabled: boolean; pending: boolean; onExtend: (minutes: 15 | 30) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState<15 | 30>(15);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => { if (wasOpen.current && !open) trigger.current?.focus(); wasOpen.current = open; }, [open]);
  const available = ["active", "paused"].includes(session.lifecycle) && !session.frozenEvidence;
  const atLimit = session.configuration.targetMinutes + 15 > MAX_ADVISORY_MINUTES;
  async function extend(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || pending || saving || !available || session.configuration.targetMinutes + minutes > MAX_ADVISORY_MINUTES) return;
    setSaving(true); setError("");
    try { await onExtend(minutes); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The extension could not be confirmed. Recover the original action from the pending notice."); }
    finally { setSaving(false); }
  }
  return <><button ref={trigger} className="button small" onClick={() => { setError(""); setOpen(true); }} aria-label={`Advisory time: ${session.configuration.targetMinutes} minutes`}>Advisory time · {session.configuration.targetMinutes} min</button>{open && <Dialog title="Advisory time" onClose={() => { if (!saving) setOpen(false); }}><form onSubmit={extend}><p>The timer is a practice guide. It never submits your attempt or stops you from saving. An extension does not lower rubric ratings.</p><p>{describeTiming(session.configuration)}</p>{available ? <><label>Add time<select value={minutes} disabled={disabled || pending || saving || atLimit} onChange={(event) => setMinutes(Number(event.target.value) as 15 | 30)}><option value={15}>15 minutes</option><option value={30} disabled={session.configuration.targetMinutes + 30 > MAX_ADVISORY_MINUTES}>30 minutes</option></select></label>{atLimit && <p className="role-note">Another 15 or 30 minute extension would exceed the available limit of {MAX_ADVISORY_MINUTES} minutes. You can keep working and saving.</p>}{pending && <p className="role-note" role="status">An extension is waiting for recovery. Close this dialog and use Recover advisory time to confirm the original request; it will not add the same time twice.</p>}</> : <p className="role-note">This attempt has been submitted. Its recorded conditions remain fixed with the frozen evidence.</p>}{error && <p role="alert" className="error-text">{error}</p>}<div className="dialog-actions"><button type="button" className="button" disabled={saving} onClick={() => setOpen(false)}>Close</button>{available && <button className="button primary" disabled={disabled || pending || saving || atLimit || session.configuration.targetMinutes + minutes > MAX_ADVISORY_MINUTES}>{saving ? "Saving…" : "Add advisory time"}</button>}</div></form></Dialog>}</>;
}
