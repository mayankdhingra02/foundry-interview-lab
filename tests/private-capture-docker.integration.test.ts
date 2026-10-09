import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import { configuredRuntimeBinding, type RuntimeBinding } from '../lib/runtime/binding';
import { executeScenario, runnerHealth } from '../lib/runtime/runner';
import {
  capturePrivateCases, createPrivateJson, developmentCorpusIndex, exportPrivateCorpusContexts,
  loadPrivateCorpus, materializePrivateCorpus, privateCaptureDigest, privateCaptureSchema,
  privateCorpusIndex, privateInputContextDigest, readPrivateJson, validatePrivateCaptures,
  validatePrivateCorpus, type PrivateCaptureSet, type PrivateCase, type PrivateCorpus,
} from '../evals/private-corpus';

// Dedicated fresh CI execution context only; run files sequentially with
// --no-file-parallelism and no competing Foundry runs. Label checks below are
// context-wide, not proof of resource ownership on a shared execution host.
// No host Python, image pulls, provider calls, fabricated process results or
// additions to the 21-case benchmark / acceptance / protected holdout corpus.
const realDocker = process.env.FOUNDRY_DOCKER_INTEGRATION === '1';
const exec = promisify(execFile), scenario = getScenario('monetary-validation', '1.0.0')!;
const temporary: string[] = [];
let binding: RuntimeBinding;
const external = vi.fn<typeof fetch>(() => { throw new Error('External provider calls are forbidden in capture qualification.'); });
const captures = (rows: PrivateCaptureSet['captures']): PrivateCaptureSet => ({ schemaVersion: 1, provenance: 'private-corpus-captures', captures: rows });
const differentImageId = () => 'sha256:' + (binding.imageId.slice(7) === '0'.repeat(64) ? '1' : '0').repeat(64);

async function directory() {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'foundry-private-capture-ci-'));
  temporary.push(path); await chmod(path, 0o700); return path;
}
async function assertCleanExecutionContext() {
  const result = await exec('docker', ['ps', '--all', '--quiet', '--filter', 'label=foundry.interview-execution=true'], { timeout: 5_000, maxBuffer: 16_000 });
  expect(result.stdout.trim(), 'Dedicated qualification context has remaining Foundry execution containers. Do not prune or reset a shared host.').toBe('');
}
function syntheticRow(id: string, correct = true): PrivateCase {
  const now = Date.now(), start = new Date(now - 120_000).toISOString(), end = new Date(now - 60_000).toISOString();
  const files = structuredClone(scenario.files);
  // Independently authored divmod approach; this is not a renamed benchmark
  // reference/starter. The partial variant deliberately floors half cents.
  files['quote.py'] = `# ORIGINAL SYNTHETIC SOFTWARE CAPTURE QUALIFICATION ONLY: ${id}
def quote_total(lines, discount_bps=0, shipping_cents=0):
    if type(discount_bps) is not int or not 0 <= discount_bps <= 10000:
        raise ValueError('invalid discount')
    if type(shipping_cents) is not int or shipping_cents < 0:
        raise ValueError('invalid shipping')
    products = []
    for item in lines:
        if type(item.unit_cents) is not int or item.unit_cents < 0:
            raise ValueError('invalid price')
        if type(item.quantity) is not int or item.quantity < 1:
            raise ValueError('invalid quantity')
        products.append(item.unit_cents * item.quantity)
    whole, remainder = divmod(sum(products) * (10000 - discount_bps), 10000)
    return shipping_cents + whole + ${correct ? 'int(remainder >= 5000)' : '0  # Deliberate synthetic gap: floor, not half-up rounding.'}
`;
  return {
    id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), rubricVersion: scenario.version, rubricDigest: digest(scenario.rubric), fixtureVersion: '1.0.0', runtime: structuredClone(binding),
    source: { kind: 'operator-authored-synthetic', sourceId: `source-${id}`, preparedBy: 'ci-synthetic-custodian', preparedAt: new Date(now - 30_000).toISOString(), usedForPromptDevelopment: false, dataPolicy: 'deidentified-no-credentials-no-raw-audio' },
    conditions: { mode: 'practice', promptExposure: 'fresh', role: 'Synthetic software test', level: scenario.level, skills: [], targetMinutes: 40, originalTargetMinutes: 40, extensions: [], aiHelp: false, hintsOpened: 0, practiceConditions: { timing: 'standard', participation: 'written-only' } },
    condition: correct ? 'correct-concise' : 'partial', snapshot: { version: '1.0.0', createdAt: new Date(now - 90_000).toISOString(), files, sha256: digest(files) }, startedAt: start, endedAt: end,
    dialogue: [{ id: `${id}-explanation`, role: 'learner', text: `Authored software fixture ${id}; no real learner, human review, model output or acceptance result.`, source: 'typed', createdAt: end }],
    assistantMessages: [], execution: { kind: 'unexecuted' }, reviewFocus: ['Synthetic development-only capture plumbing; excluded from acceptance and holdout quality denominators.'],
  };
}
function syntheticCorpus(rows: PrivateCase[]): PrivateCorpus {
  return { schemaVersion: 1, corpus: { id: 'ci-synthetic-private-capture-only', version: '1.0.0', split: 'development' }, createdAt: new Date().toISOString(), provenance: 'operator-supplied-private-corpus', independence: { sealedFromPromptDevelopment: false, custodianId: 'ci-synthetic-custodian' }, cases: rows };
}
async function assertIndependentSyntheticInputs(input: PrivateCorpus) {
  validatePrivateCorpus(input, { purpose: 'capture' });
  const known = await developmentCorpusIndex();
  for (const row of privateCorpusIndex(input)) {
    expect(known.some(previous => previous.caseKey === row.caseKey || previous.sourceKey === row.sourceKey || previous.contentDigest === row.contentDigest)).toBe(false);
  }
  expect(input.corpus.split).toBe('development'); expect(input.independence.sealedFromPromptDevelopment).toBe(false);
  expect(input.cases.every(row => row.source.kind === 'operator-authored-synthetic')).toBe(true);
}
function selectObservations(input: PrivateCorpus, result: PrivateCaptureSet) {
  const selected = structuredClone(input);
  for (const row of selected.cases) {
    const capture = result.captures.find(value => value.caseId === row.id);
    if (capture) row.execution = { kind: 'captured', captureDigest: privateCaptureDigest(capture) };
  }
  return selected;
}

