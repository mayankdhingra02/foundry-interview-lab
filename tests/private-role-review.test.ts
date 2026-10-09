import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../lib/interview-practice/domain';
import { createPrivateJson, readPrivateJson } from '../evals/private-corpus';
import { recordPrivateRoleRun, type PrivateRoleRun } from '../evals/private-role-runner';
import { privateReviewPackets, privateRoleAnnotationTemplate, scorePrivateRoleReview, type PrivateRoleAnnotations } from '../evals/private-role-review';
import { unitPrivateCorpus, unitPrivateLabels, unitPrivateOptions } from './private-role-fixtures';

const directories: string[] = []; let context: { corpus: ReturnType<typeof unitPrivateCorpus> }, run: PrivateRoleRun;
beforeEach(async () => { vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400'); vi.stubEnv('OPENAI_API_KEY', ''); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External calls forbidden.'); })); context = { corpus: unitPrivateCorpus() }; run = await recordPrivateRoleRun(context, unitPrivateOptions()); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function hypotheticalAnnotations(): PrivateRoleAnnotations {
  const result = privateRoleAnnotationTemplate(run, context);
  for (const row of result.cases) {
    const labels = unitPrivateLabels(run.entries.find(entry => entry.caseId === row.caseId && entry.role === row.role)!);
    row.reviews = ['hypothetical-a', 'hypothetical-b'].map((reviewerId, index) => ({ reviewerId, independent: true, candidateIdentityHidden: true, peerReviewsHidden: true, packetDigest: row.packetDigest, completedAt: `2026-10-09T14:0${index}:00.000Z`, labels: structuredClone(labels) }));
    row.adjudication = { adjudicatorId: 'hypothetical-third-adjudicator', reviewerIds: ['hypothetical-a', 'hypothetical-b'], completedAt: '2026-10-09T15:00:00.000Z', labels: structuredClone(labels) };
  }
  return result;
}
describe('private role blind review and independent adjudication', () => {
  it('exports metadata-blind faithful packets and blank labels without inventing reviewers', () => {
    const packets = privateReviewPackets(run, context), template = privateRoleAnnotationTemplate(run, context);
    expect(packets.packets).toHaveLength(5); expect(template.cases.every(row => !row.reviews.length && row.adjudication === null)).toBe(true);
    for (const packet of packets.packets) { const { packetDigest, ...body } = packet; expect(packetDigest).toBe(digest(body)); expect(packet.labels).toBeNull(); expect('referenceFiles' in packet.context.scenario).toBe(false); expect(packet.context.scenario.tests.filter(test => !test.visible).every(test => !('source' in test))).toBe(true); }
    const serialized = JSON.stringify(packets); for (const hidden of ['gpt-5.4-mini', 'unit-mocked-model', 'hypothetical-not-a-provider-response', 'knownUsd', 'requestedModel', 'unit-model-operator']) expect(serialized).not.toContain(hidden);
    const score = scorePrivateRoleReview(run, template, context); expect(score.status).toBe('pending'); expect(score.coverage.reviewed).toBe(0); expect(score.metrics.coach.claimSupport.value).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it('computes separate denominators from complete hypothetical labels without approving release or holdout custody', () => {
    const score = scorePrivateRoleReview(run, hypotheticalAnnotations(), context);
    expect(score).toMatchObject({ status: 'reviewed', corpus: { split: 'acceptance' }, qualification: 'not-established', coverage: { planned: 5, reviewed: 5, adjudicated: 5 } });
    expect(score.metrics.coach.rubricWithinOneBand.denominator).toBe(1); expect(score.metrics['assistant-edit'].correctness.denominator).toBe(1);
    expect(score.byScenario[context.corpus.cases[0].scenarioId].reviewed).toBe(5); expect(JSON.stringify(score)).not.toContain('Hypothetical unit labels'); expect(JSON.stringify(score)).not.toContain('hypothetical-a');
  });
  it('requires two distinct blind independent reviewers, excluding the model operator and source preparer/custodian', () => {
    for (const reviewerId of ['hypothetical-a', ' HYPOTHETICAL-A ', run.operatorId, context.corpus.independence.custodianId, context.corpus.cases[0].source.preparedBy]) {
      const labels = hypotheticalAnnotations(); labels.cases[0].reviews[1].reviewerId = reviewerId; expect(() => scorePrivateRoleReview(run, labels, context)).toThrow();
    }
    for (const field of ['independent', 'candidateIdentityHidden', 'peerReviewsHidden'] as const) { const labels = hypotheticalAnnotations(); (labels.cases[0].reviews[0] as unknown as Record<string, unknown>)[field] = false; expect(() => scorePrivateRoleReview(run, labels, context)).toThrow(); }
    const one = hypotheticalAnnotations(); one.cases[0].reviews.pop(); one.cases[0].adjudication = null; expect(scorePrivateRoleReview(run, one, context).status).toBe('pending');
  });
  it('requires exact matching packet and candidate/context/corpus/version/run bindings', () => {
    for (const field of ['caseDigest', 'candidateDigest', 'contextDigest', 'privateContextDigest', 'inputContextDigest', 'executionDigest', 'runtimeBindingDigest', 'scenarioDigest', 'evidenceDigest', 'packetDigest'] as const) { const labels = hypotheticalAnnotations(); labels.cases[0][field] = 'a'.repeat(64); expect(() => scorePrivateRoleReview(run, labels, context)).toThrow('binding'); }
    const changed = hypotheticalAnnotations(); changed.cases[0].reviews[0].packetDigest = 'a'.repeat(64); expect(() => scorePrivateRoleReview(run, changed, context)).toThrow('packet');
    for (const field of ['corpusDigest', 'runDigest', 'planDigest'] as const) { const labels = hypotheticalAnnotations(); labels[field] = 'a'.repeat(64); expect(() => scorePrivateRoleReview(run, labels, context)).toThrow('binding'); }
    const split = hypotheticalAnnotations(); split.corpus.split = 'holdout'; expect(() => scorePrivateRoleReview(run, split, context)).toThrow('binding');
    const duplicate = hypotheticalAnnotations(); duplicate.cases.push(duplicate.cases[0]); expect(() => scorePrivateRoleReview(run, duplicate, context)).toThrow('unique');
  });
  it('requires correct chronology, exact reviewer-pair adjudication and a third adjudicator', () => {
    for (const change of [
      (labels: PrivateRoleAnnotations) => { labels.cases[0].reviews[0].completedAt = '2026-10-09T12:00:00.000Z'; },
      (labels: PrivateRoleAnnotations) => { labels.cases[0].adjudication!.completedAt = '2026-10-09T14:00:30.000Z'; },
      (labels: PrivateRoleAnnotations) => { labels.cases[0].adjudication!.reviewerIds[1] = 'unknown'; },
      (labels: PrivateRoleAnnotations) => { labels.cases[0].adjudication!.adjudicatorId = 'hypothetical-a'; },
    ]) { const labels = hypotheticalAnnotations(); change(labels); expect(() => scorePrivateRoleReview(run, labels, context)).toThrow(); }
    for (const adjudicatorId of [run.operatorId, context.corpus.independence.custodianId, context.corpus.cases[0].source.preparedBy]) { const labels = hypotheticalAnnotations(); labels.cases[0].adjudication!.adjudicatorId = adjudicatorId; expect(() => scorePrivateRoleReview(run, labels, context)).toThrow('independent'); }
  });
  it('keeps missing observations/role labels and unresolved disagreements pending with zero denominators', () => {
    const labels = hypotheticalAnnotations(), coach = labels.cases.find(row => row.role === 'coach')!, assistant = labels.cases.find(row => row.role === 'assistant-edit')!;
    coach.reviews[0].labels.fabricatedExecution = null; if (coach.reviews[0].labels.kind === 'coach') coach.reviews[0].labels.rubric.pop();
    if (assistant.adjudication!.labels.kind === 'assistant') assistant.adjudication!.labels.correctnessBasis = 'not-observed';
    const score = scorePrivateRoleReview(run, labels, context); expect(score.status).toBe('pending'); expect(score.metrics.coach.rubricWithinOneBand.value).toBeNull(); expect(score.metrics['assistant-edit'].correctness.value).toBeNull();
    const disagreement = hypotheticalAnnotations(); disagreement.cases[0].reviews[0].labels.claims.push({ id: 'additional-claim', support: 'unsupported', fabricatedExecution: false, criticalSolutionLeak: false });
    expect(scorePrivateRoleReview(run, disagreement, context).cases[0]).toMatchObject({ status: 'pending', disagreements: 1 });
    disagreement.cases[0].adjudication!.labels.claims.push({ id: 'additional-claim', support: 'unsupported', fabricatedExecution: false, criticalSolutionLeak: false });
    expect(scorePrivateRoleReview(run, disagreement, context).metrics.interviewer.claimSupport).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it('blocks any independent fabricated-execution or critical-solution-leak flag even if adjudication removes it', () => {
    for (const field of ['fabricatedExecution', 'criticalSolutionLeak'] as const) { const labels = hypotheticalAnnotations(); labels.cases[0].reviews[0].labels[field] = true; const score = scorePrivateRoleReview(run, labels, context); expect(score.status).toBe('blocked'); expect(score.blockingReasons).toHaveLength(1); }
  });
  it('never infers quality for missing/reserved/uncertain/rejected tasks or all-unobserved coaching', async () => {
    const incomplete = structuredClone(run); incomplete.state = 'running'; incomplete.entries.pop(); const template = privateRoleAnnotationTemplate(incomplete, context), score = scorePrivateRoleReview(incomplete, template, context); expect(score.status).toBe('pending'); expect(score.coverage.rejectedOrIncomplete).toBe(1);
    const unknown = hypotheticalAnnotations(), coach = unknown.cases.find(row => row.role === 'coach')!; for (const labels of [...coach.reviews.map(review => review.labels), coach.adjudication!.labels]) if (labels.kind === 'coach') labels.rubric.forEach(row => { row.level = 'Not observed'; });
    expect(scorePrivateRoleReview(run, unknown, context).metrics.coach.unsupportedObservedRatings).toBe(1);
    const wrongRole = hypotheticalAnnotations(); wrongRole.cases[0].reviews[0].labels = unitPrivateLabels(run.entries.find(row => row.role === 'coach')!); expect(() => scorePrivateRoleReview(run, wrongRole, context)).toThrow('another role');
  });
  it('runs the private CLI offline with no-action default, exclusive blind packet/template outputs and closed paid gates', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'foundry-private-model-cli-')); directories.push(directory);
    const manifest = join(directory, 'corpus.json'), artifact = join(directory, 'run.json'), output = join(directory, 'packets.json'); await createPrivateJson(manifest, context.corpus); await createPrivateJson(artifact, run);
    const exec = promisify(execFile), execute = (args: string[]) => exec(process.execPath, ['--conditions=react-server', '--import=tsx', 'scripts/private-model-evaluation.ts', ...args], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: '', FOUNDRY_PRIVATE_MODEL_RECORD: '' }, maxBuffer: 100_000 });
    expect((await execute([])).stdout).toContain('Default: no action'); const planned = JSON.parse((await execute(['--corpus', manifest])).stdout); expect(planned).toMatchObject({ providerCalls: 0, plannedCalls: 5, qualification: 'not-established' });
    await execute(['--corpus', manifest, '--run', artifact, '--packets', '--output', output]); expect((await readPrivateJson(output) as { packets: unknown[] }).packets).toHaveLength(5); await expect(execute(['--corpus', manifest, '--run', artifact, '--packets', '--output', output])).rejects.toThrow();
    const template = join(directory, 'reviews.json'); await execute(['--corpus', manifest, '--run', artifact, '--template', '--output', template]); expect((await readPrivateJson(template) as PrivateRoleAnnotations).cases[0].reviews).toEqual([]);
    const result = JSON.parse((await execute(['--corpus', manifest, '--run', artifact, '--reviews', template])).stdout); expect(result.status).toBe('pending');
    await expect(execute(['--corpus', manifest, '--record', '--acknowledge-paid-api', '--operator', 'unit-model-operator', '--max-usd', '1', '--output', join(directory, 'never-created')])).rejects.toThrow(); await expect(lstat(join(directory, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});
