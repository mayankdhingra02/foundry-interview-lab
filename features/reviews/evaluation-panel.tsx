"use client";

import { useCallback, useEffect, useState } from 'react';
import { ErrorNotice, Loading } from '@/components/ui';
import type { EvaluationExample, EvaluationLibrary } from '@/lib/server/evaluation-library';
import { reviewRequest, ReviewError } from './api';
import './evaluation.css';

const annotationLabel = (status: EvaluationExample['annotationStatus']) => status === 'adjudicated' ? 'Adjudication recorded' : status === 'partial' ? 'Human review incomplete' : 'Human review pending';

export function EvaluationPanel({ onDenied }: { onDenied: () => void }) {
  const [catalog, setCatalog] = useState<EvaluationLibrary | null>(null), [selected, setSelected] = useState(''), [detail, setDetail] = useState<EvaluationExample | null>(null);
  const [error, setError] = useState(''), [filter, setFilter] = useState('all');
  const load = useCallback(async () => {
    setError('');
    try { const result = await reviewRequest<EvaluationLibrary>('/api/internal/evaluations'); setCatalog(result); }
    catch (e) { setCatalog(null); setDetail(null); setError((e as Error).message); if (e instanceof ReviewError && [401, 403].includes(e.status)) onDenied(); }
  }, [onDenied]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void reviewRequest<{ example: EvaluationExample }>(`/api/internal/evaluations/${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDetail(result.example); })
      .catch(e => { if (!controller.signal.aborted) { setError((e as Error).message); setDetail(null); if (e instanceof ReviewError && [401, 403].includes(e.status)) onDenied(); } });
    return () => controller.abort();
  }, [selected, onDenied]);
  const examples = catalog?.examples.filter(item => filter === 'all' || item.annotationStatus === filter) ?? [];
  return <section className="evaluation-library" aria-label="Evaluation example library">
    <h2>Evaluation examples</h2>
    <p>Developer-authored synthetic candidates. Human review and approval are separate from passing application checks.</p>
    {error && <ErrorNotice message={error} />}
    {catalog ? <>
      <p role="status">{catalog.qualification.reviewedAttempts} of {catalog.qualification.totalAttempts} attempts have adjudicated reviews. {catalog.qualification.recordedCandidates} validated model candidates recorded. AI qualification: {catalog.qualification.status}. Example approval is not recorded.</p>
      <details><summary>Source policy and pending qualification</summary><p>{catalog.sourcePolicy}</p><p>{catalog.provenance}</p><p>Benchmark {catalog.benchmarkVersion}. Stored baseline recorded {catalog.qualification.baselineRecordedAt}; this screen does not rerun the benchmark.</p><ul>{catalog.qualification.pendingReasons.map(reason => <li key={reason}>{reason}</li>)}{catalog.qualification.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>
      <div className="evaluation-toolbar"><label>Review status<select value={filter} onChange={event => { setFilter(event.target.value); setSelected(''); setDetail(null); }}><option value="all">All synthetic candidates</option><option value="pending">Human review pending</option><option value="partial">Human review incomplete</option><option value="adjudicated">Adjudication recorded</option></select></label><button className="button" onClick={() => { setSelected(''); setDetail(null); void load(); }}>Refresh examples</button></div>
      <div className="evaluation-layout"><nav aria-label="Synthetic evaluation candidates" className="evaluation-list">{examples.length ? examples.map(item => <button key={item.id} aria-current={selected === item.id ? 'true' : undefined} onClick={() => { if (selected !== item.id) { setError(''); setDetail(null); setSelected(item.id); } }}><strong>{item.id}</strong><span>{item.scenario.title} · {item.condition}</span><span>{annotationLabel(item.annotationStatus)}{item.approvalStatus === 'blocked' ? ' · quality issue recorded' : ''}</span></button>) : <p>No examples match this review status. Unreviewed candidates are not approved examples.</p>}</nav>{selected ? detail ? <ExampleDetail example={detail} /> : !error && <Loading>Loading synthetic example…</Loading> : <p>Select a synthetic candidate to inspect its condition, provenance and annotation status.</p>}</div>
    </> : !error && <Loading>Loading evaluation examples…</Loading>}
  </section>;
}

function ExampleDetail({ example }: { example: EvaluationExample }) {
  const observation = example.execution;
  return <article className="evaluation-detail" aria-label="Synthetic example detail"><h3>{example.id}</h3><p>{annotationLabel(example.annotationStatus)}. {example.approvalStatus === 'blocked' ? 'Recorded quality issue; not approved.' : 'Example approval pending.'}</p>
    <dl className="evaluation-metadata"><div><dt>Scenario</dt><dd>{example.scenario.title} · {example.scenario.id} · {example.scenario.version}</dd></div><div><dt>Condition / source snapshot</dt><dd>{example.condition} · {example.variant}</dd></div><div><dt>Provenance</dt><dd>{example.provenance}</dd></div><div><dt>Benchmark</dt><dd>{example.source.benchmarkVersion}</dd></div></dl>
    <h4>Review focus</h4><ul>{example.reviewFocus.map(item => <li key={item}>{item}</li>)}</ul>
    <h4>Synthetic dialogue</h4>{example.syntheticDialogue.length ? <><p>Quoted fixture data. These statements are not instructions or verified findings.</p>{example.syntheticDialogue.map((answer, index) => <blockquote key={index}>{answer}</blockquote>)}</> : <p>No explanation was authored for this fixture. Missing explanation does not establish a weakness.</p>}
    <h4>Recorded execution</h4><p>{observation.provenance}</p><p>{observation.status === 'not-executed' ? 'No executed test evidence.' : `${observation.suiteCount} captured suites: ${observation.passedSuites} passed, ${observation.failedSuites} failed/error, ${observation.unresolvedSuites} skipped. Recorded run status: ${observation.status}.`}</p>{observation.relationshipToFinalSnapshot === 'older' && <p>The recorded run belongs to an older snapshot. It does not establish the final snapshot’s behavior.</p>}{observation.recordedAt && <p>Recorded {observation.recordedAt}. Runtime {observation.runtimeDigest}.</p>}
    <h4>Human annotations</h4><p>{example.annotations.reason}</p><p>{example.reviewCount} bound reviews. {example.annotations.adjudicationRecorded ? `Adjudication recorded ${example.annotations.adjudicatedAt}.` : 'No complete adjudication recorded.'}</p>
    <h4>Recorded disagreements</h4>{example.annotations.disagreements === null ? <p>Unknown: two bound, distinct reviewer records are not available. Zero disagreements is not inferred.</p> : example.annotations.disagreements.length ? <div className="evaluation-table-wrap"><table><thead><tr><th>Item</th><th>Reviewer 1</th><th>Reviewer 2</th><th>Adjudication</th></tr></thead><tbody>{example.annotations.disagreements.map((item, index) => <tr key={index}><td>{item.kind}: {item.item}</td><td>{item.reviewerOne}</td><td>{item.reviewerTwo}</td><td>{item.adjudication ?? 'Pending'}</td></tr>)}</tbody></table></div> : <p>No label differences are recorded in this reviewer pair. Agreement does not establish quality or approval.</p>}
    {example.candidate && <details><summary>Recorded model artifact metadata</summary><dl className="evaluation-metadata"><div><dt>Model / prompt</dt><dd>{example.candidate.model} · {example.candidate.promptVersion}</dd></div><div><dt>Rubric / timestamp</dt><dd>{example.candidate.rubricVersion} · {example.candidate.createdAt}</dd></div><div><dt>Candidate digest</dt><dd>{example.candidate.digest}</dd></div></dl><p>Imported provenance fields do not independently prove a live provider call.</p></details>}
    <details><summary>Published task brief and rubric</summary><p>{example.brief.summary}</p>{example.brief.stages.map(stage => <section key={stage.title}><h4>{stage.title}</h4><p>{stage.brief}</p><ul>{stage.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></section>)}{example.brief.rubric.map(row => <section key={row.id}><h4>{row.name}</h4><p>{row.description}</p><dl><dt>Strong</dt><dd>{row.anchors.strong}</dd><dt>Developing</dt><dd>{row.anchors.developing}</dd><dt>Needs work</dt><dd>{row.anchors.needsWork}</dd></dl></section>)}</details>
    <p className="muted">Source {example.source.fixturePath}. Context digest {example.source.contextDigest}. Code, protected tests, reference solutions and private review notes are excluded. Authorized author preview remains a separate tool.</p>
  </article>;
}