describe.runIf(realDocker)('private capture through the real isolated Docker runner (synthetic development only)', () => {
  beforeAll(() => {
    expect(process.env.PYTHON_IMAGE_ID, 'CI must provision and inspect the immutable Python image before Vitest starts.').toMatch(/^sha256:[a-f0-9]{64}$/);
    const resolved = configuredRuntimeBinding(scenario);
    if (!resolved || resolved.imageId !== process.env.PYTHON_IMAGE_ID) throw new Error('Configured runtime must match the actually provisioned CI image.');
    binding = resolved;
  });
  beforeEach(async () => { external.mockClear(); vi.stubGlobal('fetch', external); await assertCleanExecutionContext(); });
  afterEach(async () => {
    try { await assertCleanExecutionContext(); expect(external).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); }
  });

  it('checkpoints exact passing/failing offline observations privately and imports only explicitly selected evidence', async () => {
    const input = syntheticCorpus([syntheticRow('ci-capture-correct'), syntheticRow('ci-capture-gap', false)]), before = structuredClone(input);
    await assertIndependentSyntheticInputs(input);
    const root = await directory(), manifest = join(root, 'input.json'); await createPrivateJson(manifest, input);
    const loaded = await loadPrivateCorpus(manifest, { purpose: 'capture' });
    let checkpoint = 0;
    const result = await capturePrivateCases(loaded.corpus, input.cases.map(row => row.id), {
      enabled: true, acknowledgeIsolatedHost: true, operatorId: 'ci-synthetic-operator', execute: executeScenario,
      persist: value => createPrivateJson(join(root, `checkpoint-${String(checkpoint++).padStart(3, '0')}.json`), value),
    });
    const output = join(root, 'captures.json'); await createPrivateJson(output, result);
    expect(input).toEqual(before); expect(result.captures).toHaveLength(2); expect(checkpoint).toBe(3);
    expect((await readPrivateJson(join(root, 'checkpoint-000.json')) as PrivateCaptureSet).captures).toEqual([]);
    expect((await readPrivateJson(join(root, 'checkpoint-001.json')) as PrivateCaptureSet).captures).toHaveLength(1);
    expect(await readPrivateJson(join(root, 'checkpoint-002.json'))).toEqual(result);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    for (const filename of await readdir(root)) expect((await lstat(join(root, filename))).mode & 0o777).toBe(0o600);
    for (const [index, capture] of result.captures.entries()) {
      const row = input.cases[index];
      expect(capture).toMatchObject({ executionOrigin: 'offline-snapshot-replay', inputContextDigest: privateInputContextDigest(input.corpus, row), scenarioDigest: digest(scenario), rubricDigest: digest(scenario.rubric), snapshotSha256: digest(row.snapshot.files), testSuiteDigest: digest(scenario.tests), runtime: binding });
      expect(capture.run.status, capture.run.stderr).toBe('completed'); expect(capture.run.runtimeDigest).toBe(binding.imageId);
      expect(capture.run.tests.map(test => test.id)).toEqual(scenario.tests.map(test => test.id));
      expect(capture.run.tests.every(test => test.status === 'passed')).toBe(index === 0);
      expect(capture.run.exitCode).toBe(index === 0 ? 0 : 1);
      if (index === 1) expect(capture.run.tests.some(test => test.status === 'failed' || test.status === 'error')).toBe(true);
    }
    // Supplied but unselected observations do not rewrite original execution state.
    expect(materializePrivateCorpus(input, result).every(attempt => attempt.session.runs.length === 0)).toBe(true);
    const selected = selectObservations(input, result), selectedPath = join(root, 'selected.json'); await createPrivateJson(selectedPath, selected);
    const roundtrip = await loadPrivateCorpus(selectedPath, { capturePaths: [output] });
    for (const [index, attempt] of roundtrip.attempts.entries()) {
      const capture = result.captures[index];
      expect(attempt.execution).toMatchObject({ kind: 'captured', executionOrigin: 'offline-snapshot-replay', captureDigest: privateCaptureDigest(capture) });
      expect(attempt.session.runs[0].tests).toEqual(capture.run.tests); expect(attempt.session.jobs).toEqual([]); expect(attempt.session.reports).toEqual([]);
      const facts = attempt.session.frozenEvidence!.items.filter(item => item.kind === 'test');
      expect(facts).toHaveLength(scenario.tests.length);
      for (const fact of facts) expect(JSON.parse(fact.content)).toMatchObject({ runtimeDigest: binding.imageId, snapshotSha256: capture.snapshotSha256, testSuiteDigest: capture.testSuiteDigest });
      expect(attempt.inputContextDigest).toBe(capture.inputContextDigest);
      expect(attempt.contextDigest).not.toBe(materializePrivateCorpus(input)[index].contextDigest);
    }
    const exported = exportPrivateCorpusContexts(selected, result);
    expect(exported.qualification).toBe('pending'); expect(exported.cases.every(row => row.reviews.length === 0 && row.adjudication === null)).toBe(true);
    // These real observations cannot be reassigned to another origin, image or bytes.
    const wrongOrigin = structuredClone(result); wrongOrigin.captures[0].executionOrigin = 'recorded-attempt-run';
    expect(() => validatePrivateCaptures(wrongOrigin, input)).toThrow();
    const wrongRuntime = structuredClone(result); wrongRuntime.captures[0].run.runtimeDigest = differentImageId();
    expect(() => validatePrivateCaptures(wrongRuntime, input)).toThrow();
    const changed = structuredClone(input); changed.cases[0].snapshot.files['quote.py'] += '# changed input\n'; changed.cases[0].snapshot.sha256 = digest(changed.cases[0].snapshot.files);
    expect(() => validatePrivateCaptures(result, changed)).toThrow(); expect(runnerHealth().admitting).toBe(true);
  }, 90_000);

  it('binds a real original run to its synthetic attempt interval and rejects relabeling it as a later replay', async () => {
    const row = syntheticRow('ci-capture-original-run'), startedAt = new Date().toISOString();
    const run = await executeScenario(scenario, row.snapshot.files, { includeProtected: true, runtimeBinding: binding, selection: 'authored' });
    const completedAt = new Date().toISOString();
    expect(run.status, run.stderr).toBe('completed'); expect(run.exitCode).toBe(0); expect(run.runtimeDigest).toBe(binding.imageId);
    row.startedAt = new Date(Date.parse(startedAt) - 1_000).toISOString(); row.snapshot.createdAt = startedAt; row.endedAt = completedAt;
    row.dialogue[0].createdAt = completedAt; row.source.preparedAt = new Date().toISOString();
    const input = syntheticCorpus([row]); await assertIndependentSyntheticInputs(input);
    const capture = privateCaptureSchema.parse({ schemaVersion: 1, corpus: input.corpus, caseId: row.id, inputContextDigest: privateInputContextDigest(input.corpus, row), scenarioId: row.scenarioId, scenarioVersion: row.scenarioVersion, scenarioDigest: row.scenarioDigest, rubricVersion: row.rubricVersion, rubricDigest: row.rubricDigest, fixtureVersion: row.fixtureVersion, snapshotVersion: row.snapshot.version, snapshotSha256: row.snapshot.sha256, testSuiteDigest: digest(scenario.tests), runtime: binding, provenance: 'operator-supplied-isolated-runner-record', executionOrigin: 'recorded-attempt-run', operatorId: 'ci-synthetic-operator', startedAt, completedAt, recordedAt: new Date().toISOString(), run });
    const result = captures([capture]); validatePrivateCaptures(result, input);
    const root = await directory(), path = join(root, 'original-capture.json'); await createPrivateJson(path, result);
    expect(await readPrivateJson(path)).toEqual(result);
    const attempt = materializePrivateCorpus(selectObservations(input, result), result)[0];
    expect(attempt.execution.executionOrigin).toBe('recorded-attempt-run'); expect(attempt.session.frozenEvidence!.frozenAt).toBe(row.endedAt);
    const mislabeled = structuredClone(result); mislabeled.captures[0].executionOrigin = 'offline-snapshot-replay';
    expect(() => validatePrivateCaptures(mislabeled, input)).toThrow();
  }, 60_000);

  it('retains only the actual completed checkpoint when cancellation stops the next case', async () => {
    const input = syntheticCorpus([syntheticRow('ci-capture-cancel-first'), syntheticRow('ci-capture-cancel-unrun')]);
    await assertIndependentSyntheticInputs(input);
    const root = await directory(), controller = new AbortController(); let checkpoint = 0;
    await expect(capturePrivateCases(input, input.cases.map(row => row.id), {
      enabled: true, acknowledgeIsolatedHost: true, operatorId: 'ci-synthetic-operator', signal: controller.signal, execute: executeScenario,
      persist: async value => {
        await createPrivateJson(join(root, `checkpoint-${String(checkpoint++).padStart(3, '0')}.json`), value);
        if (value.captures.length === 1) controller.abort();
      },
    })).rejects.toMatchObject({ code: 'capture_policy' });
    expect(await readdir(root)).toEqual(['checkpoint-000.json', 'checkpoint-001.json']);
    const retained = await readPrivateJson(join(root, 'checkpoint-001.json')) as PrivateCaptureSet;
    expect(retained.captures.map(row => row.caseId)).toEqual([input.cases[0].id]);
    expect(retained.captures[0].run).toMatchObject({ status: 'completed', exitCode: 0, runtimeDigest: binding.imageId });
    validatePrivateCaptures(retained, input, { requireReferenced: false }); expect(input.cases.every(row => row.execution.kind === 'unexecuted')).toBe(true);
  }, 60_000);

  it('rejects disabled, unacknowledged, duplicate and mismatched plans before real execution or checkpoint writes', async () => {
    const input = syntheticCorpus([syntheticRow('ci-capture-denied')]), execute = vi.fn(executeScenario), persist = vi.fn(async () => {});
    const options = { enabled: true, acknowledgeIsolatedHost: true, operatorId: 'ci-synthetic-operator', execute, persist };
    for (const gates of [{ enabled: false }, { acknowledgeIsolatedHost: false }]) await expect(capturePrivateCases(input, [input.cases[0].id], { ...options, ...gates })).rejects.toMatchObject({ code: 'capture_policy' });
    await expect(capturePrivateCases(input, [input.cases[0].id, input.cases[0].id], options)).rejects.toMatchObject({ code: 'capture_policy' });
    const mismatched = structuredClone(input); mismatched.cases[0].runtime.imageId = differentImageId();
    await expect(capturePrivateCases(mismatched, [input.cases[0].id], options)).rejects.toMatchObject({ code: 'capture_policy' });
    expect(execute).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
});
