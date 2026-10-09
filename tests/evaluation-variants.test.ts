import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import recipes from '../evals/fixtures/attempts.json';
import captureFile from '../evals/fixtures/runtime-observations.json';
import annotations from '../evals/fixtures/human-review.template.json';
import baseline from '../evals/fixtures/baseline-summary.json';
import { attemptContextDigest, conservativeReport, materializeAttempt, runtimeCaptureDigest, type AttemptRecipe, type RuntimeCapture } from '../evals/benchmark';
import { digest } from '../lib/interview-practice/domain';
import { validateReport } from '../lib/interview-practice/evidence';
import { buildEvaluationRepository } from '../lib/server/evaluation-library';

const capture = captureFile as RuntimeCapture;
const recipe = (id: string): AttemptRecipe => structuredClone(recipes.cases.find(row => row.id === id) as AttemptRecipe);
const customIds = ['money-partial-rounding', 'compatibility-alternative-unexecuted', 'inventory-interrupted-before-run', 'rollup-interrupted-during-run'];
function recalculate(row: AttemptRecipe) { row.snapshot!.sha256 = digest(row.snapshot!.files); return row; }
function capturedCustom() {
  const original = materializeAttempt(recipe('money-reference'), capture), record = capture.captures.find(row => row.scenarioId === original.scenario.id && row.variant === 'reference')!;
  const row: AttemptRecipe = { id: 'custom-explicit-capture-unit-only', scenarioId: original.scenario.id, scenarioVersion: original.scenario.version, variant: 'custom', condition: 'unit-only', answers: [], reviewFocus: [], snapshot: { version: '1.0.0', files: structuredClone(original.scenario.referenceFiles), sha256: digest(original.scenario.referenceFiles) }, execution: { kind: 'captured', captureDigest: runtimeCaptureDigest(record) } };
  return { row, record };
}

