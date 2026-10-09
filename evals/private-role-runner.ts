import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assist, coach, interview, PROMPT_VERSION, ProviderFailure } from '../lib/ai/provider';
import { INPUT_BYTES, modelPolicy, type AiRole } from '../lib/ai/policy';
import { digest, validateFiles } from '../lib/interview-practice/domain';
import { validateInterviewProposal, validateReport } from '../lib/interview-practice/evidence';
import type { JobResult, Session } from '../lib/interview-practice/types';
import { capabilities } from '../lib/server/config';
import { developmentCorpusIndex, materializePrivateCorpus, privateCorpusSchema, validatePrivateCorpus, type PrivateCorpus, type PrivateCorpusAttempt } from './private-corpus';
import { EVALUATION_ROLES, roleRunSchema, type EvaluationRole } from './role-runner';

const hash = z.string().regex(/^[a-f0-9]{64}$/), identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const privateRoleRunSchema = roleRunSchema.omit({ provenance: true, corpus: true, benchmarkVersion: true, benchmarkDigest: true, planned: true, stopReason: true }).extend({
  artifact: z.literal('private-corpus-model-run'), provenance: z.literal('operator-private-model-evaluation'),
  corpus: privateCorpusSchema.shape.corpus, corpusDigest: hash, planDigest: hash, operatorId: identifier,
  holdoutUnlockDigest: hash.nullable(), stopReason: z.enum(['uncertain-charge', 'cost-bound-exceeded', 'operator-cancelled']).nullable(),
  planned: z.array(roleRunSchema.shape.planned.element.extend({ caseDigest: hash, privateContextDigest: hash, inputContextDigest: hash, executionDigest: hash, runtimeBindingDigest: hash }).strict()).min(1).max(300),
}).strict();
export const holdoutUnlockSchema = z.object({ version: z.literal(1), purpose: z.literal('one-run-heldout-model-evaluation'), corpus: privateCorpusSchema.shape.corpus, corpusDigest: hash, runId: z.string().uuid(), custodianId: identifier, authorizedOperatorId: identifier, acknowledgedAt: z.string().datetime() }).strict();
export type PrivateRoleRun = z.infer<typeof privateRoleRunSchema>;
export type PrivateRoleContext = { corpus: unknown; captures?: unknown; holdoutUnlock?: unknown };
export type PrivateRoleTask = { attempt: PrivateCorpusAttempt; role: EvaluationRole; session: Session; input: { mode: 'ask' | 'plan' | 'edit'; prompt: string } | null; contextDigest: string; reservedUsd: number };
export type PrivateRoleExecutor = (task: PrivateRoleTask) => Promise<JobResult>;
export const privateTaskKey = (row: { caseId: string; role: string }) => JSON.stringify([row.caseId, row.role]);
const providerRole = (role: EvaluationRole): AiRole => role.startsWith('assistant-') ? 'assistant' : role as 'interviewer' | 'coach';
const reserve = (policy: PrivateRoleRun['policy'], role: EvaluationRole) => Math.ceil((INPUT_BYTES[providerRole(role)] + 8000) * policy.inputRate + policy.maxOutput * policy.outputRate) / 1_000_000;
const requests = {
  ask: 'Explain how the current implementation relates to the stated requirements. Identify one useful next check. Do not claim that you executed anything.',
  plan: 'Propose a short plan for checking and improving this implementation against the stated requirements. Do not change files or claim execution.',
  edit: 'Propose a minimal change to the existing implementation that addresses a stated requirement. Explain the change and checks to run. Do not claim execution.',
} as const;
const privatePlanDigest = (corpus: PrivateCorpus['corpus'], corpusDigest: string, promptVersion: string, planned: PrivateRoleRun['planned']) => digest({ format: 'private-role-context-v1', corpus, corpusDigest, promptVersion, planned: planned.map(({ reservedUsd, ...row }) => { void reservedUsd; return row; }) });
function checkedUnlock(value: unknown, corpus: PrivateCorpus, corpusDigest: string, operatorId: string, createdAt: string) {
  const unlock = holdoutUnlockSchema.parse(value);
  if (digest(unlock.corpus) !== digest(corpus.corpus) || unlock.corpusDigest !== corpusDigest || unlock.custodianId !== corpus.independence.custodianId || unlock.authorizedOperatorId !== operatorId || Date.parse(unlock.acknowledgedAt) > Date.parse(createdAt)) throw new Error('A matching separate custodian holdout unlock is required.');
  return { digest: digest(unlock), runId: unlock.runId };
}

