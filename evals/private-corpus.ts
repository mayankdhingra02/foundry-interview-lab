import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { getScenario } from '../lib/content/scenarios';
import { digest, toPublicScenario, validateFiles } from '../lib/interview-practice/domain';
import { freezeEvidence } from '../lib/interview-practice/evidence';
import { practiceConditionsSchema, setupExtraMinutes } from '../lib/interview-practice/timing';
import type { RunExecution, Scenario, Session } from '../lib/interview-practice/types';
import { configuredRuntimeBinding, parseRuntimeBinding, type RuntimeBinding } from '../lib/runtime/binding';
import type { ExecuteOptions } from '../lib/runtime/runner';
import { loadRecipes, loadRuntimeCapture, materializeAttempt } from './benchmark';

export const PRIVATE_CORPUS_LIMITS = { bytes: 32 * 1024 * 1024, cases: 100, captures: 100, captureBatch: 10, transcriptTurns: 40, assistantMessages: 40 } as const;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().max(32).regex(/^\d+\.\d+\.\d+$/);
const at = z.string().datetime({ offset: true });
const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'));
const corpusIdentitySchema = z.object({ id: identifier, version, split: z.enum(['development', 'acceptance', 'holdout']) }).strict();
const runtimeSchema = z.object({ version: z.literal(1), scenarioImage: text(201), imageAlias: text(201), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const sourceCommon = { sourceId: identifier, preparedBy: identifier, preparedAt: at, usedForPromptDevelopment: z.boolean(), dataPolicy: z.literal('deidentified-no-credentials-no-raw-audio') };
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ ...sourceCommon, kind: z.literal('operator-authored-synthetic') }).strict(),
  z.object({ ...sourceCommon, kind: z.literal('consented-deidentified-attempt'), permissionReference: identifier, sourceArtifactDigest: hash }).strict(),
]);
const executionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unexecuted') }).strict(),
  z.object({ kind: z.literal('declared-interruption'), phase: z.enum(['before-execution', 'during-execution']), reason: z.enum(['disconnect', 'timeout', 'worker-restart']) }).strict(),
  z.object({ kind: z.literal('captured'), captureDigest: hash }).strict(),
]);
const turnSchema = z.object({ id: identifier, role: z.enum(['learner', 'interviewer']), text: text(6000), source: z.enum(['typed', 'transcribed', 'corrected', 'authored', 'model']), createdAt: at, replyTo: identifier.optional(), competencyId: identifier.optional() }).strict();
const messageSchema = z.object({ id: identifier, role: z.enum(['learner', 'assistant']), text: text(16_000), createdAt: at, mode: z.enum(['ask', 'plan', 'edit']).optional(), model: text(200).optional() }).strict();
export const privateCaseSchema = z.object({
  id: identifier, scenarioId: identifier, scenarioVersion: version, scenarioDigest: hash, rubricVersion: version, rubricDigest: hash,
  fixtureVersion: version, runtime: runtimeSchema, source: sourceSchema,
  conditions: z.object({ mode: z.enum(['practice', 'simulation']), promptExposure: z.enum(['fresh', 'repeated']), role: text(120), level: text(100), skills: z.array(text(100)).max(20), targetMinutes: z.number().int().min(5).max(180), originalTargetMinutes: z.number().int().min(5).max(180), extensions: z.array(z.object({ additionalMinutes: z.union([z.literal(15), z.literal(30)]), occurredAt: at }).strict()).max(12), aiHelp: z.boolean(), hintsOpened: z.number().int().nonnegative().max(100), practiceConditions: practiceConditionsSchema }).strict(),
  condition: z.enum(['strong', 'partial', 'wrong-confident', 'correct-concise', 'assistive', 'interrupted', 'adversarial', 'alternative-candidate']),
  snapshot: z.object({ version, createdAt: at, files: z.record(z.string().max(64_000)), sha256: hash }).strict(),
  startedAt: at, endedAt: at, dialogue: z.array(turnSchema).max(PRIVATE_CORPUS_LIMITS.transcriptTurns), assistantMessages: z.array(messageSchema).max(PRIVATE_CORPUS_LIMITS.assistantMessages),
  execution: executionSchema, reviewFocus: z.array(text(500)).max(20),
}).strict();
export const privateCorpusSchema = z.object({ schemaVersion: z.literal(1), corpus: corpusIdentitySchema, createdAt: at, provenance: z.literal('operator-supplied-private-corpus'), independence: z.object({ sealedFromPromptDevelopment: z.boolean(), custodianId: identifier }).strict(), cases: z.array(privateCaseSchema).max(PRIVATE_CORPUS_LIMITS.cases) }).strict();
export type PrivateCorpus = z.infer<typeof privateCorpusSchema>;
export type PrivateCase = z.infer<typeof privateCaseSchema>;
const runnerCommand = 'docker isolated Python unittest (immutable snapshot; no host mounts or network)';
const runSchema = z.object({ status: z.enum(['completed', 'timeout', 'infrastructure_error']), command: z.literal(runnerCommand), stdout: z.string().max(64_000), stderr: z.string().max(64_000), exitCode: z.union([z.literal(0), z.literal(1), z.null()]), tests: z.array(z.object({ id: identifier, title: text(500), status: z.enum(['passed', 'failed', 'error', 'skipped']), detail: z.string().max(4000).optional() }).strict()).max(8), durationMs: z.number().int().min(0).max(120_000), runtimeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export const privateCaptureSchema = z.object({
  schemaVersion: z.literal(1), corpus: corpusIdentitySchema, caseId: identifier, inputContextDigest: hash,
  scenarioId: identifier, scenarioVersion: version, scenarioDigest: hash, rubricVersion: version, rubricDigest: hash,
  fixtureVersion: version, snapshotVersion: version, snapshotSha256: hash, testSuiteDigest: hash, runtime: runtimeSchema,
  provenance: z.literal('operator-supplied-isolated-runner-record'), executionOrigin: z.enum(['offline-snapshot-replay', 'recorded-attempt-run']), operatorId: identifier,
  startedAt: at, completedAt: at, recordedAt: at, run: runSchema,
}).strict();
export type PrivateCapture = z.infer<typeof privateCaptureSchema>;
export const privateCaptureSetSchema = z.object({ schemaVersion: z.literal(1), provenance: z.literal('private-corpus-captures'), captures: z.array(privateCaptureSchema).max(PRIVATE_CORPUS_LIMITS.captures) }).strict();
export type PrivateCaptureSet = z.infer<typeof privateCaptureSetSchema>;
export type CorpusIndexEntry = { split: PrivateCorpus['corpus']['split']; sourceKey: string; contentDigest: string; caseKey: string };
export type PrivateCorpusAttempt = { case: PrivateCase; scenario: Scenario; session: Session; caseDigest: string; inputContextDigest: string; contextDigest: string; execution: { kind: PrivateCase['execution']['kind']; captureDigest: string | null; provenance: 'operator-declared-unobserved' | 'operator-supplied-runner-record'; executionOrigin: PrivateCapture['executionOrigin'] | null; interruption?: { phase: 'before-execution' | 'during-execution'; reason: 'disconnect' | 'timeout' | 'worker-restart' } } };

export class CorpusValidationError extends Error {
  constructor(public readonly code: 'schema' | 'binding' | 'chronology' | 'separation' | 'private_file' | 'capture_policy') { super(`Private corpus rejected (${code}). No imported content is included in this diagnostic.`); this.name = 'CorpusValidationError'; }
}
function reject(code: CorpusValidationError['code']): never { throw new CorpusValidationError(code); }
function checked<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) reject('schema'); return result.data; }
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
export const privateCaptureDigest = (capture: PrivateCapture) => digest(capture);
/** Bind pre-execution inputs without a circular capture digest. The final context
 * separately binds the selected execution state, origin and capture digest. */
