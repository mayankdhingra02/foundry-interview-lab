"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock3, Code2, Search, Mic, Check } from "lucide-react";
import type { PublicScenario, PracticeMode } from "@/lib/interview-practice/types";
import { Dialog, Empty, ErrorNotice, Loading } from "@/components/ui";
import { api, ApiError, ensureIdentity, requestId } from "./client";
import type { ScenarioResponse, SessionResponse, Capabilities } from "./contracts";
import { usePreferences } from "./preferences";
import { isDeletedRequest, pendingReplayExpired, readPendingRequests, writePendingRequests, type PendingRequest } from "./recovery";
import { MicrophoneCheck } from "./microphone-check";
import { scenarioTier } from "@/lib/interview-practice/curriculum";
import { DEFAULT_PRACTICE_CONDITIONS, MAX_ADVISORY_MINUTES, setupExtraMinutes, type PracticeSetupConditions } from "@/lib/interview-practice/timing";

export function PracticeCatalog() {
  const [data, setData] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [skill, setSkill] = useState("all");
  const [tier, setTier] = useState("all");
  const [selected, setSelected] = useState<PublicScenario | null>(null);
  const load = () => { api<ScenarioResponse>("/scenarios").then((result) => { setData(result); setError(""); const scenarioId = new URL(window.location.href).searchParams.get("scenario"); if (scenarioId) setSelected(result.scenarios.find((scenario) => scenario.id === scenarioId) || null); }).catch((e) => setError(e.message)); };
  useEffect(load, []);
  const tags = useMemo(() => [...new Set(data?.scenarios.flatMap((s) => s.tags) || [])], [data]);
  const scenarios = data?.scenarios.filter((s) => `${s.title} ${s.summary} ${s.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (skill === "all" || s.tags.includes(skill)) && (tier === "all" || scenarioTier(s) === tier)) || [];
  return <>
    <div className="page-heading"><div><h1>Interview practice</h1><p>Work through an unfamiliar repository, explain your decisions, and review the evidence.</p></div><Link className="button" href="/history">Resume a session <ArrowRight size={16} /></Link></div>
    <div className="practice-intro"><ol aria-label="Practice flow"><li><span>1</span>Attempt</li><li><span>2</span>Explain</li><li><span>3</span>Review</li><li><span>4</span>Drill and retry</li></ol><p>Original engineering exercises. Choose practice for hints and pauses, or simulation for a fixed help policy.</p></div>
    <div className="catalog-toolbar"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">Search scenarios</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search scenarios or skills" /></label><label className="inline-field">Skill<select value={skill} onChange={(e) => setSkill(e.target.value)}><option value="all">All skills</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label><label className="inline-field">Task level<select value={tier} onChange={(e) => setTier(e.target.value)}><option value="all">All levels</option><option>Junior</option><option>Mid-level</option><option>Senior</option></select></label><span className="muted result-count">{data ? `${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}` : ""}</span></div>
    {error && <ErrorNotice message={error} action={<button className="button" onClick={load}>Try again</button>} />}
    {!data && !error && <Loading>Loading the scenario catalog…</Loading>}
    {data && scenarios.length === 0 && <Empty title={data.scenarios.length === 0 ? "New practice is currently closed" : "No matching scenarios"}><p>{data.scenarios.length === 0 ? "Saved attempts remain available in History. New scenarios will appear when practice opens." : "Try another search, skill or task level."}</p></Empty>}
    <div className="scenario-list">{scenarios.map((scenario) => <article key={scenario.id} className="scenario-row"><div className="scenario-number"><Code2 size={24} aria-hidden="true" /></div><div className="scenario-copy"><h2>{scenario.title}</h2><p>{scenario.summary}</p><div className="scenario-meta"><span>{scenario.level}</span>{scenario.curriculum && <span>Difficulty review pending</span>}<span>Python</span><span><Clock3 size={14} aria-hidden="true" />{scenario.durationMinutes} min</span></div><ScenarioPreparation scenario={scenario} /><div className="skill-list">{scenario.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><button className="button primary" onClick={() => setSelected(scenario)}>Set up practice <ArrowRight size={16} /></button></article>)}</div>
    {data && <section className="catalog-notes"><div><h2>Feedback you can inspect</h2><p>Reports connect findings to your saved code, real test results, and explanations. Missing observations remain visible.</p></div><div><h2>Help has a clear role</h2><p>The interviewer asks questions. The coding assistant offers help when allowed. The coach reviews your completed attempt.</p></div><div><h2>Text works throughout</h2><p>{data.capabilities.voice ? "Optional voice uses a visible transcript that you can correct before sending." : "Voice is not configured here. All practice and debrief controls are available in text."}</p></div></section>}
    {selected && data && <SetupDialog scenario={selected} capabilities={data.capabilities} onClose={() => setSelected(null)} />}
  </>;
}

function ScenarioPreparation({ scenario, expanded = false }: { scenario: PublicScenario; expanded?: boolean }) {
  if (!scenario.curriculum) return null;
  return <details className="scenario-prerequisites" open={expanded || undefined}>
    <summary>Requirements and prerequisites</summary>
    <p>Original {scenario.curriculum.tier} draft. Expert difficulty calibration and learner pilot are pending. Same-family variants are repeated-domain practice.</p>
    <h3>Task constraints</h3><ul>{scenario.curriculum.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
    <h3>Suggested prerequisites</h3><ul>{scenario.curriculum.prerequisites.map((item) => <li key={item.id}><strong>{item.title}.</strong> {item.description}{item.lesson && <span> Review the related Foundry lesson from your study plan when Foundry navigation is available.</span>}</li>)}</ul>
    <p>Prerequisites guide preparation. They do not assert mastery or block access.</p>
  </details>;
}

function SetupDialog({ scenario, capabilities, onClose }: { scenario: PublicScenario; capabilities: Capabilities; onClose: () => void }) {
  const router = useRouter();
  const preferences = usePreferences();
  const [mode, setMode] = useState<PracticeMode>("practice");
  const [role, setRole] = useState(preferences.role);
  const [level, setLevel] = useState(scenario.level);
  const [minutes, setMinutes] = useState(preferences.targetMinutes || scenario.durationMinutes);
  const [skills, setSkills] = useState<string[]>(scenario.tags.slice(0, 2));
  const [aiHelp, setAiHelp] = useState(true);
  const [voice, setVoice] = useState(false);
  const [conditions, setConditions] = useState<PracticeSetupConditions>({ ...DEFAULT_PRACTICE_CONDITIONS });
  const effectiveMinutes = minutes + setupExtraMinutes(conditions.timing);
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [originalTitle, setOriginalTitle] = useState(scenario.title);
  const [originalVersion, setOriginalVersion] = useState(scenario.version);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [pendingClock, setPendingClock] = useState<string | null>(null);
  const pendingStart = useRef<PendingRequest | null>(null);
  const ownerRef = useRef<string | null>(null);
  const restoreStart = useCallback((record: PendingRequest) => {
    const input = JSON.parse(record.payload);
    pendingStart.current = record; setPendingClock(record.createdAt); setInterrupted(true); setMode(input.mode); setRole(input.role); setLevel(input.level); setConditions(input.practiceConditions || { ...DEFAULT_PRACTICE_CONDITIONS }); setMinutes(input.targetMinutes - setupExtraMinutes(input.practiceConditions?.timing || "standard")); setSkills(input.skills); setAiHelp(input.aiHelp); setVoice(input.voice); setOriginalTitle(record.title || "Your interrupted session"); setOriginalVersion(record.scenarioVersion || "saved");
  }, []);
  useEffect(() => {
    let live = true;
    ensureIdentity().then(auth => {
      if (!live) return;
      ownerRef.current = auth.user.id;
      const pending = readPendingRequests(auth.user.id, "creation").get("create");
      if (pending) restoreStart(pending);
    }).catch((e: Error) => { if (live) setError(e.message); }).finally(() => { if (live) setInitializing(false); });
    return () => { live = false; };
  }, [restoreStart]);
  async function start(e: React.FormEvent) {
    if (busy || initializing) { e.preventDefault(); return; }
    e.preventDefault(); setBusy(true); setError("");
    let wasPending = Boolean(pendingStart.current); let sent = false;
    try {
      const auth = await ensureIdentity();
      if (pendingStart.current && ownerRef.current !== auth.user.id) throw new Error("Your account changed. Close and reopen setup to recover requests for the signed-in account.");
      ownerRef.current = auth.user.id;
      if (!pendingStart.current) {
        const stored = readPendingRequests(auth.user.id, "creation").get("create");
        if (stored) { wasPending = true; restoreStart(stored); throw new Error("An interrupted start is waiting. Retry to recover that session before starting another."); }
      }
      if (pendingStart.current && pendingReplayExpired(pendingStart.current)) throw new Error("The original replay window has expired or its clock is invalid. Review saved attempts, then explicitly discard this expired retry before starting again.");
      if (!pendingStart.current && effectiveMinutes > MAX_ADVISORY_MINUTES) throw new Error("Choose a shorter base duration or less extra setup time. The advisory target can be at most 180 minutes.");
      if (!pendingStart.current && voice && !microphoneReady) throw new Error("Complete the local microphone check or choose Text before starting a voice session.");
      // A lost acknowledgement is not a failed admission. Keep the complete
      // original request until the server confirms its outcome.
      pendingStart.current ??= { payload: JSON.stringify({ scenarioId: scenario.id, mode, role, level, skills, targetMinutes: effectiveMinutes, aiHelp, voice, practiceConditions: conditions, requestId: requestId() }), uncertain: false, createdAt: new Date().toISOString(), title: scenario.title, scenarioVersion: scenario.version };
      writePendingRequests(auth.user.id, "creation", new Map([["create", pendingStart.current]])); sent = true;
      const result = await api<SessionResponse>("/sessions", { method: "POST", body: pendingStart.current.payload });
      if (!result.session?.id) throw new Error("The start response was interrupted. Retry to recover the same session.");
      writePendingRequests(auth.user.id, "creation", new Map());
      pendingStart.current = null; setPendingClock(null); setInterrupted(false); router.push(`/interview-practice/${result.session.id}`);
    } catch (e) {
      if (isDeletedRequest(e) || (!sent && !wasPending) || (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 410].includes(e.status) && !wasPending)) {
        try { if (ownerRef.current) writePendingRequests(ownerRef.current, "creation", new Map()); pendingStart.current = null; } catch { /* Keep the original retry if storage cleanup is unavailable. */ }
      }
      else if (pendingStart.current) pendingStart.current.uncertain = true;
      setPendingClock(pendingStart.current?.createdAt ?? null); setInterrupted(pendingStart.current !== null); setError(e instanceof Error ? e.message : "Could not start practice."); setBusy(false);
    }
  }
  const expiredStart = pendingClock !== null && pendingReplayExpired({ createdAt: pendingClock });
  async function discardExpiredStart() {
    if (busy || !pendingStart.current || !pendingReplayExpired(pendingStart.current)) return;
    setBusy(true); setError("");
    try {
      const auth = await ensureIdentity();
      if (auth.user.id !== ownerRef.current) throw new Error("Your account changed. Reopen setup before changing its saved retry.");
      writePendingRequests(auth.user.id, "creation", new Map()); pendingStart.current = null; setPendingClock(null); setInterrupted(false);
      setMode("practice"); setRole(preferences.role); setLevel(scenario.level); setMinutes(preferences.targetMinutes || scenario.durationMinutes); setSkills(scenario.tags.slice(0, 2)); setAiHelp(true); setVoice(false); setConditions({ ...DEFAULT_PRACTICE_CONDITIONS }); setOriginalTitle(scenario.title); setOriginalVersion(scenario.version);
      setRecoveryNotice("Expired retry discarded. No request was sent. Review saved attempts before explicitly starting a new session.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog title="Set up your session" onClose={() => { if (!busy) onClose(); }}><form onSubmit={start}><p className="dialog-description">{originalTitle} <span className="muted">· Version {originalVersion}</span></p><fieldset disabled={busy || interrupted || initializing} aria-label="Session settings">
    <fieldset className="mode-options"><legend>Mode</legend><label className={mode === "practice" ? "choice selected" : "choice"}><input type="radio" name="mode" checked={mode === "practice"} onChange={() => setMode("practice")} /><span><strong>Practice</strong><span>Hints, pauses, and time to explore.</span></span></label><label className={mode === "simulation" ? "choice selected" : "choice"}><input type="radio" name="mode" checked={mode === "simulation"} onChange={() => setMode("simulation")} /><span><strong>Simulation</strong><span>Set your help policy before starting.</span></span></label></fieldset>
    <div className="form-grid"><label>Role<select value={role} onChange={(e) => setRole(e.target.value)}><option>Backend engineer</option><option>Full stack engineer</option><option>Platform engineer</option></select></label><label>Preparation goal level<select value={level} onChange={(e) => setLevel(e.target.value)}>{[...new Set([level, scenario.level, "Junior", "Mid-level", "Senior"])].map((l) => <option key={l}>{l}</option>)}</select></label><label>Target duration (advisory)<select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[...new Set([minutes, 30, 45, 60, scenario.durationMinutes])].sort((a,b) => a-b).map((n) => <option value={n} key={n}>{n} minutes</option>)}</select></label><label>Conversation<select value={voice ? "voice" : "text"} onChange={(e) => { setMicrophoneReady(false); setVoice(e.target.value === "voice"); }}><option value="text">Text</option><option value="voice" disabled={!capabilities.voice || conditions.participation === "written-only"}>Voice {capabilities.voice ? "" : "— not configured"}</option></select></label></div>
    <fieldset><legend>Timing and participation</legend><div className="form-grid"><label>Extra setup time<select value={conditions.timing} onChange={(event) => setConditions({ ...conditions, timing: event.target.value as PracticeSetupConditions["timing"] })}><option value="standard">No extra time</option><option value="extra-15" disabled={minutes + 15 > MAX_ADVISORY_MINUTES}>15 additional minutes</option><option value="extra-30" disabled={minutes + 30 > MAX_ADVISORY_MINUTES}>30 additional minutes</option></select></label><label>Participation preference<select value={conditions.participation} onChange={(event) => { const participation = event.target.value as PracticeSetupConditions["participation"]; setConditions({ ...conditions, participation }); if (participation === "written-only") { setVoice(false); setMicrophoneReady(false); } }}><option value="text-or-voice">Text with optional voice</option><option value="written-only">Written only</option></select></label></div><p className="role-note">Your advisory target is {effectiveMinutes} minutes. The timer never ends your attempt. You can add time while working or in debrief; timing and written participation do not lower rubric ratings. These options record your practice conditions, without asking for health details.</p>{effectiveMinutes > MAX_ADVISORY_MINUTES && <p className="error-text" role="alert">Choose a shorter base duration or less extra setup time; the advisory target can be at most 180 minutes.</p>}</fieldset>
    {voice && !interrupted && <MicrophoneCheck onReady={setMicrophoneReady} onText={() => { setMicrophoneReady(false); setVoice(false); }} />}
    <p className="setup-context">This task uses its published {scenario.level} requirements and rubric. Your preparation goal does not change the task constraints or difficulty.</p><ScenarioPreparation scenario={scenario} expanded /><fieldset className="skill-options"><legend>Skills to focus on</legend>{[...new Set([...scenario.tags, ...skills])].map((tag) => <label key={tag}><input type="checkbox" checked={skills.includes(tag)} onChange={(e) => setSkills(e.target.checked ? [...skills, tag] : skills.filter((s) => s !== tag))} />{tag}</label>)}</fieldset>
    <label className="checkbox-row"><input type="checkbox" checked={aiHelp} onChange={(e) => setAiHelp(e.target.checked)} /><span><strong>Allow the coding assistant</strong><span>{capabilities.ai ? "Ask questions or preview proposed edits. Your use of help is recorded." : "AI is not configured. Authored interview questions and deterministic feedback remain available."}</span></span></label>
    </fieldset>
    <div className="setup-rules"><p><Check size={16} aria-hidden="true" />Code and committed answers are saved privately for your practice account.</p><p><Check size={16} aria-hidden="true" />Finish coding starts the debrief. Final submit generates your report.</p><p><Mic size={16} aria-hidden="true" />No webcam or screen recording. Raw audio playback is off.</p></div>
    {capabilities.coaching === false && <p className="role-note">{capabilities.details?.coaching || "AI coaching is unavailable. Final submission preserves your evidence in an observation-only report; it does not assess your skills."}</p>}
    {interrupted && <p className="role-note" role="status">{expiredStart ? "The original replay window has expired or its clock is invalid. This request cannot be replayed. Review saved attempts, then explicitly discard the expired retry before starting a new session." : "The start request may have completed. Retry to recover the same session, or review your saved attempts. Your original settings stay fixed until its outcome is confirmed. This tab retains the pending request when you close setup or reload."}</p>}
    {recoveryNotice && <p className="role-note" role="status">{recoveryNotice}</p>}
    {error && <ErrorNotice message={error} />}
    <div className="dialog-actions">{interrupted && <Link className="button" href="/history">Review saved attempts</Link>}{expiredStart && <button type="button" className="button" disabled={busy} onClick={() => void discardExpiredStart()}>Discard expired retry</button>}<button type="button" className="button" onClick={onClose} disabled={busy}>{interrupted ? "Close setup" : "Cancel"}</button><button className="button primary" disabled={busy || initializing || expiredStart || (!interrupted && effectiveMinutes > MAX_ADVISORY_MINUTES) || (!interrupted && voice && !microphoneReady)}>{busy ? "Starting…" : initializing ? "Checking saved request…" : interrupted ? "Retry start" : "Start session"}<ArrowRight size={16} /></button></div>
  </form></Dialog>;
}
