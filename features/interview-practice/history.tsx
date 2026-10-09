"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Download, Trash2 } from "lucide-react";
import type { SessionView } from "@/lib/interview-practice/types";
import { Dialog, Empty, ErrorNotice, Loading } from "@/components/ui";
import { api, downloadJson, ensureIdentity, formatDate, humanize, requestId } from "./client";
import type { AuthResponse, HistoryResponse } from "./contracts";
import { clearSessionPracticeRecovery, isDeletedRequest, pendingReplayExpired, readPendingRequests, readPendingSessionDeletions, reconcilePendingCreation, writePendingRequests, type PendingRequest } from "./recovery";

type DeletionTarget = { id: string; title: string; session?: SessionView };

export function PracticeHistory() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [filter, setFilter] = useState("all");
  const [deleting, setDeleting] = useState<DeletionTarget | null>(null); const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(""); const [deletedReference, setDeletedReference] = useState(false);
  const [pendingDeletions, setPendingDeletions] = useState<ReturnType<typeof readPendingSessionDeletions>>([]);
  const [pendingDeleteView, setPendingDeleteView] = useState<PendingRequest | null>(null);
  const pendingDelete = useRef<PendingRequest | null>(null);
  const ownerRef = useRef<string | null>(null);
  function load() { ensureIdentity().then(async (auth) => { const data = await api<HistoryResponse>("/sessions"); ownerRef.current = auth.user.id; setSessions(data.sessions); setError(""); setPendingDeletions(readPendingSessionDeletions(auth.user.id)); if (reconcilePendingCreation(auth.user.id, data.sessions)) setNotice("Your interrupted start was confirmed. Its saved attempt is listed below; no new admission was requested."); }).catch((e) => setError(e.message)); }
  useEffect(() => { load(); }, []);
  function openDeletion(target: DeletionTarget) {
    setDeleteError(""); setDeletedReference(false); pendingDelete.current = null;
    try { if (!ownerRef.current) throw new Error("Refresh History before deleting an attempt."); pendingDelete.current = readPendingRequests(ownerRef.current, `delete-session:${target.id}`).get("delete") ?? null; }
    catch (e) { setDeleteError((e as Error).message); }
    setPendingDeleteView(pendingDelete.current); setDeleting(target);
  }
  function closeDeletion() { if (!busy) { setDeleting(null); setDeleteError(""); } }
  async function verifyDeleteOwner() {
    const response = await fetch("/api/auth/session", { cache: "no-store" }); const current: AuthResponse = await response.json();
    if (!response.ok || !current.user || current.user.id !== ownerRef.current) throw new Error("Your account changed or signed out. Refresh History before deleting an attempt.");
    return current.user.id;
  }
  async function confirmDeletion() {
    if (!deleting || busy || deletedReference || pendingDelete.current?.acknowledged) return;
    const target = deleting; setBusy(true); setDeleteError("");
    try {
      const owner = await verifyDeleteOwner();
      const scope = `delete-session:${target.id}`;
      pendingDelete.current ??= readPendingRequests(owner, scope).get("delete") ?? null;
      if (pendingDelete.current && pendingReplayExpired(pendingDelete.current)) throw new Error("The original deletion replay window has expired or its clock is invalid. Review saved attempts, then explicitly discard this retry before starting a new deletion.");
      if (target.session) { try { reconcilePendingCreation(owner, [target.session]); } catch { setNotice("Browser admission recovery could not be reconciled. The server still checks deleted request keys before any new admission."); } }
      pendingDelete.current ??= { payload: JSON.stringify({ requestId: requestId() }), createdAt: new Date().toISOString(), uncertain: true, title: target.title.slice(0, 200) };
      writePendingRequests(owner, scope, new Map([["delete", pendingDelete.current]]));
      const result = await api<{ deleted?: boolean }>(`/sessions/${target.id}`, { method: "DELETE", headers: { "X-Practice-Owner": owner }, body: pendingDelete.current.payload });
      if (result.deleted !== true) throw new Error("The deletion response was interrupted. Retry this confirmation to recover its original result.");
      pendingDelete.current = { ...pendingDelete.current, acknowledged: true };
      writePendingRequests(owner, scope, new Map([["delete", pendingDelete.current]]));
      await cleanupAcknowledgedDeletion(target);
    } catch (e) {
      if (isDeletedRequest(e) && ownerRef.current) {
        try { writePendingRequests(ownerRef.current, `delete-session:${target.id}`, new Map()); pendingDelete.current = null; setPendingDeletions(items => items.filter(item => item.sessionId !== target.id)); setDeletedReference(true); } catch { /* Keep an unconfirmed cleanup recoverable. */ }
      }
      setDeleteError((e as Error).message);
    } finally { setPendingDeleteView(pendingDelete.current); setBusy(false); }
  }
  async function cleanupAcknowledgedDeletion(target: DeletionTarget, explicitLocal = false) {
    if (!pendingDelete.current?.acknowledged) return;
    try {
      const owner = explicitLocal ? ownerRef.current : await verifyDeleteOwner();
      if (!owner) throw new Error("The original deletion owner is unavailable.");
      if (!clearSessionPracticeRecovery(owner, target.id)) setError("The attempt was deleted. Browser recovery data could not be cleared; clear this site’s browser data on a shared device.");
      pendingDelete.current = null; setPendingDeletions(items => items.filter(item => item.sessionId !== target.id));
      setSessions(items => items?.filter(item => item.id !== target.id) || []); setDeleting(null);
    } catch {
      setDeleteError("Deletion was acknowledged for the original account. Browser cleanup is pending because the signed-in account changed or could not be confirmed. Local drafts and pending actions were retained. Use the explicit browser-only cleanup to remove only this acknowledged attempt’s browser data; no deletion is resent.");
    }
  }
  async function confirmBrowserCleanup() {
    if (!deleting || busy || !pendingDelete.current?.acknowledged) return;
    setBusy(true); setDeleteError("");
    try { await cleanupAcknowledgedDeletion(deleting, true); } finally { setPendingDeleteView(pendingDelete.current); setBusy(false); }
  }
  async function discardExpiredDeletion() {
    if (!deleting || busy || !pendingDelete.current || !pendingReplayExpired(pendingDelete.current)) return;
    setBusy(true); setDeleteError("");
    try {
      const owner = await verifyDeleteOwner();
      writePendingRequests(owner, `delete-session:${deleting.id}`, new Map()); pendingDelete.current = null;
      setPendingDeletions(items => items.filter(item => item.sessionId !== deleting.id)); setDeleting(null); setNotice("Expired deletion retry discarded. No request was sent. Review saved attempts before explicitly starting a new deletion.");
    } catch (e) { setDeleteError((e as Error).message); } finally { setPendingDeleteView(pendingDelete.current); setBusy(false); }
  }
  const expiredDeletion = Boolean(pendingDeleteView && !pendingDeleteView.acknowledged && pendingReplayExpired(pendingDeleteView));
  const filtered = sessions?.filter((session) => filter === "all" || (filter === "active" ? ["active", "paused", "reviewing"].includes(session.lifecycle) : session.lifecycle === "completed"));
  return <><div className="page-heading"><div><h1>Practice history</h1><p>Resume saved work or revisit the evidence from a completed attempt.</p></div><Link className="button primary" href="/interview-practice">New practice <ArrowRight size={16} /></Link></div><div className="table-toolbar"><label className="inline-field">Show<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All attempts</option><option value="active">In progress</option><option value="completed">Completed</option></select></label><span className="muted">{sessions?.length || 0} saved attempts</span></div>{notice && <p role="status">{notice}</p>}{pendingDeletions.length > 0 && <section className="recovery-banner" aria-label="Pending deletion confirmations"><div>Deletion may have completed without its response. Nothing is resent automatically. Review and confirm the original retry, even if the attempt is no longer listed.</div>{pendingDeletions.map(item => <button key={item.sessionId} className="button small" onClick={() => openDeletion({ id: item.sessionId, title: item.request.title || "Saved attempt" })}>Review deletion retry: {item.request.title || "Saved attempt"}</button>)}</section>}{error && <ErrorNotice message={error} action={<button className="button" onClick={load}>Try again</button>} />}{!sessions && !error && <Loading>Loading your private history…</Loading>}{sessions && filtered?.length === 0 && <Empty title={sessions.length ? "No attempts in this view" : "Your first attempt starts here"}><p>{sessions.length ? "Choose another status to see your saved work." : "Choose an original scenario and work through it at your pace."}</p><Link className="button primary" href="/interview-practice">Browse scenarios <ArrowRight size={16} /></Link></Empty>}{filtered && filtered.length > 0 && <div className="table-scroll"><table className="history-table"><thead><tr><th scope="col">Scenario</th><th scope="col">Conditions</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map((session) => <tr key={session.id}><td><Link className="table-title" href={`/interview-practice/${session.id}`}>{session.scenario?.title || session.scenarioId}</Link><span className="table-meta">Version {session.scenarioVersion} · {session.configuration?.level}</span></td><td>{humanize(session.mode)}<span className="table-meta">{session.configuration?.aiHelp ? "AI help permitted" : "No AI help"}</span></td><td>{session.lifecycle === "active" && session.codeFrozenSnapshotId ? "Debrief" : humanize(session.lifecycle)}</td><td>{formatDate(session.updatedAt)}</td><td><div className="table-actions"><Link className="button small" href={`/interview-practice/${session.id}`}>{session.lifecycle === "completed" ? "Review" : "Resume"}<ArrowRight size={14} /></Link><button className="icon-button" aria-label={`Export ${session.scenario?.title || "attempt"}`} onClick={async () => { try { const result = await api<unknown>(`/sessions/${session.id}/export`); downloadJson(`foundry-attempt-${session.id}.json`, result); } catch (e) { setError((e as Error).message); } }}><Download size={16} /></button><button className="icon-button danger" aria-label={`Delete ${session.scenario?.title || "attempt"}`} onClick={() => openDeletion({ id: session.id, title: session.scenario?.title || session.scenarioId, session })}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>}{deleting && <Dialog title="Delete this practice attempt?" onClose={closeDeletion}>
    <p>This removes your saved workspace, conversation, reports, and related practice evidence for <strong>{deleting.title}</strong>. Downloaded exports remain on your device.</p>
    {pendingDeleteView && <p className="role-note">{pendingDeleteView.acknowledged ? "Deletion was acknowledged for the original account. Browser cleanup is pending. No deletion will be resent." : expiredDeletion ? "This deletion retry has expired or its clock is invalid. It cannot be sent." : "The original deletion may have completed. Confirming again reuses its exact request; no new deletion intent is created."}</p>}
    {deleteError && <ErrorNotice message={deleteError} />}
    <div className="dialog-actions"><button className="button" disabled={busy} onClick={closeDeletion}>Cancel</button>{pendingDeleteView?.acknowledged && <button className="button" disabled={busy} onClick={() => void confirmBrowserCleanup()}>Clear acknowledged browser data</button>}{expiredDeletion && <button className="button" disabled={busy} onClick={() => void discardExpiredDeletion()}>Discard expired deletion retry</button>}<button className="button danger-button" disabled={busy || expiredDeletion || deletedReference || Boolean(pendingDeleteView?.acknowledged)} onClick={() => void confirmDeletion()}>{busy ? "Deleting…" : "Delete attempt"}</button></div>
  </Dialog>}</>;
}