export function privateInputContextDigest(corpus: PrivateCorpus['corpus'], row: PrivateCase) {
  const { execution: _execution, ...input } = row; void _execution;
  return digest({ corpus, input });
}
function contentDigest(scenarioId: string, scenarioVersion: string, files: Record<string, string>, dialogue: Array<{ role: string; text: string }>, assistantMessages: Array<{ role: string; text: string }>, decisions: unknown[] = []) {
  return digest({ scenarioId, scenarioVersion, files, dialogue: dialogue.map(({ role, text }) => ({ role, text })), assistantMessages: assistantMessages.map(({ role, text }) => ({ role, text })), decisions });
}
export function privateCorpusIndex(corpus: PrivateCorpus): CorpusIndexEntry[] {
  return corpus.cases.map(row => ({ split: corpus.corpus.split, sourceKey: row.source.sourceId, caseKey: row.id, contentDigest: contentDigest(row.scenarioId, row.scenarioVersion, row.snapshot.files, row.dialogue, row.assistantMessages) }));
}
/** Known development cases are checked without altering their recipes/captures. */
export async function developmentCorpusIndex(): Promise<CorpusIndexEntry[]> {
  const recipes = await loadRecipes(), captures = await loadRuntimeCapture();
  return recipes.cases.map(recipe => {
    const attempt = materializeAttempt(recipe, captures), s = attempt.session;
    return { split: 'development', sourceKey: recipe.id, caseKey: recipe.id, contentDigest: contentDigest(s.scenarioId, s.scenarioVersion, s.files, s.turns, s.assistantMessages, s.editProposals.map(row => ({ files: row.files, status: row.status }))) };
  });
}
export function assertCorpusSeparation(corpus: PrivateCorpus, other: CorpusIndexEntry[]) {
  const current = privateCorpusIndex(corpus);
  if (current.some(row => other.some(previous => previous.split !== row.split && (previous.sourceKey === row.sourceKey || previous.caseKey === row.caseKey || previous.contentDigest === row.contentDigest)))) reject('separation');
}
function scenarioFor(row: PrivateCase): Scenario {
  const scenario = getScenario(row.scenarioId, row.scenarioVersion);
  if (!scenario || digest(scenario) !== row.scenarioDigest || row.rubricVersion !== scenario.version || digest(scenario.rubric) !== row.rubricDigest || !parseRuntimeBinding(row.runtime, scenario.runtime.image)) reject('binding');
  try { if (digest(validateFiles(row.snapshot.files, scenario)) !== row.snapshot.sha256) reject('binding'); } catch { reject('binding'); }
  return scenario;
}
function validateCase(row: PrivateCase, corpus: PrivateCorpus) {
  const scenario = scenarioFor(row), start = Date.parse(row.startedAt), end = Date.parse(row.endedAt), prepared = Date.parse(row.source.preparedAt);
  if (start > end || Date.parse(row.snapshot.createdAt) < start || Date.parse(row.snapshot.createdAt) > end || prepared < end || Date.parse(corpus.createdAt) < prepared) reject('chronology');
  if (row.conditions.hintsOpened > scenario.hints.length || row.conditions.originalTargetMinutes - setupExtraMinutes(row.conditions.practiceConditions.timing) < 5 || row.conditions.originalTargetMinutes + row.conditions.extensions.reduce((total, extension) => total + extension.additionalMinutes, 0) !== row.conditions.targetMinutes) reject('binding');
  let extensionAt = start;
  for (const extension of row.conditions.extensions) { const instant = Date.parse(extension.occurredAt); if (instant < extensionAt || instant > end) reject('chronology'); extensionAt = instant; }
  const ids = [...row.dialogue, ...row.assistantMessages].map(item => item.id);
  if (new Set(ids).size !== ids.length || row.dialogue.some(turn => turn.competencyId && !scenario.rubric.some(criterion => criterion.id === turn.competencyId))) reject('binding');
  let previous = start;
  for (const turn of row.dialogue) {
    const instant = Date.parse(turn.createdAt);
    if (instant < previous || instant > end) reject('chronology'); previous = instant;
    if ((turn.role === 'learner' && !['typed', 'transcribed', 'corrected'].includes(turn.source)) || (turn.role === 'interviewer' && !['authored', 'model'].includes(turn.source))) reject('binding');
    if (turn.replyTo && !row.dialogue.some(parent => parent.id === turn.replyTo && parent.role !== turn.role && Date.parse(parent.createdAt) <= instant && row.dialogue.indexOf(parent) < row.dialogue.indexOf(turn))) reject('binding');
  }
  previous = start;
  for (const message of row.assistantMessages) { const instant = Date.parse(message.createdAt); if (instant < previous || instant > end) reject('chronology'); previous = instant; }
}
export function validatePrivateCorpus(value: unknown, options: { purpose?: 'validation' | 'evaluation-export' | 'capture' | 'prompt-development'; otherCorpora?: CorpusIndexEntry[] } = {}): PrivateCorpus {
  const corpus = checked(privateCorpusSchema, value);
  if (new Set(corpus.cases.map(row => row.id)).size !== corpus.cases.length || new Set(corpus.cases.map(row => row.source.sourceId)).size !== corpus.cases.length) reject('separation');
  if (new Set(privateCorpusIndex(corpus).map(row => row.contentDigest)).size !== corpus.cases.length) reject('separation');
  if (corpus.corpus.split !== 'development' && (options.purpose === 'prompt-development' || (corpus.cases.length > 0 && (!corpus.independence.sealedFromPromptDevelopment || corpus.cases.some(row => row.source.usedForPromptDevelopment))))) reject('separation');
  for (const row of corpus.cases) validateCase(row, corpus);
  if (options.otherCorpora) assertCorpusSeparation(corpus, options.otherCorpora);
  return corpus;
}
function captureFor(corpus: PrivateCorpus, row: PrivateCase, captures: PrivateCaptureSet): PrivateCapture | undefined {
  if (row.execution.kind !== 'captured') return undefined;
  const matches = captures.captures.filter(capture => privateCaptureDigest(capture) === (row.execution.kind === 'captured' ? row.execution.captureDigest : ''));
  if (matches.length !== 1) reject('binding'); return matches[0];
}
export function validatePrivateCaptures(value: unknown, corpus: PrivateCorpus, options: { requireReferenced?: boolean } = {}): PrivateCaptureSet {
  const captures = checked(privateCaptureSetSchema, value), keys = new Set<string>();
  for (const capture of captures.captures) {
    const row = corpus.cases.find(item => item.id === capture.caseId);
    if (!row || keys.has(capture.caseId) || !same(capture.corpus, corpus.corpus)) reject('binding'); keys.add(capture.caseId);
    const scenario = scenarioFor(row);
    if (capture.inputContextDigest !== privateInputContextDigest(corpus.corpus, row) || capture.scenarioId !== row.scenarioId || capture.scenarioVersion !== row.scenarioVersion || capture.scenarioDigest !== row.scenarioDigest || capture.rubricVersion !== row.rubricVersion || capture.rubricDigest !== row.rubricDigest || capture.fixtureVersion !== row.fixtureVersion || capture.snapshotVersion !== row.snapshot.version || capture.snapshotSha256 !== row.snapshot.sha256 || capture.testSuiteDigest !== digest(scenario.tests) || !same(capture.runtime, row.runtime) || capture.run.runtimeDigest !== row.runtime.imageId) reject('binding');
    const elapsed = Date.parse(capture.completedAt) - Date.parse(capture.startedAt);
    if (elapsed < 0 || elapsed > 120_000 || capture.run.durationMs > elapsed || Date.parse(capture.recordedAt) < Date.parse(capture.completedAt)) reject('chronology');
    if (capture.executionOrigin === 'offline-snapshot-replay' ? Date.parse(capture.startedAt) < Date.parse(row.endedAt) : Date.parse(capture.startedAt) < Date.parse(row.snapshot.createdAt) || Date.parse(capture.completedAt) > Date.parse(row.endedAt)) reject('chronology');
    const actual = capture.run.tests.map(test => test.id), expected = scenario.tests.map(test => test.id);
    if (new Set(actual).size !== actual.length || actual.some((id, index) => expected[index] !== id) || capture.run.tests.some(test => scenario.tests.find(authored => authored.id === test.id)?.title !== test.title)) reject('binding');
    if (capture.run.status === 'completed') {
      const failure = capture.run.tests.some(test => ['failed', 'error'].includes(test.status));
      if (actual.length !== expected.length || capture.run.exitCode !== (failure ? 1 : 0)) reject('binding');
    } else if (capture.run.exitCode !== null) reject('binding');
    if (Buffer.byteLength(capture.run.stdout) > 64_000 || Buffer.byteLength(capture.run.stderr) > 64_000 || capture.run.tests.some(test => Buffer.byteLength(test.detail ?? '') > 16_000)) reject('schema');
  }
  if (options.requireReferenced !== false) for (const row of corpus.cases) captureFor(corpus, row, captures);
  return captures;
}