/** Pure reconstruction: current provider pricing/configuration is never consulted. */
export function createPrivateRoleContexts(context: PrivateRoleContext, roles: EvaluationRole[] = [...EVALUATION_ROLES], promptVersion = PROMPT_VERSION) {
  const corpus = validatePrivateCorpus(context.corpus, { purpose: 'evaluation-export' }), attempts = materializePrivateCorpus(corpus, context.captures);
  if (!attempts.length || attempts.length > 60 || !roles.length || new Set(roles).size !== roles.length || roles.some(role => !EVALUATION_ROLES.includes(role)) || !promptVersion.trim()) throw new Error('Select one to sixty private cases and distinct supported roles.');
  const corpusDigest = digest(corpus);
  const tasks = attempts.flatMap(attempt => roles.map(role => {
    const session = structuredClone(attempt.session); let input: PrivateRoleTask['input'] = null;
    if (role.startsWith('assistant-')) {
      const mode = role.slice('assistant-'.length) as 'ask' | 'plan' | 'edit';
      session.lifecycle = 'active'; session.stageId = attempt.scenario.stages.find(stage => stage.id !== 'debrief')!.id; session.codeFrozenSnapshotId = null; session.frozenEvidence = null;
      input = { mode, prompt: requests[mode] };
    }
    const contextDigest = digest({ format: 'private-role-context-v1', corpus: corpus.corpus, corpusDigest, caseDigest: attempt.caseDigest, privateContextDigest: attempt.contextDigest, role, promptVersion, stageId: session.stageId, workspace: digest(session.files), input });
    return { attempt, role, session, input, contextDigest };
  }));
  const contexts = tasks.map(task => ({ caseId: task.attempt.case.id, role: task.role, contextDigest: task.contextDigest, caseDigest: task.attempt.caseDigest, privateContextDigest: task.attempt.contextDigest, inputContextDigest: task.attempt.inputContextDigest, executionDigest: digest(task.attempt.execution), runtimeBindingDigest: digest(task.attempt.case.runtime), scenarioId: task.attempt.scenario.id, scenarioVersion: task.attempt.scenario.version, scenarioDigest: task.attempt.case.scenarioDigest, rubricVersion: task.attempt.case.rubricVersion, evidenceDigest: task.attempt.session.frozenEvidence!.digest, runtimeDigests: [...new Set(task.attempt.session.runs.map(run => run.runtimeDigest ?? null))] }));
  return { corpus, corpusDigest, tasks, contexts };
}
export function createPrivateRolePlan(context: PrivateRoleContext, roles?: EvaluationRole[]) {
  const contexts = createPrivateRoleContexts(context, roles), policy = modelPolicy();
  const tasks = contexts.tasks.map(task => ({ ...task, reservedUsd: reserve(policy, task.role) })), planned = contexts.contexts.map(row => ({ ...row, reservedUsd: reserve(policy, row.role) }));
  return { ...contexts, policy, tasks, planned, planDigest: privatePlanDigest(contexts.corpus.corpus, contexts.corpusDigest, PROMPT_VERSION, planned), estimatedUpperUsd: planned.reduce((sum, row) => sum + row.reservedUsd, 0) };
}
function validateOutput(task: Omit<PrivateRoleTask, 'reservedUsd'>, output: PrivateRoleRun['entries'][number]['output']) {
  if (!output || output.kind !== providerRole(task.role)) throw new Error('The private candidate role does not match.');
  if (output.kind === 'coach') validateReport(output.report, task.attempt.scenario, task.session.frozenEvidence!);
  else if (output.kind === 'interviewer') validateInterviewProposal(output.proposal, task.attempt.scenario, task.session);
  else {
    const paths = Object.keys(output.files);
    if (paths.some(path => !Object.hasOwn(task.session.files, path)) || (task.input!.mode !== 'edit' && paths.length)) throw new Error('Private assistant candidate exceeds its request/workspace policy.');
    if (paths.length) validateFiles({ ...task.session.files, ...output.files }, task.attempt.scenario);
  }
  return output;
}

