import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import { fixtureRuntimeBinding } from './runtime-fixtures';
import { CorpusValidationError, PRIVATE_CORPUS_LIMITS, assertCorpusSeparation, capturePrivateCases, createPrivateJson, developmentCorpusIndex, exportPrivateCorpusContexts, loadPrivateCorpus, materializePrivateCorpus, preparePrivateDirectory, privateCaptureDigest, privateCorpusIndex, privateCorpusSummary, privateCorpusTemplate, privateInputContextDigest, readPrivateJson, validatePrivateCaptures, validatePrivateCorpus, type PrivateCapture, type PrivateCaptureSet, type PrivateCase, type PrivateCorpus } from '../evals/private-corpus';

const exec = promisify(execFile), scenario = getScenario('monetary-validation')!;
const start = '2026-10-09T10:00:00.000Z', end = '2026-10-09T10:45:00.000Z', prepared = '2026-10-09T11:00:00.000Z', capturedAt = '2026-10-09T12:00:00.000Z';
function row(id = 'private-case-a'): PrivateCase {
  const files = structuredClone(scenario.files), path = Object.keys(files)[0]; files[path] += `\n# ORIGINAL SYNTHETIC CORPUS UNIT FIXTURE ${id}\n`;
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), rubricVersion: scenario.version, rubricDigest: digest(scenario.rubric), fixtureVersion: '1.0.0', runtime: fixtureRuntimeBinding(scenario), source: { kind: 'operator-authored-synthetic', sourceId: `source-${id}`, preparedBy: 'unit-custodian', preparedAt: prepared, usedForPromptDevelopment: false, dataPolicy: 'deidentified-no-credentials-no-raw-audio' }, conditions: { mode: 'simulation', promptExposure: 'fresh', role: 'Backend engineer', level: scenario.level, skills: scenario.tags, targetMinutes: 60, originalTargetMinutes: 45, extensions: [{ additionalMinutes: 15, occurredAt: '2026-10-09T10:20:00.000Z' }], aiHelp: true, hintsOpened: 0, practiceConditions: { timing: 'standard', participation: 'written-only' } }, condition: 'partial', snapshot: { version: '1.0.0', createdAt: '2026-10-09T10:30:00.000Z', files, sha256: digest(files) }, startedAt: start, endedAt: end, dialogue: [{ id: `${id}-explanation`, role: 'learner', text: 'Synthetic concise explanation; no real person or acceptance outcome.', source: 'typed', createdAt: '2026-10-09T10:40:00.000Z' }], assistantMessages: [], execution: { kind: 'unexecuted' }, reviewFocus: ['Synthetic unit data only; not a real curated attempt.'] };
}
function corpus(split: PrivateCorpus['corpus']['split'] = 'acceptance', cases = [row()]): PrivateCorpus {
  return { schemaVersion: 1, corpus: { id: 'private-unit-corpus', version: '1.0.0', split }, createdAt: prepared, provenance: 'operator-supplied-private-corpus', independence: { sealedFromPromptDevelopment: true, custodianId: 'unit-custodian' }, cases };
}
function capture(input: PrivateCorpus, selected = input.cases[0]): PrivateCapture {
  return { schemaVersion: 1, corpus: input.corpus, caseId: selected.id, inputContextDigest: privateInputContextDigest(input.corpus, selected), scenarioId: selected.scenarioId, scenarioVersion: selected.scenarioVersion, scenarioDigest: selected.scenarioDigest, rubricVersion: selected.rubricVersion, rubricDigest: selected.rubricDigest, fixtureVersion: selected.fixtureVersion, snapshotVersion: selected.snapshot.version, snapshotSha256: selected.snapshot.sha256, testSuiteDigest: digest(scenario.tests), runtime: selected.runtime, provenance: 'operator-supplied-isolated-runner-record', executionOrigin: 'offline-snapshot-replay', operatorId: 'hypothetical-unit-operator', startedAt: capturedAt, completedAt: '2026-10-09T12:00:00.010Z', recordedAt: '2026-10-09T12:00:00.020Z', run: { status: 'completed', command: 'docker isolated Python unittest (immutable snapshot; no host mounts or network)', stdout: '', stderr: '', exitCode: 1, durationMs: 10, runtimeDigest: selected.runtime.imageId, tests: scenario.tests.map(test => ({ id: test.id, title: test.title, status: 'failed', detail: 'HYPOTHETICAL UNIT OBSERVATION, NOT REAL EXECUTION' })) } };
}
const captures = (...values: PrivateCapture[]): PrivateCaptureSet => ({ schemaVersion: 1, provenance: 'private-corpus-captures', captures: values });
const temporary: string[] = [];
async function directory() { const path = await mkdtemp('/private/tmp/foundry-private-corpus-'); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('strict private corpus identities and faithful conditions', () => {
  it('starts with empty labels/captures and no assertion that a holdout is protected', () => {
    const template = privateCorpusTemplate('holdout', 'operator-corpus', '1.0.0', 'operator');
    expect(template.cases).toEqual([]); expect(template.independence.sealedFromPromptDevelopment).toBe(false);
    expect(privateCorpusSummary(validatePrivateCorpus(template), [])).toMatchObject({ cases: 0, expertReviews: 0, providerCalls: 0, qualification: 'pending', existingRoleWorkflow: 'unsupported-private-split-import', knownDevelopmentOverlapCheck: 'not-requested', independence: 'not-attested' });
  });
  it('materializes exact custom bytes, dialogue clocks, participation and extension conditions without execution', () => {
    const input = corpus(), attempt = materializePrivateCorpus(input)[0];
    expect(attempt.session.files).toEqual(input.cases[0].snapshot.files); expect(attempt.session.turns[0]).toMatchObject(input.cases[0].dialogue[0]);
    expect(attempt.session.configuration).toMatchObject({ targetMinutes: 60, originalTargetMinutes: 45, practiceConditions: { participation: 'written-only' } });
    expect(attempt.session.runs).toEqual([]); expect(attempt.session.frozenEvidence!.items.some(item => item.kind === 'test')).toBe(false);
    expect(attempt.execution).toMatchObject({ kind: 'unexecuted', provenance: 'operator-declared-unobserved', captureDigest: null });
    expect(attempt.case.conditions.extensions).toEqual(input.cases[0].conditions.extensions);
  });
  it('keeps declared interruptions unobserved even when an unselected capture is supplied', () => {
    const input = corpus(); input.cases[0].condition = 'interrupted'; input.cases[0].execution = { kind: 'declared-interruption', phase: 'during-execution', reason: 'worker-restart' };
    const result = materializePrivateCorpus(input, captures(capture(input)))[0];
    expect(result.execution).toMatchObject({ kind: 'declared-interruption', provenance: 'operator-declared-unobserved', interruption: { phase: 'during-execution', reason: 'worker-restart' } });
    expect(result.session.runs).toEqual([]); expect(result.session.frozenEvidence!.items.every(item => item.kind !== 'test')).toBe(true);
    const changed = structuredClone(input); changed.cases[0].execution = { kind: 'declared-interruption', phase: 'before-execution', reason: 'timeout' };
    expect(materializePrivateCorpus(changed)[0].contextDigest).not.toBe(result.contextDigest);
  });
  it.each([
    ['scenario digest', (item: PrivateCase) => { item.scenarioDigest = 'b'.repeat(64); }],
    ['rubric version', (item: PrivateCase) => { item.rubricVersion = '9.0.0'; }],
    ['rubric digest', (item: PrivateCase) => { item.rubricDigest = 'b'.repeat(64); }],
    ['snapshot digest', (item: PrivateCase) => { item.snapshot.sha256 = 'b'.repeat(64); }],
    ['path escape', (item: PrivateCase) => { item.snapshot.files['../escape.py'] = 'PRIVATE CONTENT'; item.snapshot.sha256 = digest(item.snapshot.files); }],
    ['wrong runtime family', (item: PrivateCase) => { item.runtime.scenarioImage = 'unreviewed:latest'; }],
    ['dialogue chronology', (item: PrivateCase) => { item.dialogue[0].createdAt = capturedAt; }],
    ['snapshot chronology', (item: PrivateCase) => { item.snapshot.createdAt = prepared; }],
    ['preparation chronology', (item: PrivateCase) => { item.source.preparedAt = start; }],
    ['unknown competency', (item: PrivateCase) => { item.dialogue[0].competencyId = 'hiring-probability'; }],
    ['wrong source role', (item: PrivateCase) => { item.dialogue[0].source = 'model'; }],
    ['missing reply parent', (item: PrivateCase) => { item.dialogue[0].replyTo = 'unknown-turn'; }],
    ['impossible extensions', (item: PrivateCase) => { item.conditions.targetMinutes = 61; }],
  ])('rejects %s without echoing learner content', (_label, change) => {
    const input = corpus(); change(input.cases[0]);
    expect(() => validatePrivateCorpus(input)).toThrow(CorpusValidationError);
    try { validatePrivateCorpus(input); } catch (error) { expect(String(error)).not.toContain('PRIVATE CONTENT'); }
  });
  it('rejects unknown schemas, approvals, host paths and unbounded corpora', () => {
    const input = corpus();
    for (const value of [{ ...input, schemaVersion: 2 }, { ...input, approved: true }, { ...input, cases: [{ ...input.cases[0], filesPath: '/etc/passwd' }] }, { ...input, cases: Array.from({ length: 101 }, (_, index) => row(`case-${index}`)) }]) expect(() => validatePrivateCorpus(value)).toThrow(CorpusValidationError);
  });
  it('keeps consented source metadata an explicit unverified attestation', () => {
    const input = corpus(); input.cases[0].source = { ...input.cases[0].source, kind: 'consented-deidentified-attempt', permissionReference: 'opaque-consent-reference', sourceArtifactDigest: 'a'.repeat(64) };
    expect(privateCorpusSummary(input, materializePrivateCorpus(input))).toMatchObject({ sources: { 'consented-deidentified-attempt': 1 }, expertReviews: 0, qualification: 'pending', independence: 'operator-attestation-not-independent-verification' });
    const invalid = structuredClone(input); delete (invalid.cases[0].source as Partial<typeof input.cases[0]['source']> & { permissionReference?: string }).permissionReference;
    expect(() => validatePrivateCorpus(invalid)).toThrow(CorpusValidationError);
  });
});

describe('development, acceptance and holdout separation', () => {
  it('blocks prompt-development use and unsealed/reused sources for non-development cases', () => {
    for (const split of ['acceptance', 'holdout'] as const) {
      const input = corpus(split); expect(() => validatePrivateCorpus(input, { purpose: 'prompt-development' })).toThrow(CorpusValidationError);
      input.independence.sealedFromPromptDevelopment = false; expect(() => validatePrivateCorpus(input)).toThrow(CorpusValidationError);
      input.independence.sealedFromPromptDevelopment = true; input.cases[0].source.usedForPromptDevelopment = true; expect(() => validatePrivateCorpus(input)).toThrow(CorpusValidationError);
    }
    const development = corpus('development'); development.cases[0].source.usedForPromptDevelopment = true;
    expect(validatePrivateCorpus(development, { purpose: 'prompt-development' }).corpus.split).toBe('development');
  });
  it('rejects renamed duplicate work and cross-split source/case/context reuse', () => {
    const input = corpus(), second = structuredClone(input.cases[0]); second.id = 'renamed'; second.source.sourceId = 'renamed-source';
    expect(() => validatePrivateCorpus(corpus('acceptance', [input.cases[0], second]))).toThrow(CorpusValidationError);
    const other = corpus('holdout');
    expect(() => assertCorpusSeparation(input, privateCorpusIndex(other))).toThrow(CorpusValidationError);
    other.cases[0] = row('different-case'); other.cases[0].source.sourceId = input.cases[0].source.sourceId;
    expect(() => assertCorpusSeparation(input, privateCorpusIndex(other))).toThrow(CorpusValidationError);
  });
  it('detects overlap with checked-in development data and preserves its exact recipes/captures', async () => {
    const files = ['evals/fixtures/attempts.json', 'evals/fixtures/runtime-observations.json'];
    const before = await Promise.all(files.map(async path => digest(await readFile(path, 'utf8'))));
    const known = await developmentCorpusIndex(); expect(known).toHaveLength(21);
    const input = corpus(); input.cases[0].id = known[0].caseKey;
    expect(() => validatePrivateCorpus(input, { otherCorpora: known })).toThrow(CorpusValidationError);
    expect(await Promise.all(files.map(async path => digest(await readFile(path, 'utf8'))))).toEqual(before);
  });
});

describe('bounded imported runtime observations', () => {
  it('accepts explicitly recorded original-attempt runs only inside the original snapshot/time window', () => {
    const input = corpus(), actual = capture(input); actual.executionOrigin = 'recorded-attempt-run';
    actual.startedAt = '2026-10-09T10:35:00.000Z'; actual.completedAt = '2026-10-09T10:35:00.010Z';
    input.cases[0].execution = { kind: 'captured', captureDigest: privateCaptureDigest(actual) };
    const attempt = materializePrivateCorpus(input, captures(actual))[0];
    expect(attempt.execution.executionOrigin).toBe('recorded-attempt-run');
    expect(attempt.session.runs[0].createdAt).toBe(actual.completedAt); expect(attempt.session.frozenEvidence!.frozenAt).toBe(end);
    for (const change of [
      { startedAt: '2026-10-09T10:29:59.999Z', completedAt: '2026-10-09T10:30:00.010Z' },
      { startedAt: end, completedAt: '2026-10-09T10:45:00.010Z' },
      { executionOrigin: 'unknown-host-observation' },
    ]) expect(() => validatePrivateCaptures(captures({ ...actual, ...change } as PrivateCapture), input)).toThrow(CorpusValidationError);
  });
  it('uses only an exact capture digest and marks offline re-execution separately from the original attempt', () => {
    const input = corpus(), actual = capture(input); input.cases[0].execution = { kind: 'captured', captureDigest: privateCaptureDigest(actual) };
    const attempt = materializePrivateCorpus(input, captures(actual))[0];
    expect(attempt.session.runs[0].tests).toEqual(actual.run.tests); expect(attempt.session.frozenEvidence!.frozenAt).toBe(actual.completedAt);
    expect(attempt.execution).toMatchObject({ kind: 'captured', executionOrigin: 'offline-snapshot-replay', provenance: 'operator-supplied-runner-record' });
    const exported = exportPrivateCorpusContexts(input, captures(actual));
    expect(exported.existingRoleWorkflow.status).toBe('unsupported'); expect(exported.cases[0]).toMatchObject({ reviews: [], adjudication: null, caseDigest: digest(input.cases[0]), contextDigest: attempt.contextDigest });
    expect('referenceFiles' in exported.cases[0].scenario).toBe(false); expect(exported.cases[0].scenario.tests.filter(test => !test.visible).every(test => !('source' in test))).toBe(true);
    expect(() => exportPrivateCorpusContexts(input, [attempt])).toThrow(CorpusValidationError);
  });
  it.each([
    ['different case', (value: PrivateCapture) => { value.caseId = 'other-case'; }],
    ['different split', (value: PrivateCapture) => { value.corpus = { ...value.corpus, split: 'holdout' }; }],
    ['context mismatch', (value: PrivateCapture) => { value.inputContextDigest = 'b'.repeat(64); }],
    ['scenario mismatch', (value: PrivateCapture) => { value.scenarioDigest = 'b'.repeat(64); }],
    ['runtime substitution', (value: PrivateCapture) => { value.run.runtimeDigest = 'sha256:' + 'b'.repeat(64); }],
    ['suite substitution', (value: PrivateCapture) => { value.testSuiteDigest = 'b'.repeat(64); }],
    ['fixture version', (value: PrivateCapture) => { value.fixtureVersion = '2.0.0'; }],
    ['snapshot version', (value: PrivateCapture) => { value.snapshotVersion = '2.0.0'; }],
    ['unknown test', (value: PrivateCapture) => { value.run.tests[0].id = 'learner-authored-check'; }],
    ['duplicate test', (value: PrivateCapture) => { value.run.tests.push(value.run.tests[0]); }],
    ['incomplete completed run', (value: PrivateCapture) => { value.run.tests.pop(); }],
    ['false success exit', (value: PrivateCapture) => { value.run.exitCode = 0; }],
    ['arbitrary command', (value: PrivateCapture) => { value.run.command = 'curl SECRET' as typeof value.run.command; }],
    ['impossible clock', (value: PrivateCapture) => { value.completedAt = start; }],
    ['premature recording', (value: PrivateCapture) => { value.recordedAt = start; }],
    ['oversize output', (value: PrivateCapture) => { value.run.stdout = 'x'.repeat(64_001); }],
    ['missing runtime', (value: PrivateCapture) => { delete (value.run as Partial<typeof value.run>).runtimeDigest; }],
  ])('rejects %s', (_label, change) => {
    const input = corpus(), actual = capture(input); change(actual);
    expect(() => validatePrivateCaptures(captures(actual), input)).toThrow(CorpusValidationError);
  });
  it('preserves partial timeout observations without claiming the remaining suite passed', () => {
    const input = corpus(), actual = capture(input); actual.run.status = 'timeout'; actual.run.exitCode = null; actual.run.tests = actual.run.tests.slice(0, 1); actual.run.tests[0].status = 'passed';
    input.cases[0].execution = { kind: 'captured', captureDigest: privateCaptureDigest(actual) };
    const result = materializePrivateCorpus(input, captures(actual))[0];
    expect(result.session.runs[0]).toMatchObject({ status: 'timeout', exitCode: null, tests: [{ status: 'passed' }] });
    expect(result.session.frozenEvidence!.items.filter(item => item.kind === 'test')).toHaveLength(1);
  });
  it('rejects duplicate, unknown, stale and absent captures rather than choosing one by snapshot/variant', () => {
    const input = corpus(), actual = capture(input); input.cases[0].execution = { kind: 'captured', captureDigest: privateCaptureDigest(actual) };
    expect(() => materializePrivateCorpus(input)).toThrow(CorpusValidationError);
    expect(() => materializePrivateCorpus(input, captures(actual, actual))).toThrow(CorpusValidationError);
    const changed = structuredClone(input); changed.cases[0].dialogue[0].text += ' changed'; expect(() => materializePrivateCorpus(changed, captures(actual))).toThrow(CorpusValidationError);
    const unknown = { ...actual, provenance: 'actual-host-python' }; expect(() => validatePrivateCaptures(captures(unknown as PrivateCapture), input)).toThrow(CorpusValidationError);
  });
});

describe('explicit capture admission without real execution', () => {
  it('does nothing without both explicit gates or a matching configured runtime', async () => {
    const input = corpus(), execute = vi.fn(), persist = vi.fn();
    for (const options of [{ enabled: false, acknowledgeIsolatedHost: true }, { enabled: true, acknowledgeIsolatedHost: false }]) await expect(capturePrivateCases(input, [input.cases[0].id], { ...options, operatorId: 'unit-operator', execute, persist })).rejects.toBeInstanceOf(CorpusValidationError);
    await expect(capturePrivateCases(input, [input.cases[0].id], { enabled: true, acknowledgeIsolatedHost: true, operatorId: 'unit-operator', execute, persist, binding: () => null })).rejects.toBeInstanceOf(CorpusValidationError);
    expect(execute).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('passes only immutable files, the pinned binding, authored suites and cancellation to the injected runner', async () => {
    const input = corpus(), actual = capture(input), persist = vi.fn(), execute = vi.fn().mockResolvedValue(actual.run);
    let clock = Date.parse(capturedAt); const now = () => new Date(clock += 20);
    const controller = new AbortController();
    const result = await capturePrivateCases(input, [input.cases[0].id], { enabled: true, acknowledgeIsolatedHost: true, operatorId: 'unit-operator', signal: controller.signal, now, execute, persist });
    expect(execute).toHaveBeenCalledWith(scenario, input.cases[0].snapshot.files, { signal: controller.signal, includeProtected: true, runtimeBinding: input.cases[0].runtime, selection: 'authored' });
    expect(result.captures).toHaveLength(1); expect(persist.mock.calls[0][0].captures).toEqual([]); expect(persist).toHaveBeenCalledTimes(2);
    expect(input.cases[0].execution).toEqual({ kind: 'unexecuted' });
  });
  it('blocks unknown cases, duplicate cases, oversized batches and cancelled execution before calling a runner', async () => {
    const input = corpus(), execute = vi.fn(), persist = vi.fn(), options = { enabled: true, acknowledgeIsolatedHost: true, operatorId: 'unit-operator', execute, persist };
    for (const cases of [[], ['unknown'], [input.cases[0].id, input.cases[0].id], Array.from({ length: 11 }, (_, index) => `case-${index}`)]) await expect(capturePrivateCases(input, cases, options)).rejects.toBeInstanceOf(CorpusValidationError);
    const controller = new AbortController(); controller.abort(); await expect(capturePrivateCases(input, [input.cases[0].id], { ...options, signal: controller.signal })).rejects.toBeInstanceOf(CorpusValidationError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('private files, bounded import and zero-action CLI', () => {
  it('writes exclusive 0600 artifacts inside private directories and refuses symlinks or unsafe permissions', async () => {
    const root = await directory(), path = join(root, 'corpus.json'); await createPrivateJson(path, corpus());
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect(await readPrivateJson(path)).toEqual(corpus());
    await expect(createPrivateJson(path, {})).rejects.toBeInstanceOf(CorpusValidationError);
    const link = join(root, 'link.json'); await symlink(path, link); await expect(readPrivateJson(link)).rejects.toBeInstanceOf(CorpusValidationError);
    const directoryLink = join(root, 'linked-directory'); await symlink(root, directoryLink); await expect(createPrivateJson(join(directoryLink, 'forbidden', 'out.json'), {})).rejects.toBeInstanceOf(CorpusValidationError);
    await chmod(path, 0o644); await expect(readPrivateJson(path)).rejects.toBeInstanceOf(CorpusValidationError); await chmod(path, 0o600);
    await chmod(root, 0o755); await expect(readPrivateJson(path)).rejects.toBeInstanceOf(CorpusValidationError); await chmod(root, 0o700);
    await expect(preparePrivateDirectory(root, true)).rejects.toBeInstanceOf(CorpusValidationError);
  });
  it('rejects invalid UTF-8, non-JSON, directories and oversized regular inputs', async () => {
    const root = await directory(), path = join(root, 'bad.json');
    await writeFile(path, Buffer.from([0xc0, 0xaf]), { mode: 0o600 }); await expect(readPrivateJson(path)).rejects.toBeInstanceOf(CorpusValidationError);
    await writeFile(path, 'NOT JSON'); await expect(readPrivateJson(path)).rejects.toBeInstanceOf(CorpusValidationError);
    await expect(readPrivateJson(root)).rejects.toBeInstanceOf(CorpusValidationError);
    const large = join(root, 'large.json'); const handle = await import('node:fs/promises').then(fs => fs.open(large, 'wx', 0o600)); await handle.truncate(PRIVATE_CORPUS_LIMITS.bytes + 1); await handle.close();
    await expect(readPrivateJson(large)).rejects.toBeInstanceOf(CorpusValidationError);
  });
  it('loads private cases with known development/cross-file separation and imports only exact selected observations', async () => {
    const root = await directory(), input = corpus(), actual = capture(input); input.cases[0].execution = { kind: 'captured', captureDigest: privateCaptureDigest(actual) };
    const manifest = join(root, 'corpus.json'), observations = join(root, 'captures.json'); await createPrivateJson(manifest, input); await createPrivateJson(observations, captures(actual));
    const loaded = await loadPrivateCorpus(manifest, { capturePaths: [observations] }); expect(loaded.attempts[0].execution.kind).toBe('captured');
    const other = join(root, 'holdout.json'); await createPrivateJson(other, corpus('holdout'));
    await expect(loadPrivateCorpus(manifest, { capturePaths: [observations], comparisonPaths: [other] })).rejects.toBeInstanceOf(CorpusValidationError);
  });
  it('defaults to no action, validates content-free summaries, and writes a faithful private export without providers', async () => {
    const root = await directory(), manifest = join(root, 'corpus.json'), output = join(root, 'contexts.json'); await createPrivateJson(manifest, corpus());
    const run = (args: string[]) => exec(process.execPath, ['--conditions=react-server', '--import=tsx', 'scripts/acceptance-corpus.ts', ...args], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: '', FOUNDRY_ACCEPTANCE_CAPTURE: '' }, maxBuffer: 100_000 });
    const idle = await run([]); expect(idle.stdout).toContain('Default: no action');
    const result = JSON.parse((await run(['--corpus', manifest])).stdout); expect(result).toMatchObject({ providerCalls: 0, cases: 1, qualification: 'pending', knownDevelopmentOverlapCheck: 'performed-by-cli-loader' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC CORPUS UNIT FIXTURE');
    await run(['--corpus', manifest, '--export-contexts', '--output', output]); expect((await readPrivateJson(output) as { existingRoleWorkflow: { status: string } }).existingRoleWorkflow.status).toBe('unsupported');
    await expect(run(['--corpus', manifest, '--capture-docker', '--acknowledge-isolated-host', '--operator', 'unit-operator', '--cases', 'private-case-a', '--output', join(root, 'no-capture')])).rejects.toThrow();
    await expect(lstat(join(root, 'no-capture'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});
