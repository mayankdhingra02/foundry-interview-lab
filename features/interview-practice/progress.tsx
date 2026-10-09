"use client";

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { ProgressionResult, SkillObservation, SkillProgress, StudyStep } from '@/lib/interview-practice/progression';
import type { PublicScenario } from '@/lib/interview-practice/types';
import { ErrorNotice, Loading } from '@/components/ui';
import { api, ensureIdentity, formatDate } from './client';
import type { ScenarioResponse } from './contracts';
import './progression.css';

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : word.endsWith('criterion') ? word.slice(0, -9) + 'criteria' : word + 's'}`;
const assessmentName = (source: SkillObservation['assessmentSource']) => source === 'staff-reviewed' ? 'Staff-reviewed feedback' : source === 'authored' ? 'Authored feedback' : 'AI coaching';
const consistencyName: Record<SkillProgress['consistency']['status'], string> = { 'single-observation': 'One observation', 'conditions-vary': 'Practice conditions vary', 'consistent-findings': 'Same finding under recorded conditions', 'mixed-findings': 'Findings vary under recorded conditions' };

export function PracticeProgress() {
  const [data, setData] = useState<ProgressionResult | null>(null);
  const [scenarios, setScenarios] = useState<PublicScenario[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState(''); const [catalogError, setCatalogError] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  const load = useCallback((competencies: string[], updateUrl = false) => {
    activeRequest.current?.abort(); const controller = new AbortController(); activeRequest.current = controller;
    setLoading(true); setError('');
    const query = new URLSearchParams(); competencies.forEach(id => query.append('competency', id));
    return ensureIdentity().then(async () => {
      if (controller.signal.aborted) return;
      const result = await api<ProgressionResult>(`/progress${query.size ? `?${query}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setData(result); setSelected(result.studyPlan.selectedCompetencies);
      if (updateUrl) {
        const url = new URL(window.location.href); url.searchParams.delete('competency');
        result.studyPlan.selectedCompetencies.forEach(id => url.searchParams.append('competency', id));
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, []);
  const loadCatalog = useCallback((signal?: AbortSignal) => api<ScenarioResponse>('/scenarios', { signal }).then(result => {
    if (!signal?.aborted) { setScenarios(result.scenarios); setCatalogError(''); setCatalogLoading(false); }
  }).catch((e: Error) => { if (!signal?.aborted) { setCatalogError(e.message); setCatalogLoading(false); } }), []);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    const bookmarked = new URLSearchParams(window.location.search).getAll('competency');
    void Promise.resolve().then(() => {
      if (!active) return;
      setSelected(bookmarked);
      if (bookmarked.length > 20) { setError('Choose no more than 20 practice goals. Clear the selection to start again.'); setLoading(false); }
      else void load(bookmarked);
    });
    void loadCatalog(controller.signal);
    return () => { active = false; controller.abort(); activeRequest.current?.abort(); };
  }, [load, loadCatalog]);
  const goalMap = new Map<string, { id: string; name: string }>();
  scenarios.forEach(scenario => scenario.rubric.forEach(criterion => goalMap.set(criterion.id, { id: criterion.id, name: criterion.name })));
  data?.skills.forEach(skill => { if (!goalMap.has(skill.id)) goalMap.set(skill.id, { id: skill.id, name: skill.name }); });
  data?.details.unobserved.forEach(skill => { if (!goalMap.has(skill.id)) goalMap.set(skill.id, { id: skill.id, name: skill.name }); });
  const goals = [...goalMap.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const unknownSelection = selected.filter(id => !goalMap.has(id));
  const applied = data?.studyPlan.selectedCompetencies || [];
  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...applied].sort());
  function clear() { setSelected([]); void load([], true); }
  return <section className="progression-page"><div className="page-heading"><div><h1>Your practice progress</h1><p>Recorded observations and a short plan for the next practice session.</p></div><Link className="button" href="/interview-practice">Browse practice <ArrowRight size={16} /></Link></div><div className="progress-explanation"><h2>Read findings with their evidence</h2><p>Findings describe individual attempts. Fresh tasks, repeated tasks, assistance, and assessment sources stay visible. Accessibility conditions and help receive no score penalty. This view does not estimate mastery or interview outcomes.</p></div>
    <details className="progression-goals"><summary>Choose practice goals (optional){applied.length ? ` · ${plural(applied.length, 'selected criterion')}` : ''}</summary><p>Choose up to 20 authored criteria to guide the plan. Selecting a goal does not imply a weakness. Goals are saved in this page’s URL.</p>{catalogLoading && <Loading>Loading available criteria…</Loading>}{catalogError && <ErrorNotice message={`Goal choices could not load: ${catalogError}`} action={<button className="text-button" onClick={() => void loadCatalog()}>Retry goal choices</button>} />}<form onSubmit={event => { event.preventDefault(); void load(selected, true); }}><fieldset disabled={loading} className="progression-goal-options"><legend className="sr-only">Practice criteria</legend>{goals.map(goal => <label key={goal.id}><input type="checkbox" checked={selected.includes(goal.id)} disabled={!selected.includes(goal.id) && selected.length >= 20} onChange={event => setSelected(current => event.target.checked ? [...current, goal.id] : current.filter(id => id !== goal.id))} /><span>{goal.name}</span></label>)}</fieldset>{!catalogLoading && !catalogError && goals.length === 0 && <p className="muted">No authored criteria are available yet.</p>}{unknownSelection.length > 0 && <p className="muted">This URL includes {plural(unknownSelection.length, 'criterion')} outside the available choices. Clear the selection if the server cannot validate it.</p>}<div className="progression-actions"><button className="button primary" disabled={loading || selected.length > 20 || (!dirty && !error)}>{loading ? 'Updating plan…' : 'Apply goals'}</button><button type="button" className="button" disabled={loading || (!selected.length && !applied.length)} onClick={clear}>Clear goals</button><span className="muted" aria-live="polite">{selected.length} of 20 selected</span></div></form></details>
    {error && <ErrorNotice message={error} action={<><button className="button" disabled={loading} onClick={() => void load(selected)}>Try again</button><button className="button" disabled={loading} onClick={clear}>Clear selection and reload</button></>} />}{loading && <Loading>Loading practice observations and study plan…</Loading>}
    {!loading && !error && data && <><dl className="progression-summary" aria-label="Recorded practice counts"><div><dt>Saved attempts</dt><dd>{data.details.attempts}</dd></div><div><dt>Attempts with completed reports</dt><dd>{data.details.assessedAttempts}</dd></div><div><dt>Observed criteria</dt><dd>{data.skills.length}</dd></div><div><dt>Unique evidence references</dt><dd>{data.details.evidenceCount}</dd></div></dl><StudyPlan plan={data.studyPlan} />{data.details.originalReportsSuperseded > 0 && <p className="progression-correction-note">{plural(data.details.originalReportsSuperseded, 'earlier report')} superseded by a newer publication. Each attempt contributes at most one finding per criterion; corrections keep the original observation date.</p>}
      <section className="progression-observations"><h2>Observed criteria</h2><p className="muted">Open a criterion to compare the recorded conditions and inspect the source attempt.</p>{data.skills.map(skill => <SkillHistory key={skill.id} skill={skill} />)}{data.skills.length === 0 && <div className="progression-no-observations"><h3>{data.studyPlan.status === 'cold-start' ? 'No completed observations yet' : 'No usable observed findings yet'}</h3><p>{data.studyPlan.status === 'cold-start' ? 'Complete an attempt and its debrief to collect your first observations.' : 'A completed report can contain findings marked Not observed. Missing evidence is not a weakness.'}</p><Link className="text-button" href="/history">Review your saved attempts <ArrowRight size={14} /></Link></div>}{data.details.unobserved.length > 0 && <details className="progression-unobserved"><summary>Criteria marked Not observed ({data.details.unobserved.length})</summary><p>These are missing observations, not low skill findings. They do not count toward the observed-criteria profile.</p><ul>{data.details.unobserved.map(item => <li key={item.id}><strong>{item.name}</strong> · {plural(item.attempts, 'attempt')} · Last attempt {formatDate(item.lastAttemptAt)}</li>)}</ul></details>}</section><OtherPractice data={data} /><details className="progression-method"><summary>How this view is assembled</summary><p>The latest published report for each completed attempt contributes at most one evidence-linked finding per criterion. Tasks retain their original rubric versions. Related-task matching guides practice and does not combine different rubrics into one scale.</p><p>{plural(data.details.ignoredFindings, 'finding')} excluded because the criterion or evidence references could not be used. Completing a drill is self-report and adds no skill observation.</p><p>Plan policy: {data.studyPlan.policyVersion}. There is no aggregate readiness score.</p></details></>}
  </section>;
}

function StudyPlan({ plan }: { plan: ProgressionResult['studyPlan'] }) {
  const title = plan.status === 'cold-start' ? 'Start collecting practice evidence' : plan.status === 'catalog-limited' ? 'Practice while the catalog grows' : 'Your next practice steps';
  return <section className="progression-plan" aria-labelledby="study-plan-heading"><div className="progression-section-heading"><h2 id="study-plan-heading">{title}</h2><span className="muted">{plan.status === 'cold-start' ? 'Getting started' : plan.status === 'catalog-limited' ? 'Limited unseen-task coverage' : 'Provisional plan'}</span></div><p>{plan.explanation}</p><ol className="progression-step-list">{plan.steps.slice(0, 3).map((step, index) => <StudyPlanStep key={step.id} step={step} number={index + 1} />)}</ol>{plan.steps.length === 0 && <p className="muted">No authored practice step is available yet. Your saved attempts remain available in History.</p>}{plan.limitations.length > 0 && <details className="progression-limitations"><summary>Plan limits and available resources</summary><ul>{plan.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}</section>;
}

function StudyPlanStep({ step, number }: { step: StudyStep; number: number }) {
  return <li className="progression-step"><span className="progression-step-number" aria-hidden="true">{number.toString().padStart(2, '0')}</span><div className="progression-step-copy"><p className="progression-step-kind">{step.kind === 'scenario' ? `${step.fresh ? 'Unseen task' : 'Repeat practice'} · ${step.estimatedMinutes} min` : step.kind === 'drill' ? `Focused drill · ${step.completedSelfReport ? 'Completion self-reported' : 'Original exercise'}` : `Foundry lesson reference · ${step.estimatedMinutes} min`}</p><h3>{step.title}</h3><p>{step.reason}</p>{step.kind === 'scenario' && <p className="muted">Scenario version {step.version}{!step.fresh && ' · Familiarity remains recorded; this repeat cannot establish fresh-task transfer.'}</p>}{step.kind === 'drill' && <details className="progression-drill"><summary>Review the original drill</summary><p className="muted">Original scenario version {step.scenarioVersion}. Completion is self-report and adds no observed finding.</p><h4>Lesson</h4><p>{step.lesson}</p><h4>Exercise</h4><p>{step.exercise}</p></details>}{step.kind === 'lesson' && <><p className="progression-resource-state">Navigation unavailable in this app · Foundry integration pending</p><details><summary>Source reference</summary><code>{step.foundryPath}</code></details></>}</div>{step.kind !== 'lesson' && <Link className="button" href={step.href}>{step.kind === 'scenario' ? 'Set up practice' : 'Open source attempt'} <ArrowRight size={16} /></Link>}</li>;
}

function SkillHistory({ skill }: { skill: SkillProgress }) {
  return <details className="progression-skill"><summary><span><strong>{skill.name}</strong><span className="progression-latest">Latest finding: {skill.level}</span></span><span className="progression-skill-count">{plural(skill.observations, 'observation')} · {plural(skill.evidenceCount, 'evidence reference')}<span>Last observed <time dateTime={skill.lastObservedAt}>{formatDate(skill.lastObservedAt)}</time></span></span></summary><div className="progression-skill-content"><dl className="progression-conditions"><div><dt>Fresh-task observations</dt><dd>{skill.freshObservations}</dd></div><div><dt>Repeat-task observations</dt><dd>{skill.repeatedObservations}</dd></div><div><dt>Distinct tasks</dt><dd>{skill.distinctScenarios}</dd></div><div><dt>Observations with help received</dt><dd>{skill.helpReceivedObservations}</dd></div></dl><p className="progression-coverage">{skill.evidenceStatus === 'limited' ? 'Limited evidence coverage' : 'Evidence from multiple fresh tasks'} · {consistencyName[skill.consistency.status]}</p><ul className="progression-skill-limits">{skill.limitations.map(item => <li key={item}>{item}</li>)}</ul><div className="progression-history">{[...skill.history].reverse().map(observation => <Observation key={`${observation.sessionId}:${observation.reportId}`} observation={observation} />)}</div></div></details>;
}

function Observation({ observation }: { observation: SkillObservation }) {
  const conditions = observation.conditions;
  return <article className="progression-observation"><div className="progression-section-heading"><h4><time dateTime={observation.observedAt}>{formatDate(observation.observedAt)}</time> · {observation.level}</h4><Link className="text-button" aria-label={`Review ${observation.scenarioId} attempt from ${formatDate(observation.observedAt)}`} href={`/interview-practice/${encodeURIComponent(observation.sessionId)}`}>Review attempt <ArrowRight size={14} /></Link></div><p>{observation.scenarioId} · Scenario {observation.scenarioVersion} · {conditions.exposure === 'fresh' ? 'Fresh task' : 'Repeated task'} · {conditions.mode === 'practice' ? 'Practice' : 'Simulation'}</p><p>{conditions.helpReceived ? 'Help received' : 'No help recorded'} · AI help {conditions.aiHelpAllowed ? 'permitted' : 'disabled'} · {assessmentName(observation.assessmentSource)}{observation.corrected ? ' · Corrected report' : ''}</p><p className="muted">{plural(observation.evidenceIds.length, 'supporting evidence reference')} · {observation.confidence} confidence</p><details className="progression-provenance"><summary>Evidence and assessment details</summary><dl className="progression-provenance-list"><div><dt>Assistance recorded</dt><dd>{plural(conditions.assistantRequests, 'assistant request')}; {plural(conditions.assistantResponses, 'assistant response')}; {plural(conditions.acceptedEdits, 'accepted edit')}; {conditions.hintsOpened} hints opened</dd></div><div><dt>Accessibility conditions</dt><dd>{conditions.accommodationCount ? `${plural(conditions.accommodationCount, 'accommodation')} configured; no penalty applied.` : 'No accommodations recorded.'}</dd></div><div><dt>Rubric / assessment</dt><dd>{observation.rubricVersion} · {observation.model} · {observation.promptVersion}</dd></div><div><dt>Published report</dt><dd>{observation.reportId}</dd></div><div><dt>Evidence references in the source report</dt><dd>{observation.evidenceIds.join(', ')}</dd></div></dl><p className="muted">Open the source attempt to inspect its report and recorded evidence. If it has report versions, choose the publication listed above.</p></details></article>;
}

function OtherPractice({ data }: { data: ProgressionResult }) {
  const planned = new Set(data.studyPlan.steps.filter(step => step.kind === 'scenario').map(step => step.scenarioId));
  const others = data.recommendations.filter(item => !planned.has(item.scenarioId));
  if (!others.length) return null;
  return <details className="progression-other"><summary>Other available practice ({others.length})</summary>{others.map(item => <article key={`${item.scenarioId}:${item.version}`}><div><h3>{item.title}</h3><p>{item.reason}</p><p className="muted">{item.fresh ? 'Unseen task' : 'Repeat practice'} · {item.durationMinutes} min · Version {item.version}</p></div><Link className="button" href={item.href}>Set up practice <ArrowRight size={16} /></Link></article>)}</details>;
}