describe('versioned benchmark attempt variants', () => {
  it('adds a small honest custom corpus while keeping only ten actual captured snapshots', () => {
    expect(recipes.cases).toHaveLength(21); expect(capture.captures).toHaveLength(10);
    const attempts = customIds.map(id => materializeAttempt(recipe(id), capture));
    expect(attempts.every(row => row.recipe.variant === 'custom' && row.fixtureIdentity.version === '1.0.0')).toBe(true);
    expect(new Set(attempts.map(row => row.fixtureIdentity.digest)).size).toBe(4);
    for (const attempt of attempts) {
      expect(attempt.session.files).toEqual(attempt.recipe.snapshot!.files);
      expect(attempt.fixtureIdentity.snapshotSha256).toBe(digest(attempt.session.files));
      expect(attempt.capturedExecution).toBe(false); expect(attempt.session.runs).toEqual([]);
      expect(attempt.session.frozenEvidence!.items.some(row => row.kind === 'test')).toBe(false);
      expect(attempt.executionContext).toMatchObject({ provenance: 'developer-authored-state', captureDigest: null });
      expect(annotations.cases.find(row => row.caseId === attempt.recipe.id)).toMatchObject({ candidateDigest: null, reviews: [], adjudication: null });
    }
  });
  it('preserves the partial implementation and intended alternative without claiming correctness', () => {
    const partial = materializeAttempt(recipe('money-partial-rounding'), capture), alternative = materializeAttempt(recipe('compatibility-alternative-unexecuted'), capture);
    expect(partial.session.files['quote.py']).toContain('validation is unfinished');
    expect(partial.session.files).not.toEqual(partial.scenario.files); expect(partial.session.files).not.toEqual(partial.scenario.referenceFiles);
    expect(alternative.session.files['exporter.py']).toContain('csv.DictWriter');
    expect(alternative.session.files).not.toEqual(alternative.scenario.referenceFiles);
    expect(alternative.recipe.answers[0]).toContain('has not been executed or independently reviewed');
    expect(conservativeReport(alternative).rubric.every(row => row.level === 'Not observed')).toBe(true);
  });
  it('does not borrow a matching starter or reference capture for an interrupted attempt', () => {
    const before = materializeAttempt(recipe('inventory-interrupted-before-run'), capture), during = materializeAttempt(recipe('rollup-interrupted-during-run'), capture);
    expect(before.session.files).toEqual(before.scenario.files); expect(during.session.files).toEqual(during.scenario.referenceFiles);
    expect(before.executionContext).toMatchObject({ kind: 'interrupted', interruption: { phase: 'before-execution', reason: 'worker-restart' } });
    expect(during.executionContext).toMatchObject({ kind: 'interrupted', interruption: { phase: 'during-execution', reason: 'disconnect' } });
    for (const attempt of [before, during]) { expect(attempt.session.runs).toEqual([]); expect(attempt.session.jobs).toEqual([]); expect(attempt.session.usage.runs).toBe(0); }
  });
  it('requires a pinned scenario version, versioned files and explicit execution state for custom code', () => {
    for (const key of ['scenarioVersion', 'snapshot', 'execution'] as const) {
      const row = recipe('money-partial-rounding'); delete row[key];
      expect(() => materializeAttempt(row, capture)).toThrow('Custom fixtures require');
    }
    const stale = recipe('money-partial-rounding'); stale.scenarioVersion = '9.0.0'; expect(() => materializeAttempt(stale, capture)).toThrow('another scenario version');
    const wrongVariant = recipe('money-partial-rounding'); wrongVariant.variant = 'starter'; expect(() => materializeAttempt(wrongVariant, capture)).toThrow('must use the custom variant');
  });
  it('rejects changed custom content unless its declared digest is updated', () => {
    const changed = recipe('money-partial-rounding'); changed.snapshot!.files['quote.py'] += '\n# Later fixture edit\n';
    expect(() => materializeAttempt(changed, capture)).toThrow('snapshot digest does not match');
    const first = materializeAttempt(recipe('money-partial-rounding'), capture), next = materializeAttempt(recalculate(changed), capture);
    expect(next.fixtureIdentity.digest).not.toBe(first.fixtureIdentity.digest); expect(attemptContextDigest(next)).not.toBe(attemptContextDigest(first));
  });
  it('validates exact task paths and UTF-8 byte bounds before creating evidence', () => {
    const extra = recipe('money-partial-rounding'); extra.snapshot!.files['../secret.py'] = 'unsafe';
    expect(() => materializeAttempt(recalculate(extra), capture)).toThrow('exactly the scenario files');
    const missing = recipe('money-partial-rounding'); delete missing.snapshot!.files['quote.py'];
    expect(() => materializeAttempt(recalculate(missing), capture)).toThrow('exactly the scenario files');
    const oversized = recipe('money-partial-rounding'); oversized.snapshot!.files['quote.py'] = 'é'.repeat(32_001);
    expect(() => materializeAttempt(recalculate(oversized), capture)).toThrow('at most 64 KB');
    const nul = recipe('money-partial-rounding'); nul.snapshot!.files['quote.py'] += '\0';
    expect(() => materializeAttempt(recalculate(nul), capture)).toThrow('at most 64 KB');
  });
  it('prevents combining explicit states with ambiguous legacy transformations', () => {
    for (const extra of [{ omitRun: false }, { changeAfterRun: true }, { edit: 'accepted-bad' as const }]) {
      const row = { ...recipe('money-partial-rounding'), ...extra }; expect(() => materializeAttempt(row, capture)).toThrow('legacy attempt transformations');
    }
  });
  it('binds an explicit real capture by immutable digest and exact file/scenario/suite identity', () => {
    const { row, record } = capturedCustom(), attempt = materializeAttempt(row, capture);
    expect(attempt.capturedExecution).toBe(true); expect(attempt.executionContext.captureDigest).toBe(runtimeCaptureDigest(record));
    expect(attempt.session.runs[0].tests).toEqual(record.run.tests);
    const changed = structuredClone(row); changed.snapshot!.files['quote.py'] += '\n# Different code\n'; recalculate(changed);
    expect(() => materializeAttempt(changed, capture)).toThrow('no longer matches');
    const absent = structuredClone(row); absent.execution = { kind: 'captured', captureDigest: '0'.repeat(64) };
    expect(() => materializeAttempt(absent, capture)).toThrow('digest was not found');
    expect(() => materializeAttempt(row, null)).toThrow('digest was not found');
  });
  it('rejects stale or ambiguous real capture metadata instead of choosing a broad variant', () => {
    const { row, record } = capturedCustom();
    for (const mutation of ['scenarioVersion', 'scenarioDigest', 'testSuiteDigest', 'runtimeDigest'] as const) {
      const changed = structuredClone(record);
      if (mutation === 'runtimeDigest') changed.run.runtimeDigest = 'unqualified'; else changed[mutation] = 'stale';
      const current = structuredClone(row); current.execution = { kind: 'captured', captureDigest: runtimeCaptureDigest(changed) };
      expect(() => materializeAttempt(current, { ...capture, captures: [changed] })).toThrow('no longer matches');
    }
    expect(() => materializeAttempt(row, { ...capture, captures: [record, structuredClone(record)] })).toThrow('identity is ambiguous');
    expect(() => materializeAttempt(row, { ...capture, provenance: 'synthetic' } as unknown as RuntimeCapture)).toThrow('actual isolated execution provenance');
    const legacy = recipe('money-reference'); expect(() => materializeAttempt(legacy, { ...capture, captures: [record, structuredClone(record)] })).toThrow('identity is ambiguous');
  });
  it('binds explicit no-execution and interruption context even with identical code and dialogue', () => {
    const row = recipe('inventory-interrupted-before-run'), interrupted = materializeAttempt(row, capture);
    const unexecuted = materializeAttempt({ ...row, execution: { kind: 'unexecuted' } }, capture);
    expect(interrupted.session.frozenEvidence!.digest).toBe(unexecuted.session.frozenEvidence!.digest);
    expect(attemptContextDigest(interrupted)).not.toBe(attemptContextDigest(unexecuted));
    const bumped = structuredClone(row); bumped.snapshot!.version = '1.0.1';
    const next = materializeAttempt(bumped, capture); expect(next.fixtureIdentity.snapshotSha256).toBe(interrupted.fixtureIdentity.snapshotSha256);
    expect(next.fixtureIdentity.digest).not.toBe(interrupted.fixtureIdentity.digest); expect(attemptContextDigest(next)).not.toBe(attemptContextDigest(interrupted));
  });
  it('copies custom payloads so materialized session edits cannot alter the fixture', () => {
    const row = recipe('money-partial-rounding'), original = structuredClone(row), attempt = materializeAttempt(row, capture);
    attempt.session.files['quote.py'] = 'changed session'; attempt.session.snapshots[0].files['quote.py'] = 'changed snapshot';
    expect(row).toEqual(original); expect(attempt.recipe.snapshot!.files).toEqual(original.snapshot!.files);
  });
  it('does not permit universal pass claims for either unexecuted or interrupted variants', () => {
    for (const id of customIds) {
      const attempt = materializeAttempt(recipe(id), capture), report = conservativeReport(attempt); report.overview = 'All tests passed.';
      expect(() => validateReport(report, attempt.scenario, attempt.session.frozenEvidence!)).toThrow('does not support');
    }
  });
  it('projects safe fixture identity and declared interruption metadata without custom code or test facts', () => {
    const sourceRecipes = structuredClone(recipes), custom = sourceRecipes.cases.find(row => row.id === 'money-partial-rounding')! as AttemptRecipe;
    custom.snapshot!.files['quote.py'] += '\n# PRIVATE-CUSTOM-FIXTURE-SENTINEL\n'; recalculate(custom);
    const result = buildEvaluationRepository({ recipes: sourceRecipes, capture, annotations, candidates: null, baseline });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-CUSTOM-FIXTURE-SENTINEL');
    const partial = result.details.find(row => row.id === custom.id)!;
    expect(partial.source).toMatchObject({ snapshotVersion: '1.0.0', snapshotSha256: custom.snapshot!.sha256, fixtureDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    for (const id of customIds.slice(2)) {
      const detail = result.details.find(row => row.id === id)!;
      expect(detail.execution).toMatchObject({ status: 'interrupted', relationshipToFinalSnapshot: 'not-executed', suiteCount: 0, passedSuites: 0, failedSuites: 0, unresolvedSuites: 0, recordedAt: null, runtimeDigest: null });
      expect(detail.execution.provenance).toContain('No execution or timeout experiment was performed');
      expect(detail).toMatchObject({ annotationStatus: 'pending', approvalStatus: 'pending', candidateRecorded: false, disagreementCount: null });
    }
  });
  it('exports versioned code identity and declared interruption context through the actual offline CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-evaluator-export-')), path = join(directory, 'attempts.json');
    try {
      execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/evaluate.ts', '--export-attempts', path], { cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, FEATURE_AI: 'false', FEATURE_VOICE: 'false', FEATURE_BILLING: 'false' } });
      const exported = JSON.parse(await readFile(path, 'utf8')) as { benchmarkVersion: string; attempts: Array<{ caseId: string; fixtureIdentity: unknown; executionContext: unknown; session: { files: Record<string, string>; runs: unknown[] } }> };
      expect(exported.benchmarkVersion).toBe(recipes.version); expect(exported.attempts).toHaveLength(21);
      for (const id of customIds) {
        const expected = materializeAttempt(recipe(id), capture), actual = exported.attempts.find(row => row.caseId === id)!;
        expect(actual.fixtureIdentity).toEqual(expected.fixtureIdentity); expect(actual.executionContext).toEqual(expected.executionContext);
        expect(actual.session.files).toEqual(expected.recipe.snapshot!.files); expect(actual.session.runs).toEqual([]);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
