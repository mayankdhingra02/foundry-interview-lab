"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock3, Code2, Search, Mic, Check } from "lucide-react";
import type { PublicScenario, PracticeMode } from "@/lib/interview-practice/types";
import { Dialog, Empty, ErrorNotice, Loading } from "@/components/ui";
import { api, ensureIdentity, requestId } from "./client";
import type { ScenarioResponse, SessionResponse, Capabilities } from "./contracts";
import { usePreferences } from "./preferences";

export function PracticeCatalog() {
  const [data, setData] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [skill, setSkill] = useState("all");
  const [selected, setSelected] = useState<PublicScenario | null>(null);
  const load = () => { api<ScenarioResponse>("/scenarios").then((result) => { setData(result); setError(""); const scenarioId = new URL(window.location.href).searchParams.get("scenario"); if (scenarioId) setSelected(result.scenarios.find((scenario) => scenario.id === scenarioId) || null); }).catch((e) => setError(e.message)); };
  useEffect(load, []);
  const tags = useMemo(() => [...new Set(data?.scenarios.flatMap((s) => s.tags) || [])], [data]);
  const scenarios = data?.scenarios.filter((s) => `${s.title} ${s.summary} ${s.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (skill === "all" || s.tags.includes(skill))) || [];
  return <>
    <div className="page-heading"><div><h1>Interview practice</h1><p>Work through an unfamiliar repository, explain your decisions, and review the evidence.</p></div><Link className="button" href="/history">Resume a session <ArrowRight size={16} /></Link></div>
    <div className="practice-intro"><ol aria-label="Practice flow"><li><span>1</span>Attempt</li><li><span>2</span>Explain</li><li><span>3</span>Review</li><li><span>4</span>Drill and retry</li></ol><p>Original engineering exercises. Choose practice for hints and pauses, or simulation for a fixed help policy.</p></div>
    <div className="catalog-toolbar"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">Search scenarios</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search scenarios or skills" /></label><label className="inline-field">Skill<select value={skill} onChange={(e) => setSkill(e.target.value)}><option value="all">All skills</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label><span className="muted result-count">{data ? `${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}` : ""}</span></div>
    {error && <ErrorNotice message={error} action={<button className="button" onClick={load}>Try again</button>} />}
    {!data && !error && <Loading>Loading the scenario catalog…</Loading>}
    {data && scenarios.length === 0 && <Empty title={data.scenarios.length === 0 ? "New practice is currently closed" : "No matching scenarios"}><p>{data.scenarios.length === 0 ? "Saved attempts remain available in History. New scenarios will appear when practice opens." : "Try another search or choose all skills."}</p></Empty>}
    <div className="scenario-list">{scenarios.map((scenario) => <article key={scenario.id} className="scenario-row"><div className="scenario-number"><Code2 size={24} aria-hidden="true" /></div><div className="scenario-copy"><h2>{scenario.title}</h2><p>{scenario.summary}</p><div className="scenario-meta"><span>{scenario.level}</span><span>Python</span><span><Clock3 size={14} aria-hidden="true" />{scenario.durationMinutes} min</span></div><div className="skill-list">{scenario.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><button className="button primary" onClick={() => setSelected(scenario)}>Set up practice <ArrowRight size={16} /></button></article>)}</div>
    {data && <section className="catalog-notes"><div><h2>Feedback you can inspect</h2><p>Reports connect findings to your saved code, real test results, and explanations. Missing observations remain visible.</p></div><div><h2>Help has a clear role</h2><p>The interviewer asks questions. The coding assistant offers help when allowed. The coach reviews your completed attempt.</p></div><div><h2>Text works throughout</h2><p>{data.capabilities.voice ? "Optional voice uses a visible transcript that you can correct before sending." : "Voice is not configured here. All practice and debrief controls are available in text."}</p></div></section>}
    {selected && data && <SetupDialog scenario={selected} capabilities={data.capabilities} onClose={() => setSelected(null)} />}
  </>;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await ensureIdentity(); const result = await api<SessionResponse>("/sessions", { method: "POST", body: JSON.stringify({ scenarioId: scenario.id, mode, role, level, skills, targetMinutes: minutes, aiHelp, voice, requestId: requestId() }) }); router.push(`/interview-practice/${result.session.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start practice."); setBusy(false); }
  }
  return <Dialog title="Set up your session" onClose={onClose}><form onSubmit={start}><p className="dialog-description">{scenario.title} <span className="muted">· Version {scenario.version}</span></p>
    <fieldset className="mode-options"><legend>Mode</legend><label className={mode === "practice" ? "choice selected" : "choice"}><input type="radio" name="mode" checked={mode === "practice"} onChange={() => setMode("practice")} /><span><strong>Practice</strong><span>Hints, pauses, and time to explore.</span></span></label><label className={mode === "simulation" ? "choice selected" : "choice"}><input type="radio" name="mode" checked={mode === "simulation"} onChange={() => setMode("simulation")} /><span><strong>Simulation</strong><span>Set your help policy before starting.</span></span></label></fieldset>
    <div className="form-grid"><label>Role<select value={role} onChange={(e) => setRole(e.target.value)}><option>Backend engineer</option><option>Full stack engineer</option><option>Platform engineer</option></select></label><label>Target level<select value={level} onChange={(e) => setLevel(e.target.value)}>{[...new Set([scenario.level, "Junior", "Mid-level", "Senior"])].map((l) => <option key={l}>{l}</option>)}</select></label><label>Target duration (advisory)<select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[...new Set([30, 45, 60, scenario.durationMinutes])].sort((a,b) => a-b).map((n) => <option value={n} key={n}>{n} minutes</option>)}</select></label><label>Conversation<select value={voice ? "voice" : "text"} onChange={(e) => setVoice(e.target.value === "voice")}><option value="text">Text</option><option value="voice" disabled={!capabilities.voice}>Voice {capabilities.voice ? "" : "— not configured"}</option></select></label></div>
    <p className="setup-context">The task uses its published requirements and rubric. Your selections record your preparation goals.</p><fieldset className="skill-options"><legend>Skills to focus on</legend>{scenario.tags.map((tag) => <label key={tag}><input type="checkbox" checked={skills.includes(tag)} onChange={(e) => setSkills(e.target.checked ? [...skills, tag] : skills.filter((s) => s !== tag))} />{tag}</label>)}</fieldset>
    <label className="checkbox-row"><input type="checkbox" checked={aiHelp} onChange={(e) => setAiHelp(e.target.checked)} /><span><strong>Allow the coding assistant</strong><span>{capabilities.ai ? "Ask questions or preview proposed edits. Your use of help is recorded." : "AI is not configured. Authored interview questions and deterministic feedback remain available."}</span></span></label>
    <div className="setup-rules"><p><Check size={16} aria-hidden="true" />Code and committed answers are saved privately for your practice account.</p><p><Check size={16} aria-hidden="true" />Finish coding starts the debrief. Final submit generates your report.</p><p><Mic size={16} aria-hidden="true" />No webcam or screen recording. Raw audio playback is off.</p></div>
    {capabilities.coaching === false && <p className="role-note">{capabilities.details?.coaching || "AI coaching is unavailable. Final submission preserves your evidence in an observation-only report; it does not assess your skills."}</p>}
    {error && <ErrorNotice message={error} />}
    <div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Starting…" : "Start session"}<ArrowRight size={16} /></button></div>
  </form></Dialog>;
}