export function materializePrivateCorpus(corpusInput: unknown, capturesInput: unknown = { schemaVersion: 1, provenance: 'private-corpus-captures', captures: [] }): PrivateCorpusAttempt[] {
  const corpus = validatePrivateCorpus(corpusInput), captures = validatePrivateCaptures(capturesInput, corpus);
  return corpus.cases.map(row => {
    const scenario = scenarioFor(row), capture = captureFor(corpus, row, captures), caseDigest = digest(row), inputContextDigest = privateInputContextDigest(corpus.corpus, row);
    const snapshot = { id: `${row.id}-snapshot`, sequence: 1, createdAt: row.snapshot.createdAt, sha256: row.snapshot.sha256, files: structuredClone(row.snapshot.files) };
    const frozenAt = capture && Date.parse(capture.completedAt) > Date.parse(row.endedAt) ? capture.completedAt : row.endedAt;
    const session: Session = {
      id: `private-${row.id}`, ownerId: 'private-corpus-context', scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: row.scenarioDigest, scenario: toPublicScenario(scenario), mode: row.conditions.mode,
      configuration: { role: row.conditions.role, level: row.conditions.level, skills: row.conditions.skills, targetMinutes: row.conditions.targetMinutes, originalTargetMinutes: row.conditions.originalTargetMinutes, aiHelp: row.conditions.aiHelp, accommodations: [], voice: false, practiceConditions: row.conditions.practiceConditions }, lifecycle: 'reviewing', stageId: 'debrief', revision: 0,
      files: structuredClone(row.snapshot.files), snapshots: [snapshot], codeFrozenSnapshotId: snapshot.id, frozenEvidence: null, events: [], turns: row.dialogue.map(turn => ({ ...turn, evidenceIds: [] })),
      runs: capture ? [{ ...structuredClone(capture.run), id: `${row.id}-${capture.executionOrigin}`, jobId: `${row.id}-${capture.executionOrigin}-job`, snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, testSuiteDigest: capture.testSuiteDigest, createdAt: capture.completedAt }] : [],
      jobs: [], assistantMessages: structuredClone(row.assistantMessages), editProposals: [], reports: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: row.startedAt, updatedAt: frozenAt, hintsOpened: row.conditions.hintsOpened, completedDrillIds: [], promptExposure: row.conditions.promptExposure,
    };
    session.frozenEvidence = freezeEvidence(session, frozenAt);
    const execution: PrivateCorpusAttempt['execution'] = capture ? { kind: 'captured', captureDigest: privateCaptureDigest(capture), provenance: 'operator-supplied-runner-record', executionOrigin: capture.executionOrigin } : { kind: row.execution.kind, captureDigest: null, provenance: 'operator-declared-unobserved', executionOrigin: null, ...(row.execution.kind === 'declared-interruption' ? { interruption: { phase: row.execution.phase, reason: row.execution.reason } } : {}) };
    return { case: row, scenario, session, caseDigest, inputContextDigest, execution, contextDigest: digest({ corpus: corpus.corpus, caseDigest, inputContextDigest, execution, evidenceDigest: session.frozenEvidence.digest, frozenAt }) };
  });
}
export function privateCorpusSummary(corpus: PrivateCorpus, attempts: PrivateCorpusAttempt[], knownDevelopmentChecked = false) {
  const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
  return { mode: 'validation-only', corpus: corpus.corpus, corpusDigest: digest(corpus), cases: attempts.length, scenarios: count(corpus.cases.map(row => `${row.scenarioId}@${row.scenarioVersion}`)), conditions: count(corpus.cases.map(row => row.condition)), sources: count(corpus.cases.map(row => row.source.kind)), executions: count(attempts.map(row => row.execution.kind)), providerCalls: 0, expertReviews: 0, qualification: 'pending', proposedCuratedAttemptRange: [40, 60], knownDevelopmentOverlapCheck: knownDevelopmentChecked ? 'performed-by-cli-loader' : 'not-requested', independence: corpus.independence.sealedFromPromptDevelopment ? 'operator-attestation-not-independent-verification' : 'not-attested', existingRoleWorkflow: 'unsupported-private-split-import' };
}
export function exportPrivateCorpusContexts(corpusInput: unknown, capturesInput: unknown = { schemaVersion: 1, provenance: 'private-corpus-captures', captures: [] }) {
  const corpus = validatePrivateCorpus(corpusInput), attempts = materializePrivateCorpus(corpus, capturesInput);
  return { schemaVersion: 1, artifact: 'private-corpus-context-export', corpus: corpus.corpus, corpusDigest: digest(corpus), qualification: 'pending', existingRoleWorkflow: { status: 'unsupported', reason: 'The existing recorder/reviewer is bound to development-regression. Do not relabel these cases or feed this export into its legacy input schemas.' }, cases: attempts.map(attempt => ({ caseId: attempt.case.id, caseDigest: attempt.caseDigest, inputContextDigest: attempt.inputContextDigest, contextDigest: attempt.contextDigest, source: attempt.case.source, condition: attempt.case.condition, reviewFocus: attempt.case.reviewFocus, scenario: { ...attempt.session.scenario, probes: attempt.scenario.probes }, rubricVersion: attempt.case.rubricVersion, rubricDigest: attempt.case.rubricDigest, runtime: attempt.case.runtime, fixtureVersion: attempt.case.fixtureVersion, snapshotVersion: attempt.case.snapshot.version, execution: attempt.execution, session: attempt.session, reviews: [], adjudication: null })) };
}