/** Revalidate exact private contexts and recorded accounting without model calls. */
export function validatePrivateRoleRun(value: unknown, context: PrivateRoleContext) {
  const run = privateRoleRunSchema.parse(value), roles = [...new Set(run.planned.map(row => row.role))];
  const authored = createPrivateRoleContexts(context, roles, run.promptVersion);
  if (digest(run.corpus) !== digest(authored.corpus.corpus) || run.corpusDigest !== authored.corpusDigest || privatePlanDigest(run.corpus, run.corpusDigest, run.promptVersion, run.planned) !== run.planDigest) throw new Error('Private corpus/plan identity changed.');
  if ((run.corpus.split === 'holdout') !== Boolean(run.holdoutUnlockDigest)) throw new Error('Holdout recording requires a bound custodian unlock.');
  if (run.corpus.split === 'holdout') { const unlock = checkedUnlock(context.holdoutUnlock, authored.corpus, authored.corpusDigest, run.operatorId, run.createdAt); if (unlock.digest !== run.holdoutUnlockDigest || unlock.runId !== run.runId) throw new Error('Recorded custodian unlock changed.'); }
  const expected = new Map(authored.contexts.map(row => [privateTaskKey(row), row])), tasks = new Map(authored.tasks.map(task => [privateTaskKey({ caseId: task.attempt.case.id, role: task.role }), task]));
  if (run.planned.length !== expected.size || new Set(run.planned.map(privateTaskKey)).size !== run.planned.length) throw new Error('Private planned coverage changed.');
  for (const row of run.planned) {
    const { reservedUsd, ...actual } = row;
    if (digest(actual) !== digest(expected.get(privateTaskKey(row))) || reservedUsd !== reserve(run.policy, row.role)) throw new Error('Private context/reservation binding changed.');
  }
  if (run.entries.length > run.planned.length || run.entries.some((entry, index) => privateTaskKey(entry) !== privateTaskKey(run.planned[index]) || entry.contextDigest !== run.planned[index].contextDigest || entry.reservedUsd !== run.planned[index].reservedUsd)) throw new Error('Private journal entries are not an exact planned prefix.');
  if ((run.state !== 'stopped' && run.stopReason !== null) || (run.state === 'stopped' && run.stopReason === null) || (run.state === 'completed' && (run.entries.length !== run.planned.length || run.entries.some(entry => ['reserved', 'uncertain'].includes(entry.state))))) throw new Error('Private journal completion state changed.');
  for (const [index, entry] of run.entries.entries()) {
    const inference = entry.inference;
    if (inference && (Date.parse(inference.startedAt) < Date.parse(run.createdAt) || Date.parse(inference.completedAt) < Date.parse(inference.startedAt))) throw new Error('Private provider chronology changed.');
    if (inference && (entry.knownUsd !== inference.usd || entry.uncertainUsd !== 0)) throw new Error('Private known provider accounting changed.');
    if (entry.state === 'validated') {
      if (!inference?.validated || !inference.responseId || /^(?:authored|synthetic|fixture)/.test(inference.returnedModel) || inference.requestedModel !== run.policy.model || inference.promptVersion !== run.promptVersion || entry.knownUsd !== inference.usd || entry.uncertainUsd !== 0 || entry.failure !== null) throw new Error('Private validated candidate lacks matching provider provenance.');
      validateOutput(tasks.get(privateTaskKey(entry))!, entry.output);
    } else if (entry.output !== null) throw new Error('Unvalidated private candidates cannot carry output.');
    if (entry.state === 'reserved' && (index !== run.entries.length - 1 || run.state === 'completed' || entry.knownUsd !== 0 || entry.uncertainUsd !== entry.reservedUsd || inference !== null || entry.failure !== null)) throw new Error('Outstanding private reservation changed.');
    if (entry.state === 'uncertain' && (index !== run.entries.length - 1 || run.stopReason !== 'uncertain-charge' || entry.uncertainUsd !== entry.reservedUsd || entry.knownUsd !== 0 || inference !== null)) throw new Error('Private uncertain charge must stop admission.');
    if (entry.state === 'rejected' && (entry.failure === null || entry.uncertainUsd !== 0)) throw new Error('Private rejection lacks a terminal observation.');
    if (entry.knownUsd > entry.reservedUsd + 0.000001 && (run.stopReason !== 'cost-bound-exceeded' || entry.failure !== 'cost-bound-exceeded')) throw new Error('Private cost bound violation must stop admission.');
  }
  const terminal = run.entries.at(-1);
  if (run.stopReason === 'uncertain-charge' && terminal?.state !== 'uncertain') throw new Error('Private uncertain stop lacks an uncertain reservation.');
  if (run.stopReason === 'cost-bound-exceeded' && (!terminal || terminal.failure !== 'cost-bound-exceeded' || terminal.knownUsd <= terminal.reservedUsd + 0.000001)) throw new Error('Private cost stop lacks an actual bound violation.');
  return { run, ...authored };
}

