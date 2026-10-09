"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Clock3, Download, FileCode2, MessageSquare, Pause, Play, Send, Square, Terminal } from "lucide-react";
import type { EditProposal, EvidenceItem, SessionView } from "@/lib/interview-practice/types";
import { Dialog, ErrorNotice, Loading } from "@/components/ui";
import { api, ApiError, downloadJson, humanize, requestId } from "./client";
import type { Capabilities, SessionResponse } from "./contracts";
import { ReportView } from "./report";
import { VoiceControls } from "./voice";
import { usePreferences } from "./preferences";

type Draft = { files: Record<string, string>; savedAt: string };
type Panel = "interviewer" | "assistant";

export function InterviewWorkspace({ id }: { id: string }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState("");
  const [panel, setPanel] = useState<Panel>("interviewer");
  const [saveStatus, setSaveStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<"finish" | "submit" | null>(null);
  const [hint, setHint] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceItem | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const preferences = usePreferences();
  const editorFontSize = preferences.fontSize;
  const [interviewDraft, setInterviewDraft] = useState({ text: "", source: "typed" });
  const [assistantDraft, setAssistantDraft] = useState({ text: "", source: "typed" });
  const sessionRef = useRef<SessionView | null>(null);
  const filesRef = useRef(files);
  const dirtyRef = useRef(false);
  const mutationRef = useRef(false);
  const draftKey = `foundry-practice-draft:${id}`;

  const apply = useCallback((result: SessionResponse, replaceFiles = true) => {
    if (sessionRef.current && result.session.revision < sessionRef.current.revision) return;
    sessionRef.current = result.session; setSession(result.session);
    if (result.capabilities) setCapabilities(result.capabilities);
    if (replaceFiles && !dirtyRef.current) { filesRef.current = result.session.files; setFiles(result.session.files); }
  }, []);
  const refresh = useCallback((initial = false) => api<SessionResponse>(`/sessions/${id}`).then((result) => {
    apply(result);
    if (initial) {
      setActiveFile(Object.keys(result.session.files)[0] || "");
      setError("");
      try {
        const stored: Draft | null = JSON.parse(localStorage.getItem(draftKey) || "null");
        if (stored && !result.session.codeFrozenSnapshotId && JSON.stringify(stored.files) !== JSON.stringify(result.session.files)) setDraft(stored);
        else localStorage.removeItem(draftKey);
      } catch { /* Local recovery is optional when browser storage is unavailable. */ }
    }
    return result;
  }), [apply, draftKey, id]);
  useEffect(() => { refresh(true).catch((e) => setError(e.message)); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = sessionRef.current; if (!current) return;
      setElapsed(Math.floor((Date.now() - new Date(current.createdAt).getTime()) / 1000));
      if (!mutationRef.current) refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const save = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || !dirtyRef.current) return;
    if (mutationRef.current) throw new Error("Another action is still saving. Try again in a moment.");
    const sent = { ...filesRef.current }; mutationRef.current = true; setSaveStatus("saving");
    try {
      const result = await api<SessionResponse>(`/sessions/${id}/workspace`, { method: "PUT", body: JSON.stringify({ files: sent, expectedRevision: current.revision, requestId: requestId() }) });
      const stillDirty = JSON.stringify(filesRef.current) !== JSON.stringify(sent);
      dirtyRef.current = stillDirty; apply(result, false); setSaveStatus(stillDirty ? "dirty" : "saved");
      if (!stillDirty) { try { localStorage.removeItem(draftKey); } catch {} }
    } catch (e) {
      setSaveStatus("error");
      if (e instanceof ApiError && e.status === 409) setError("This session changed in another tab or action. Your local draft is retained. Download your draft before reloading to compare the saved version.");
      else setError(e instanceof Error ? e.message : "Saving failed. Your local draft is retained.");
      throw e;
    } finally { mutationRef.current = false; }
  }, [apply, draftKey, id]);
  useEffect(() => {
    if (saveStatus !== "dirty") return;
    const timer = setTimeout(() => { save().catch(() => {}); }, 1000);
    return () => clearTimeout(timer);
  }, [files, saveStatus, save]);

  function edit(value: string) {
    const next = { ...filesRef.current, [activeFile]: value }; filesRef.current = next; setFiles(next); dirtyRef.current = true; setSaveStatus("dirty");
    try { localStorage.setItem(draftKey, JSON.stringify({ files: next, savedAt: new Date().toISOString() })); } catch { /* Saving to the server remains available. */ }
  }
  async function mutate(path: string, body: Record<string, unknown> = {}, label = "action") {
    setError(""); setBusy(label);
    try {
      await save();
      if (mutationRef.current) throw new Error("Another action is still in progress.");
      mutationRef.current = true;
      const current = sessionRef.current!;
      const result = await api<SessionResponse & { hint?: string }>(`/sessions/${id}/${path}`, { method: "POST", body: JSON.stringify({ ...body, expectedRevision: current.revision, requestId: requestId() }) });
      apply(result); if (result.hint) setHint(result.hint); return result;
    } catch (e) { setError(e instanceof Error ? e.message : "The action could not be completed."); throw e; }
    finally { mutationRef.current = false; setBusy(""); }
  }
  async function command(action: string) { await mutate("commands", { action }, action); setConfirm(null); }
  const frozen = Boolean(session?.codeFrozenSnapshotId);
  const readOnly = frozen || session?.lifecycle !== "active" || Boolean(busy);
  const actionPending = Boolean(busy) || saveStatus === "saving";
  const runningJobs = session?.jobs.filter((job) => ["queued", "running"].includes(job.state)) || [];
  const runJob = runningJobs.find((job) => job.kind === "run");
  const aiJob = runningJobs.find((job) => job.kind === "interviewer" || job.kind === "assistant");
  const latestRun = session?.runs.at(-1);
  const isComplete = session?.lifecycle === "completed";
  const activeStage = session?.scenario.stages.find((stage) => stage.id === session.stageId);

  if (!session) return <div className="workspace-loading">{error ? <ErrorNotice message={error} action={<Link className="button" href="/history">Back to history</Link>} /> : <Loading>Opening your saved workspace…</Loading>}</div>;
  return <>
    <header className="workspace-header"><div className="workspace-title"><Link href="/interview-practice" className="icon-button" aria-label="Back to scenarios"><ArrowLeft size={20} /></Link><div><h1>{session.scenario.title}</h1><span>{humanize(session.mode)} · {session.configuration.level} · Python · {humanize(session.stageId)}</span></div></div><div className="workspace-actions"><span className={`save-status ${saveStatus}`} role="status">{saveStatus === "saved" && <Check size={14} />}{saveStatus === "saving" ? "Saving…" : saveStatus === "dirty" ? "Unsaved changes" : saveStatus === "error" ? "Save failed" : "Saved"}</span><span className="session-clock" title="Elapsed wall time; timing is advisory"><Clock3 size={15} />{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} <span className="muted">/ {session.configuration.targetMinutes} min</span></span>{session.lifecycle === "active" && session.mode === "practice" && <button className="button small" disabled={Boolean(busy)} onClick={() => command("pause").catch(() => {})}><Pause size={14} />Pause</button>}{session.lifecycle === "paused" && <button className="button small" disabled={Boolean(busy)} onClick={() => command("resume").catch(() => {})}><Play size={14} />Resume</button>}{!frozen && session.lifecycle === "active" && <button className="button primary small" disabled={actionPending || runningJobs.length > 0} onClick={() => setConfirm("finish")}>Finish coding <ChevronRight size={15} /></button>}{frozen && session.lifecycle === "active" && <button className="button primary small" disabled={actionPending || runningJobs.length > 0} onClick={() => setConfirm("submit")}>Final submit <ChevronRight size={15} /></button>}</div></header>
    {error && <div className="workspace-notice"><ErrorNotice message={error} action={<><button className="button small" onClick={() => downloadJson(`${session.id}-draft.json`, filesRef.current)}><Download size={14} />Download draft</button><button className="button small" onClick={() => window.location.reload()}>Reload saved session</button></>} /></div>}
    {draft && <div className="recovery-banner" role="status"><div><strong>A local draft is available.</strong> It differs from the last acknowledged save.</div><button className="button small" onClick={() => { filesRef.current = draft.files; setFiles(draft.files); dirtyRef.current = true; setSaveStatus("dirty"); setDraft(null); }}>Restore draft</button><button className="text-button" onClick={() => { localStorage.removeItem(draftKey); setDraft(null); }}>Discard local draft</button></div>}
    {session.lifecycle === "paused" && <div className="recovery-banner"><Pause size={17} /><span>Session paused. Your workspace and conversation are saved. Resume when you are ready.</span></div>}
    {frozen && session.lifecycle === "active" && <div className="debrief-banner"><MessageSquare size={17} /><span><strong>Coding is finished.</strong> Explain your decisions in the Interviewer tab. Final submit closes the discussion and generates feedback.</span></div>}
    {session.lifecycle === "reviewing" && <div className="debrief-banner"><Loading>Preparing your report from the frozen attempt…</Loading><span>You can leave this page and return through History.</span>{session.jobs.some((job) => job.kind === "coach" && job.state === "failed") && <button className="button small" disabled={actionPending || runningJobs.length > 0} onClick={() => mutate("reports", {}, "report").catch(() => {})}>Retry report</button>}</div>}
    {isComplete && session.reports.length > 0 ? <div className="report-workspace"><ReportView session={session} onEvidence={setSelectedEvidence} onDrill={(drillId) => mutate("drills", { drillId }, "drill")} /><details className="attempt-details"><summary>View saved workspace and conversation</summary><SavedAttempt session={session} /></details></div> : <div className="workspace-grid">
      <aside className="task-panel" aria-label="Scenario instructions"><div className="panel-title"><h2>Task</h2><span className="muted">v{session.scenarioVersion}</span></div><p>{session.scenario.summary}</p><ol className="stage-list">{session.scenario.stages.map((stage, index) => <li key={stage.id} aria-current={stage.id === session.stageId ? "step" : undefined}><span>{index + 1}</span><div>{stage.title}</div></li>)}</ol><section><h3>{activeStage?.title || "Debrief"}</h3><p>{activeStage?.brief || "Discuss the frozen implementation and the evidence from your attempt."}</p>{activeStage?.requirements.length ? <ul className="requirements">{activeStage.requirements.map((r) => <li key={r}>{r}</li>)}</ul> : null}</section><div className="task-actions">{!frozen && session.lifecycle === "active" && <button className="button" disabled={actionPending || runningJobs.length > 0} onClick={() => command("advance").catch(() => {})}>Next checkpoint <ChevronRight size={15} /></button>}{session.mode === "practice" && !frozen && <button className="text-button" disabled={Boolean(busy) || session.lifecycle !== "active"} onClick={() => mutate("hints", {}, "hint").catch(() => {})}>Show a hint ({session.hintsOpened} used)</button>}</div>{hint && <div className="hint"><h3>Hint</h3><p>{hint}</p></div>}<details className="rubric-details"><summary>What you will practise</summary><ul>{session.scenario.rubric.map((criterion) => <li key={criterion.id}><strong>{criterion.name}</strong><p>{criterion.description}</p></li>)}</ul></details><p className="task-footnote">{session.configuration.aiHelp ? "Coding assistance is allowed and recorded." : "Coding assistance is off for this attempt."} {session.mode === "simulation" ? "Help policy is fixed for this simulation." : "Hints and pauses are available in practice."}</p></aside>
      <section className="code-panel" aria-label="Code workspace"><div className="editor-toolbar"><div className="file-selector"><FileCode2 size={16} aria-hidden="true" /><label className="sr-only" htmlFor="active-file">Active file</label><select id="active-file" value={activeFile} onChange={(e) => setActiveFile(e.target.value)}>{Object.keys(files).map((name) => <option key={name}>{name}</option>)}</select></div><span className="muted">{frozen ? "Frozen snapshot" : "Python"}</span><button className="text-button" disabled={saveStatus === "saved" || saveStatus === "saving" || readOnly} onClick={() => save().catch(() => {})}>Save</button></div><div className="editor-body"><div className="file-tree" aria-label="Files">{Object.keys(files).map((name) => <button key={name} className={name === activeFile ? "file active" : "file"} onClick={() => setActiveFile(name)} title={name}><FileCode2 size={14} aria-hidden="true" /><span>{name}</span></button>)}</div><div className="editor-wrap"><label className="sr-only" htmlFor="code-editor">Edit {activeFile}. Tab moves to the next control.</label><textarea id="code-editor" className="code-editor" style={{ fontSize: editorFontSize }} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={files[activeFile] || ""} readOnly={readOnly} onChange={(e) => edit(e.target.value)} wrap="off" aria-describedby="editor-help" /><span id="editor-help" className="sr-only">Plain text code editor. Tab moves focus. {readOnly ? "This workspace is read only." : "Changes save automatically after one second."}</span></div></div>
        <div className="test-toolbar"><h2><Terminal size={16} />Test output</h2><div>{runJob && <button className="button small" onClick={async () => { try { await api(`/jobs/${runJob.id}/cancel`, { method: "POST", body: JSON.stringify({ requestId: requestId() }) }); await refresh(); } catch (e) { setError((e as Error).message); } }}><Square size={13} />Cancel</button>}<button className="button small primary" disabled={actionPending || Boolean(runJob) || session.lifecycle !== "active" || frozen || !capabilities?.runner} onClick={() => mutate("runs", {}, "tests").catch(() => {})}><Play size={14} />{runJob ? "Running…" : "Run tests"}</button></div></div><div className="test-output" aria-live="polite">{!capabilities?.runner ? <p className="muted">The code runner is not configured. You can edit and discuss your approach; correctness will remain unverified until a real run is available.</p> : runJob ? <Loading>Executing the saved snapshot…</Loading> : latestRun ? <><div className="run-summary"><strong>{latestRun.status === "infrastructure_error" ? "Execution unavailable" : latestRun.status === "timeout" ? "Execution timed out" : `${latestRun.tests.filter((t) => t.status === "passed").length} / ${latestRun.tests.length} checks passed`}</strong><span>{(latestRun.durationMs / 1000).toFixed(2)}s · {latestRun.status.replaceAll("_", " ")}</span></div>{latestRun.tests.map((test) => <details className={`test-result ${test.status}`} key={test.id}><summary><span>{test.status === "passed" ? "✓" : test.status === "failed" ? "×" : "—"}</span>{test.title}<span className="muted">{test.status}</span></summary>{test.detail && <pre>{test.detail}</pre>}</details>)}{(latestRun.stdout || latestRun.stderr) && <details><summary>Execution logs</summary><pre>{latestRun.stdout}{latestRun.stderr ? `\n${latestRun.stderr}` : ""}</pre></details>}<p className="run-reference">Run {latestRun.id.slice(0, 8)} · Snapshot {latestRun.snapshotSha256.slice(0, 12)}</p></> : <p className="muted">No runs yet. Run the checks to record evidence against your saved code.</p>}{session.jobs.filter((job) => job.state === "failed").slice(-1).map((job) => <ErrorNotice key={job.id} message={job.safeError || "A background action failed. Your saved work is available."} />)}</div>
      </section>
      <aside className="conversation-panel" aria-label="Interview and assistance"><div className="conversation-tabs" role="tablist" aria-label="AI roles" onKeyDown={(event) => { if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next: Panel = event.key === "Home" ? "interviewer" : event.key === "End" ? "assistant" : panel === "interviewer" ? "assistant" : "interviewer"; setPanel(next); document.getElementById(`${next}-tab`)?.focus(); } }}><button role="tab" id="interviewer-tab" aria-controls="interviewer-panel" aria-selected={panel === "interviewer"} tabIndex={panel === "interviewer" ? 0 : -1} onClick={() => setPanel("interviewer")}>Interviewer</button><button role="tab" id="assistant-tab" aria-controls="assistant-panel" aria-selected={panel === "assistant"} tabIndex={panel === "assistant" ? 0 : -1} onClick={() => setPanel("assistant")}>Coding assistant</button></div>{panel === "interviewer" ? <div id="interviewer-panel" role="tabpanel" aria-labelledby="interviewer-tab" className="conversation-content"><div className="role-note">{capabilities?.ai ? "The interviewer asks about your work and decisions." : "Authored interview questions · AI is not configured"}</div><div className="turn-list">{session.turns.length === 0 && <p className="muted">Explore the task, then ask a clarifying question or move to a checkpoint.</p>}{session.turns.map((turn) => <article className={`turn ${turn.role}`} key={turn.id} id={`turn-${turn.id}`}><div className="turn-label">{turn.role === "learner" ? "You" : "Interviewer"}<span>{turn.source === "authored" ? "Authored" : turn.source === "model" ? "AI" : turn.source === "typed" ? "Text" : "Transcript"}</span></div><p>{turn.text}</p></article>)}{aiJob?.kind === "interviewer" && <Loading>Preparing a follow-up…</Loading>}</div><VoiceControls key={`${id}:${session.lifecycle}`} sessionId={id} enabled={Boolean(capabilities?.voice)} active={session.lifecycle === "active"} onTranscript={(text, source) => setInterviewDraft({ text, source })} latestQuestion={session.turns.filter((turn) => turn.role === "interviewer").at(-1)} /><MessageComposer draft={interviewDraft} onDraft={setInterviewDraft} id="interview-answer" label={frozen ? "Your explanation" : "Message to interviewer"} placeholder={frozen ? "Explain your decisions, tests, or trade-offs…" : "Ask for clarification or explain a checkpoint…"} disabled={actionPending || Boolean(aiJob) || session.lifecycle !== "active"} onSend={(text, _mode, source) => mutate("turns", { text, source: source || "typed", replyTo: session.turns.at(-1)?.id }, "answer")} /></div> : <div id="assistant-panel" role="tabpanel" aria-labelledby="assistant-tab" className="conversation-content"><div className="role-note">Suggestions require your approval. Help is recorded with the attempt.</div>{!session.configuration.aiHelp ? <div className="assistant-unavailable"><h3>Coding assistance is off</h3><p>This attempt uses the help policy selected at setup. Start a new practice session to change it.</p></div> : !capabilities?.ai ? <div className="assistant-unavailable"><h3>AI is not configured</h3><p>Add a model provider in the server environment to enable coding help. You can continue with authored questions and tests.</p></div> : <><div className="turn-list">{session.assistantMessages.map((message) => <article className={`turn ${message.role === "learner" ? "learner" : "interviewer"}`} key={message.id}><div className="turn-label">{message.role === "learner" ? "You" : "Coding assistant"}{message.mode && <span>{message.mode}</span>}</div><p>{message.text}</p></article>)}{session.editProposals.map((item) => <div className="edit-proposal" key={item.id}><strong>Proposed file changes</strong><span>{item.status} · {Object.keys(item.files).length} files</span><button className="button small" onClick={() => setProposal(item)}>Review changes</button></div>)}{aiJob?.kind === "assistant" && <Loading>Preparing assistance…</Loading>}</div><MessageComposer draft={assistantDraft} onDraft={setAssistantDraft} id="assistant-message" label="Ask the coding assistant" placeholder="Ask a question or describe an edit…" assistant disabled={actionPending || Boolean(aiJob) || readOnly} onSend={(message, mode) => mutate("assistant", { message, mode: mode || "ask" }, "assistant")} /></>}</div>}</aside>
    </div>}
    {confirm && <Dialog title={confirm === "finish" ? "Finish coding?" : "Submit your completed attempt?"} onClose={() => setConfirm(null)}><p>{confirm === "finish" ? "Your current saved code becomes read only. The interview stays open so you can discuss your implementation and test results." : "This closes the conversation and freezes your code, tests, and committed explanations. The coach will use that evidence to prepare feedback."}</p><p className="muted">{session.runs.length} test runs · {session.turns.filter((t) => t.role === "learner").length} committed answers · {session.editProposals.filter((p) => p.status === "accepted").length} accepted AI edits</p><div className="dialog-actions"><button className="button" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>Keep working</button><button className="button primary" disabled={Boolean(busy)} onClick={() => command(confirm).catch(() => {})}>{busy ? "Saving…" : confirm === "finish" ? "Finish coding and start debrief" : "Final submit"}</button></div></Dialog>}
    {selectedEvidence && <EvidenceDialog evidence={selectedEvidence} onClose={() => setSelectedEvidence(null)} />}
    {proposal && <Dialog title="Review proposed edits" onClose={() => setProposal(null)}><p className="muted">Changes are based on snapshot {proposal.baseSha256.slice(0, 12)}. Accepting a stale proposal is blocked by the server.</p><div className="proposal-files">{Object.entries(proposal.files).map(([name, content]) => <details key={name} open><summary>{name}</summary><div className="diff-columns"><div><h3>Current file</h3><pre>{files[name] || "(new file)"}</pre></div><div><h3>Proposed file</h3><pre>{content}</pre></div></div></details>)}</div>{proposal.status === "pending" && <div className="dialog-actions"><button className="button" disabled={Boolean(busy)} onClick={() => mutate("edit-decisions", { proposalId: proposal.id, decision: "reject" }, "edit").then(() => setProposal(null)).catch(() => {})}>Reject changes</button><button className="button primary" disabled={Boolean(busy) || readOnly} onClick={() => mutate("edit-decisions", { proposalId: proposal.id, decision: "accept" }, "edit").then(() => setProposal(null)).catch(() => {})}>Accept changes</button></div>}</Dialog>}
  </>;
}