/** No code runs unless both explicit gates pass. Current binding must match the
 * private plan; imported runtime identities never select execution commands. */
export async function capturePrivateCases(corpusInput: unknown, caseIds: string[], options: { enabled: boolean; acknowledgeIsolatedHost: boolean; operatorId: string; signal?: AbortSignal; execute?: (scenario: Scenario, files: Record<string, string>, options: ExecuteOptions) => Promise<RunExecution>; binding?: (scenario: Scenario) => RuntimeBinding | null; now?: () => Date; persist: (captures: PrivateCaptureSet) => Promise<void> }): Promise<PrivateCaptureSet> {
  if (!options.enabled || !options.acknowledgeIsolatedHost || !identifier.safeParse(options.operatorId).success || !caseIds.length || caseIds.length > PRIVATE_CORPUS_LIMITS.captureBatch || new Set(caseIds).size !== caseIds.length) reject('capture_policy');
  const corpus = validatePrivateCorpus(corpusInput, { purpose: 'capture' }), rows = caseIds.map(id => corpus.cases.find(row => row.id === id));
  if (rows.some(row => !row || row.execution.kind === 'captured')) reject('capture_policy');
  const inputs = rows.map(row => { const scenario = scenarioFor(row!); const binding = (options.binding ?? configuredRuntimeBinding)(scenario); if (!binding || !same(binding, row!.runtime)) reject('capture_policy'); return { row: row!, scenario, binding }; });
  const result: PrivateCaptureSet = { schemaVersion: 1, provenance: 'private-corpus-captures', captures: [] }, now = options.now ?? (() => new Date());
  await options.persist(structuredClone(result));
  const execute = options.execute ?? (await import('../lib/runtime/runner')).executeScenario;
  for (const { row, scenario, binding } of inputs) {
    if (options.signal?.aborted) reject('capture_policy');
    const startedAt = now().toISOString(), run = await execute(scenario, structuredClone(row.snapshot.files), { signal: options.signal, includeProtected: true, runtimeBinding: binding, selection: 'authored' }), completedAt = now().toISOString();
    const capture: PrivateCapture = { schemaVersion: 1, corpus: corpus.corpus, caseId: row.id, inputContextDigest: privateInputContextDigest(corpus.corpus, row), scenarioId: row.scenarioId, scenarioVersion: row.scenarioVersion, scenarioDigest: row.scenarioDigest, rubricVersion: row.rubricVersion, rubricDigest: row.rubricDigest, fixtureVersion: row.fixtureVersion, snapshotVersion: row.snapshot.version, snapshotSha256: row.snapshot.sha256, testSuiteDigest: digest(scenario.tests), runtime: binding, provenance: 'operator-supplied-isolated-runner-record', executionOrigin: 'offline-snapshot-replay', operatorId: options.operatorId, startedAt, completedAt, recordedAt: now().toISOString(), run: checked(runSchema, run) };
    result.captures.push(capture); validatePrivateCaptures(result, corpus, { requireReferenced: false }); await options.persist(structuredClone(result));
  }
  return result;
}