/** Explicit paid admission only. The caller persists a reservation before inference. */
export async function recordPrivateRoleRun(context: PrivateRoleContext, options: { enabled: boolean; acknowledgePaidApi: boolean; maxUsd: number; operatorId: string; holdoutUnlock?: unknown; roles?: EvaluationRole[]; persist: (run: PrivateRoleRun) => Promise<void>; executor?: PrivateRoleExecutor; now?: () => Date; signal?: AbortSignal }): Promise<PrivateRoleRun> {
  if (!options.enabled || !options.acknowledgePaidApi || !identifier.safeParse(options.operatorId).success || !Number.isFinite(options.maxUsd) || options.maxUsd <= 0 || options.maxUsd > 1000) throw new Error('Private recording requires explicit gates, operator and bounded spending cap.');
  const verifiedCorpus = validatePrivateCorpus(context.corpus, { purpose: 'evaluation-export', otherCorpora: await developmentCorpusIndex() });
  const plan = createPrivateRolePlan({ ...context, corpus: verifiedCorpus }, options.roles), now = options.now ?? (() => new Date()), createdAt = now().toISOString(); let holdoutUnlockDigest: string | null = null; let runId: string = randomUUID();
  if (plan.corpus.corpus.split === 'holdout') {
    const unlock = checkedUnlock(options.holdoutUnlock, plan.corpus, plan.corpusDigest, options.operatorId, createdAt); holdoutUnlockDigest = unlock.digest; runId = unlock.runId;
  } else if (options.holdoutUnlock !== undefined) throw new Error('Holdout unlock cannot relabel another split.');
  if (plan.estimatedUpperUsd > options.maxUsd + Number.EPSILON) throw new Error('Private planned reservations exceed the spending cap.');
  if (!options.executor) { const caps = capabilities(); if (!caps.ai || (plan.tasks.some(task => task.role === 'coach') && !caps.coaching)) throw new Error('Selected private provider roles are unavailable.'); }
  const run: PrivateRoleRun = { version: 1, artifact: 'private-corpus-model-run', provenance: 'operator-private-model-evaluation', corpus: plan.corpus.corpus, corpusDigest: plan.corpusDigest, planDigest: plan.planDigest, operatorId: options.operatorId, holdoutUnlockDigest, runId, policy: plan.policy, promptVersion: PROMPT_VERSION, createdAt, state: 'running', stopReason: null, planned: plan.planned, entries: [] };
  await options.persist(structuredClone(run));
  for (const task of plan.tasks) {
    if (options.signal?.aborted) { run.state = 'stopped'; run.stopReason = 'operator-cancelled'; break; }
    const entry: PrivateRoleRun['entries'][number] = { caseId: task.attempt.case.id, role: task.role, contextDigest: task.contextDigest, state: 'reserved', reservedUsd: task.reservedUsd, knownUsd: 0, uncertainUsd: task.reservedUsd, failure: null, inference: null, output: null };
    run.entries.push(entry); await options.persist(structuredClone(run)); let result: JobResult | undefined;
    try {
      result = await (options.executor ? options.executor(task) : task.role === 'coach' ? coach(task.attempt.scenario, task.session) : task.role === 'interviewer' ? interview(task.attempt.scenario, task.session) : assist(task.attempt.scenario, task.session, task.input!));
      const inference = roleRunSchema.shape.entries.element.shape.inference.unwrap().parse(result.inference); entry.inference = inference;
      if (!inference.validated || !inference.responseId || inference.requestedModel !== run.policy.model || inference.promptVersion !== run.promptVersion || /^(?:authored|synthetic|fixture)/.test(inference.returnedModel) || Date.parse(inference.startedAt) < Date.parse(createdAt) || Date.parse(inference.completedAt) < Date.parse(inference.startedAt)) throw new Error('Private provider provenance is missing.');
      const output = result.kind === 'coach' ? { kind: result.kind, report: result.report } : result.kind === 'interviewer' ? { kind: result.kind, proposal: result.proposal } : result.kind === 'assistant' ? { kind: result.kind, message: result.message, files: result.files ?? {} } : null;
      entry.output = validateOutput(task, roleRunSchema.shape.entries.element.shape.output.unwrap().parse(output)); entry.state = 'validated';
    } catch (error) {
      const inference = result?.inference ?? (error instanceof ProviderFailure ? error.inference : undefined);
      const parsed = roleRunSchema.shape.entries.element.shape.inference.unwrap().safeParse(inference); if (parsed.success) entry.inference = parsed.data;
      entry.output = null; entry.state = 'rejected'; entry.failure = entry.inference ? 'provider-or-validation' : 'missing-provenance';
      if (!result && error instanceof ProviderFailure && !error.mayHaveBilled) entry.uncertainUsd = 0;
    }
    const actual = entry.inference?.usd ?? result?.actualUsd;
    if (actual !== undefined && Number.isFinite(actual) && actual >= 0) { entry.knownUsd = actual; entry.uncertainUsd = 0; }
    if (entry.knownUsd > entry.reservedUsd + 0.000001) { entry.state = 'rejected'; entry.output = null; entry.failure = 'cost-bound-exceeded'; run.state = 'stopped'; run.stopReason = 'cost-bound-exceeded'; }
    else if (entry.uncertainUsd > 0) { entry.state = 'uncertain'; entry.output = null; run.state = 'stopped'; run.stopReason = 'uncertain-charge'; }
    await options.persist(structuredClone(run)); if (run.state === 'stopped') break;
  }
  if (run.state !== 'stopped') run.state = 'completed';
  await options.persist(structuredClone(run)); return run;
}