function MessageComposer({ id, label, placeholder, disabled, assistant, draft, onDraft, onSend }: { id: string; label: string; placeholder: string; disabled: boolean; assistant?: boolean; draft: { text: string; source: string }; onDraft: (draft: { text: string; source: string }) => void; onSend: (text: string, mode?: string, source?: string) => Promise<unknown> }) {
  const [mode, setMode] = useState("ask"); const [sending, setSending] = useState(false); const { text, source } = draft;
  return <form className="message-composer" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; setSending(true); try { await onSend(text.trim(), mode, source); onDraft({ text: "", source: "typed" }); } catch { /* Workspace displays the error without losing the message. */ } finally { setSending(false); } }}><label htmlFor={id}>{label}</label><textarea id={id} placeholder={placeholder} value={text} onChange={(e) => onDraft({ text: e.target.value, source: source === "transcribed" ? "corrected" : source })} disabled={disabled || sending} rows={4} /><div>{assistant ? <label className="composer-mode"><span className="sr-only">Assistance mode</span><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="ask">Ask</option><option value="plan">Plan</option><option value="edit">Propose edit</option></select></label> : <span className="muted">Only sent answers become evidence.</span>}<button className="button primary small" disabled={disabled || sending || !text.trim()} type="submit"><Send size={14} />{sending ? "Sending…" : "Send"}</button></div></form>;
}

export function EvidenceDialog({ evidence, onClose }: { evidence: EvidenceItem; onClose: () => void }) { return <Dialog title={evidence.label} onClose={onClose}><div className="evidence-meta"><span>{humanize(evidence.kind)}</span><span>Source: {evidence.source}</span>{evidence.file && <span>{evidence.file}</span>}</div><pre className="evidence-content">{evidence.content}</pre><p className="muted">Evidence {evidence.id} · Hash {evidence.sha256.slice(0, 16)}</p></Dialog>; }
function SavedAttempt({ session }: { session: SessionView }) { return <div className="saved-attempt"><div>{Object.entries(session.files).map(([name, content]) => <details key={name}><summary>{name}</summary><pre>{content}</pre></details>)}</div><div>{session.turns.map((turn) => <article className="turn" key={turn.id}><strong>{turn.role === "learner" ? "You" : "Interviewer"}</strong><p>{turn.text}</p></article>)}</div></div>; }
