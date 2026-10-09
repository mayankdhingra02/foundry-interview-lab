"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LogOut, Check, Trash2 } from "lucide-react";
import { Dialog, ErrorNotice, Loading } from "@/components/ui";
import { ApiError, api, downloadJson, requestId } from "./client";
import type { AuthResponse, Capabilities, HistoryResponse } from "./contracts";
import { savePreferences, usePreferences } from "./preferences";
import { BillingSettings } from "./billing";
import { clearBrowserPracticeRecovery, clearOwnerPracticeRecovery, isDeletedRequest, pendingReplayExpired, readPendingRequests, writePendingRequests, type PendingRequest } from "./recovery";

export function PracticeSettings() {
  const [auth, setAuth] = useState<AuthResponse | null>(null); const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [email, setEmail] = useState(""); const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false); const [deleteText, setDeleteText] = useState("");
  const [deleteError, setDeleteError] = useState(""); const [deletedReference, setDeletedReference] = useState(false);
  const [pendingDeleteView, setPendingDeleteView] = useState<PendingRequest | null>(null);
  const pendingDelete = useRef<PendingRequest | null>(null); const deleteOwner = useRef<string | null>(null);
  const preferences = usePreferences();
  const [roleOverride, setRole] = useState<string | null>(null); const [minutesOverride, setMinutes] = useState<number | null>(null); const [fontSizeOverride, setFontSize] = useState<number | null>(null);
  const role = roleOverride ?? preferences.role; const minutes = minutesOverride ?? preferences.targetMinutes; const fontSize = fontSizeOverride ?? preferences.fontSize;
  function load() { return Promise.allSettled([fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json()).then(setAuth), api<{ capabilities: Capabilities }>("/capabilities").then((result) => setCapabilities(result.capabilities))]).then((results) => { const failure = results.find((result) => result.status === "rejected"); if (failure?.status === "rejected") setError(failure.reason.message); }); }
  useEffect(() => { load(); }, []);
  async function authAction(path: string, body = {}) { setBusy(path); setError(""); setMessage(""); try { const response = await fetch(`/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || "Account action failed."); const browserCleared = path !== "logout" || clearBrowserPracticeRecovery(); setMessage(browserCleared ? result.message || (path === "logout" ? "Signed out." : "Local practice account is ready.") : "Signed out. Browser recovery data could not be cleared; clear this site’s browser data on a shared device."); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); } }
  function openDeletion() {
    setDeleteError(""); setDeletedReference(false); setDeleteText(""); pendingDelete.current = null; deleteOwner.current = auth?.user?.id ?? null;
    try { if (!deleteOwner.current) throw new Error("Sign in again before deleting practice data."); pendingDelete.current = readPendingRequests(deleteOwner.current, "delete-account").get("delete") ?? null; }
    catch (e) { setDeleteError((e as Error).message); }
    setPendingDeleteView(pendingDelete.current); setConfirmDelete(true);
  }
  function closeDeletion() { if (!busy) { setConfirmDelete(false); setDeleteError(""); } }
  async function verifyDeleteOwner() {
    const response = await fetch("/api/auth/session", { cache: "no-store" }); const current: AuthResponse = await response.json();
    if (!response.ok || !current.user || current.user.id !== deleteOwner.current) throw new Error("Your account changed or signed out. Refresh Settings and review the signed-in account before deleting data.");
    return current.user.id;
  }
  async function confirmDeletion() {
    if (busy || deleteText !== "DELETE" || deletedReference || pendingDelete.current?.acknowledged) return;
    setBusy("delete"); setDeleteError("");
    try {
      const owner = await verifyDeleteOwner(); pendingDelete.current ??= readPendingRequests(owner, "delete-account").get("delete") ?? null;
      if (pendingDelete.current && pendingReplayExpired(pendingDelete.current)) throw new Error("The original deletion replay window has expired or its clock is invalid. Review saved attempts, then explicitly discard this retry before starting a new deletion.");
      if (!pendingDelete.current) {
        const history = await api<HistoryResponse>("/sessions", { headers: { "X-Practice-Owner": owner } });
        if (!Array.isArray(history.sessions) || history.sessions.length > 50 || history.sessions.some(session => typeof session.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id))) throw new Error("Owned browser drafts could not be bounded for deletion. Review saved attempts before retrying.");
        pendingDelete.current = { payload: JSON.stringify({ confirmation: "DELETE", requestId: requestId() }), createdAt: new Date().toISOString(), uncertain: true, draftSessionIds: [...new Set(history.sessions.map(session => session.id))] };
      }
      writePendingRequests(owner, "delete-account", new Map([["delete", pendingDelete.current]]));
      const response = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json", "X-Practice-Owner": owner }, body: pendingDelete.current.payload });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(result.error?.message || "Deletion failed.", response.status, result);
      if (result.deleted !== true) throw new Error("The deletion response was interrupted. Retry this confirmation to recover its original result.");
      pendingDelete.current = { ...pendingDelete.current, acknowledged: true };
      writePendingRequests(owner, "delete-account", new Map([["delete", pendingDelete.current]]));
      await cleanupAcknowledgedDeletion();
    } catch (e) {
      if (isDeletedRequest(e) && deleteOwner.current) {
        try { writePendingRequests(deleteOwner.current, "delete-account", new Map()); pendingDelete.current = null; setDeletedReference(true); } catch { /* Keep an unconfirmed cleanup recoverable. */ }
      }
      setDeleteError((e as Error).message);
    } finally { setPendingDeleteView(pendingDelete.current); setBusy(""); }
  }
  async function cleanupAcknowledgedDeletion(explicitLocal = false) {
    if (!pendingDelete.current?.acknowledged) return;
    try {
      const owner = explicitLocal ? deleteOwner.current : await verifyDeleteOwner();
      if (!owner) throw new Error("The original deletion owner is unavailable.");
      const browserCleared = clearOwnerPracticeRecovery(owner, pendingDelete.current.draftSessionIds ?? []); pendingDelete.current = null; setConfirmDelete(false);
      setMessage(browserCleared ? "Your private Interview Lab content was deleted. Limited usage counters and your shared sign-in are preserved." : "Your private Interview Lab content was deleted. Limited usage counters and your shared sign-in are preserved. Browser recovery data could not be cleared; clear this site’s browser data on this device.");
      await load();
    } catch {
      setDeleteError("Deletion was acknowledged for the original account. Browser cleanup is pending because the signed-in account changed or could not be confirmed. Local drafts and pending actions were retained. Use the explicit browser-only cleanup to remove only the original account’s retry records and captured drafts; no deletion is resent.");
    }
  }
  async function confirmBrowserCleanup() {
    if (busy || !pendingDelete.current?.acknowledged) return;
    setBusy("cleanup-delete"); setDeleteError("");
    try { await cleanupAcknowledgedDeletion(true); } finally { setPendingDeleteView(pendingDelete.current); setBusy(""); }
  }
  async function discardExpiredDeletion() {
    if (busy || !pendingDelete.current || !pendingReplayExpired(pendingDelete.current)) return;
    setBusy("discard-delete"); setDeleteError("");
    try { const owner = await verifyDeleteOwner(); writePendingRequests(owner, "delete-account", new Map()); pendingDelete.current = null; setConfirmDelete(false); setMessage("Expired deletion retry discarded. No request was sent. Review saved attempts before explicitly starting a new deletion."); }
    catch (e) { setDeleteError((e as Error).message); } finally { setPendingDeleteView(pendingDelete.current); setBusy(""); }
  }
  const expiredDeletion = Boolean(pendingDeleteView && !pendingDeleteView.acknowledged && pendingReplayExpired(pendingDeleteView));
  return <><div className="page-heading"><div><h1>Settings</h1><p>Manage your practice preferences, account, and saved data.</p></div></div>{error && <ErrorNotice message={error} />}{message && <div className="notice success" role="status"><Check size={18} />{message}</div>}{!auth && !error && <Loading>Loading settings…</Loading>}<div className="settings-grid"><section className="settings-section"><h2>Account</h2>{!auth ? <p className="muted">Checking account access…</p> : auth.user ? <><p><strong>{auth.user.email || "Local practice account"}</strong></p><p className="muted">{auth.user.local ? "This development identity is stored in a secure browser cookie. Clearing it or signing out can make these attempts inaccessible. Export your data first. It is not a hosted account." : "Your private attempts are linked to your signed-in account."}</p><button className="button" disabled={Boolean(busy)} onClick={() => authAction("logout")}><LogOut size={16} />Sign out</button></> : auth?.authMode === "local" ? <><p>Start a local practice account to save attempts in this development install.</p><button className="button" disabled={Boolean(busy)} onClick={() => authAction("local")}>Enable local practice</button></> : auth?.authMode === "supabase" ? <form onSubmit={(e) => { e.preventDefault(); authAction("login", { email }); }}><label>Email address<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label><button className="button primary" disabled={Boolean(busy)}>Send sign-in link</button></form> : <p className="muted">Account access is not configured for this deployment.</p>}</section><section className="settings-section"><h2>Practice defaults</h2><form onSubmit={(e) => { e.preventDefault(); savePreferences({ role, targetMinutes: minutes, fontSize }); setMessage("Practice defaults saved in this browser."); }}><label>Role<select value={role} onChange={(e) => setRole(e.target.value)}><option>Backend engineer</option><option>Full stack engineer</option><option>Platform engineer</option></select></label><label>Target duration<select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option></select></label><label>Editor text size<select value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}><option value={14}>14 px</option><option value={16}>16 px</option><option value={18}>18 px</option></select></label><button className="button" type="submit">Save defaults</button></form></section><section className="settings-section wide"><h2>Available capabilities</h2><p className="muted">Availability reflects this deployment’s configuration. Text and authored questions keep the workflow usable when an external provider is unavailable.</p><dl className="capability-list">{([ ["AI interviewer and coding assistant", capabilities?.ai], ["Isolated code runner", capabilities?.runner], ["Optional press-to-talk voice", capabilities?.voice], ["Billing", capabilities?.billing], ["Hosted accounts", capabilities?.accounts] ] as const).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{capabilities ? value ? "Configured" : "Not configured" : error ? "Unavailable" : "Checking…"}</dd></div>)}</dl></section><BillingSettings enabled={capabilities?.billing} auth={auth} /><section className="settings-section"><h2>Recording and privacy</h2><ul className="privacy-list"><li>No webcam or screen recording.</li><li>Raw audio replay is off. Optional speech sends audio to the configured speech provider for transcription.</li><li>You review transcripts before sending them as interview evidence.</li><li>Attempts are not automatically shared with other learners.</li></ul><p className="muted">Model and speech providers have their own retention policies. “Not stored for replay” does not guarantee zero provider retention.</p></section><section className="settings-section"><h2>Your practice data</h2><p>Export your saved attempts, conversations, evidence, and reports. Deleting practice data removes your saved attempts, conversations, reports, and progress. Limited financial and abuse-prevention counters are retained under the deployment retention policy. Your shared Engineering Foundry sign-in is preserved.</p><div className="settings-data-actions"><button className="button" disabled={!auth?.user || Boolean(busy)} onClick={async () => { setBusy("export"); setError(""); try { const response = await fetch("/api/account/export", { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || "Export failed."); downloadJson(`foundry-account-export-${new Date().toISOString().slice(0, 10)}.json`, data); } catch (e) { setError((e as Error).message); } finally { setBusy(""); } }}><Download size={16} />Export my data</button><button className="button danger" disabled={!auth?.user || Boolean(busy)} onClick={openDeletion}><Trash2 size={16} />Delete practice data</button></div><p className="muted">Downloaded exports stay on your device. Provider records and backup expiry follow the deployment’s retention policy.</p></section></div>{confirmDelete && <Dialog title="Delete your Interview Lab data?" onClose={closeDeletion}>
    <p>This deletes your Interview Lab attempts, reports, and progress. Limited financial and abuse-prevention counters are retained. Your shared Engineering Foundry account is preserved. Export anything you want to keep first.</p>
    {pendingDeleteView && <p className="role-note">{pendingDeleteView.acknowledged ? "Deletion was acknowledged for the original account. Browser cleanup is pending. Its explicit cleanup removes only the original account’s retry records and captured drafts. No deletion will be resent." : expiredDeletion ? "This deletion retry has expired or its clock is invalid. It cannot be sent." : "The original deletion may have completed. Confirming again reuses its exact request; no new deletion intent is created. Nothing was resent automatically."}</p>}
    {deleteError && <ErrorNotice message={deleteError} />}
    <label>Type DELETE to confirm<input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" disabled={Boolean(busy)} /></label>
    <div className="dialog-actions"><button className="button" onClick={closeDeletion} disabled={Boolean(busy)}>Cancel</button>{pendingDeleteView?.acknowledged && <button className="button" disabled={Boolean(busy)} onClick={() => void confirmBrowserCleanup()}>Clear acknowledged browser data</button>}{expiredDeletion && <button className="button" disabled={Boolean(busy)} onClick={() => void discardExpiredDeletion()}>Discard expired deletion retry</button>}<button className="button danger-button" disabled={deleteText !== "DELETE" || Boolean(busy) || expiredDeletion || deletedReference || Boolean(pendingDeleteView?.acknowledged)} onClick={() => void confirmDeletion()}>{busy === "delete" ? "Deleting…" : "Delete Interview Lab data"}</button></div>
  </Dialog>}</>;
}