async function noSymlinks(path: string) {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) { cursor = resolve(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) reject('private_file'); }
  return absolute;
}
export async function readPrivateJson(path: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const absolute = await noSymlinks(path), metadata = await lstat(absolute), parent = await lstat(dirname(absolute));
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || !parent.isDirectory() || (parent.mode & 0o077) !== 0 || metadata.size > PRIVATE_CORPUS_LIMITS.bytes) reject('private_file');
    file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat(); if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > PRIVATE_CORPUS_LIMITS.bytes) reject('private_file');
    const bytes = Buffer.alloc(opened.size + 1); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset !== opened.size || offset > PRIVATE_CORPUS_LIMITS.bytes || (await file.stat()).size !== opened.size) reject('private_file');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) as unknown;
  } catch { reject('private_file'); }
  finally { await file?.close(); }
}
export async function createPrivateJson(path: string, value: unknown): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const absolute = resolve(path); await preparePrivateDirectory(dirname(absolute));
    const parent = await lstat(dirname(absolute)), bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if ((parent.mode & 0o077) !== 0 || bytes.length > PRIVATE_CORPUS_LIMITS.bytes) reject('private_file');
    file = await open(absolute, 'wx', 0o600); await file.writeFile(bytes); await file.sync();
  } catch { reject('private_file'); }
  finally { await file?.close(); }
}
export async function preparePrivateDirectory(path: string, exclusive = false): Promise<void> {
  try {
    const absolute = resolve(path), root = parse(absolute).root; let cursor = root;
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part);
      let metadata, created = false;
      try { metadata = await lstat(cursor); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(cursor, { mode: 0o700 }); created = true; metadata = await lstat(cursor); }
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || (exclusive && cursor === absolute && !created)) reject('private_file');
    }
    if (((await lstat(absolute)).mode & 0o077) !== 0) reject('private_file');
  } catch { reject('private_file'); }
}
export async function loadPrivateCorpus(path: string, options: { purpose?: 'validation' | 'evaluation-export' | 'capture' | 'prompt-development'; capturePaths?: string[]; comparisonPaths?: string[] } = {}) {
  if ((options.capturePaths?.length ?? 0) > 10 || (options.comparisonPaths?.length ?? 0) > 10) reject('private_file');
  const known = await developmentCorpusIndex();
  for (const otherPath of options.comparisonPaths ?? []) known.push(...privateCorpusIndex(validatePrivateCorpus(await readPrivateJson(otherPath))));
  const corpus = validatePrivateCorpus(await readPrivateJson(path), { purpose: options.purpose, otherCorpora: known });
  const imported: PrivateCapture[] = [];
  for (const capturePath of options.capturePaths ?? []) { imported.push(...checked(privateCaptureSetSchema, await readPrivateJson(capturePath)).captures); if (imported.length > PRIVATE_CORPUS_LIMITS.captures) reject('schema'); }
  const captures = validatePrivateCaptures({ schemaVersion: 1, provenance: 'private-corpus-captures', captures: imported }, corpus);
  return { corpus, captures, attempts: materializePrivateCorpus(corpus, captures) };
}
export function privateCorpusTemplate(split: PrivateCorpus['corpus']['split'], id: string, corpusVersion: string, custodianId: string, now = new Date()): PrivateCorpus {
  return checked(privateCorpusSchema, { schemaVersion: 1, corpus: { id, version: corpusVersion, split }, createdAt: now.toISOString(), provenance: 'operator-supplied-private-corpus', independence: { sealedFromPromptDevelopment: false, custodianId }, cases: [] });
}
