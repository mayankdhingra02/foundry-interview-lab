import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assist, coach, interview, PROMPT_VERSION, ProviderFailure } from '../lib/ai/provider';
import { inferenceReservations, modelPolicy, type AiRole } from '../lib/ai/policy';
import { capabilities } from '../lib/server/config';
import { digest, validateFiles } from '../lib/interview-practice/domain';
import { coachOutputSchema, interviewProposalSchema, validateInterviewProposal, validateReport } from '../lib/interview-practice/evidence';
import type { JobResult, Session } from '../lib/interview-practice/types';
import { attemptContextDigest, type BenchmarkAttempt } from './benchmark';

export const EVALUATION_ROLES = ['interviewer', 'coach', 'assistant-ask', 'assistant-plan', 'assistant-edit'] as const;
export type EvaluationRole = typeof EVALUATION_ROLES[number];
const roleSchema = z.enum(EVALUATION_ROLES);
const finiteUsd = z.number().finite().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inferenceSchema = z.object({ requestedModel: z.string().min(1), returnedModel: z.string().min(1), promptVersion: z.string().min(1), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), providerRequestId: z.string().optional(), responseId: z.string().optional(), startedAt: z.string().datetime(), completedAt: z.string().datetime(), usd: finiteUsd, validated: z.boolean() }).strict();
const assistantOutputSchema = z.object({ message: z.string().trim().min(1).max(16000), files: z.record(z.string().max(64000)) }).strict();
const outputSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('interviewer'), proposal: interviewProposalSchema }).strict(), z.object({ kind: z.literal('coach'), report: coachOutputSchema }).strict(), z.object({ kind: z.literal('assistant'), ...assistantOutputSchema.shape }).strict()]);
const plannedTaskSchema = z.object({ caseId: z.string().min(1), role: roleSchema, contextDigest: hash, reservedUsd: finiteUsd, scenarioId: z.string().min(1), scenarioVersion: z.string().min(1), scenarioDigest: hash, rubricVersion: z.string().min(1), evidenceDigest: hash, runtimeDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()).max(100) }).strict();
export const roleRunSchema = z.object({
  version: z.literal(1), provenance: z.literal('operator-model-evaluation'), corpus: z.literal('development-regression'), benchmarkVersion: z.string().min(1), benchmarkDigest: hash, runId: z.string().uuid(),
  policy: z.object({ model: z.string().min(1), inputRate: finiteUsd, outputRate: finiteUsd, maxOutput: z.number().int().positive() }).strict(), promptVersion: z.string().min(1), createdAt: z.string().datetime(),
  state: z.enum(['running', 'completed', 'stopped']), stopReason: z.enum(['uncertain-charge', 'cost-bound-exceeded']).nullable(),
  planned: z.array(plannedTaskSchema).min(1).max(300),
  entries: z.array(z.object({ caseId: z.string().min(1), role: roleSchema, contextDigest: hash, state: z.enum(['reserved', 'validated', 'rejected', 'uncertain']), reservedUsd: finiteUsd, knownUsd: finiteUsd, uncertainUsd: finiteUsd, failure: z.enum(['provider-or-validation', 'missing-provenance', 'cost-bound-exceeded']).nullable(), inference: inferenceSchema.nullable(), output: outputSchema.nullable() }).strict()).max(300)
}).strict();
export type RoleRun = z.infer<typeof roleRunSchema>;
type RoleTask = { attempt: BenchmarkAttempt; role: EvaluationRole; session: Session; input: { mode: 'ask' | 'plan' | 'edit'; prompt: string } | null; contextDigest: string; reservedUsd: number };
export type RoleExecutor = (task: RoleTask) => Promise<JobResult>;
const providerRole = (role: EvaluationRole): AiRole => role.startsWith('assistant-') ? 'assistant' : role as 'interviewer' | 'coach';
const planDigest = (version: string, planned: RoleRun['planned']) => digest({ version, planned: planned.map(({ reservedUsd, ...context }) => { void reservedUsd; return context; }) });
const assistantRequests = {
  ask: 'Explain how the current implementation relates to the stated requirements. Identify one useful next check. Do not claim that you executed anything.',
  plan: 'Propose a short plan for checking and improving this implementation against the stated requirements. Do not change files or claim execution.',
  edit: 'Propose a minimal change to the existing implementation that addresses a stated requirement. Explain the change and checks to run. Do not claim execution.'
} as const;

export function createRolePlan(version: string, attempts: BenchmarkAttempt[], roles: EvaluationRole[] = [...EVALUATION_ROLES]) {
  if (!version.trim() || !attempts.length || attempts.length > 60 || new Set(attempts.map(row => row.recipe.id)).size !== attempts.length) throw new Error('Select one to sixty distinct benchmark attempts.');
  if (!roles.length || new Set(roles).size !== roles.length || roles.some(role => !roleSchema.safeParse(role).success)) throw new Error('Select distinct supported evaluation roles.');
  const policy = modelPolicy(), reservations = inferenceReservations();
  const tasks: RoleTask[] = attempts.flatMap(attempt => roles.map(role => {
    const session = structuredClone(attempt.session);
    let input: RoleTask['input'] = null;
    if (role.startsWith('assistant-')) {
      const mode = role.slice('assistant-'.length) as 'ask' | 'plan' | 'edit';
      session.lifecycle = 'active'; session.stageId = attempt.scenario.stages.find(stage => stage.id !== 'debrief')!.id;
      session.codeFrozenSnapshotId = null; session.frozenEvidence = null;
      input = { mode, prompt: assistantRequests[mode] };
    }
    return { attempt, role, session, input, contextDigest: digest({ attempt: attemptContextDigest(attempt), role, stageId: session.stageId, workspace: digest(session.files), input }), reservedUsd: reservations[providerRole(role)] };
  }));
  const planned = tasks.map(({ attempt, role, contextDigest, reservedUsd }) => ({ caseId: attempt.recipe.id, role, contextDigest, reservedUsd, scenarioId: attempt.scenario.id, scenarioVersion: attempt.scenario.version, scenarioDigest: attempt.session.scenarioDigest, rubricVersion: attempt.scenario.version, evidenceDigest: attempt.session.frozenEvidence!.digest, runtimeDigests: [...new Set(attempt.session.runs.map(run => run.runtimeDigest ?? null))] }));
  const benchmarkDigest = planDigest(version, planned);
  return { policy, tasks, planned, benchmarkDigest, estimatedUpperUsd: planned.reduce((total, row) => total + row.reservedUsd, 0) };
}

const executeProductionRole: RoleExecutor = task => task.role === 'interviewer' ? interview(task.attempt.scenario, task.session) : task.role === 'coach' ? coach(task.attempt.scenario, task.session) : assist(task.attempt.scenario, task.session, task.input!);

function validatedOutput(task: RoleTask, result: JobResult) {
  if (result.kind !== providerRole(task.role)) throw new Error('Mismatched role.');
  if (result.kind === 'interviewer') return { kind: result.kind, proposal: validateInterviewProposal(result.proposal, task.attempt.scenario, task.session) } as const;
  if (result.kind === 'coach') return { kind: result.kind, report: validateReport(result.report, task.attempt.scenario, task.session.frozenEvidence!) } as const;
  if (result.kind !== 'assistant') throw new Error('Unexpected execution result.');
  const output = assistantOutputSchema.parse({ message: result.message, files: result.files ?? {} });
  const paths = Object.keys(output.files);
  if (paths.some(path => !Object.hasOwn(task.session.files, path)) || (task.input!.mode !== 'edit' && paths.length)) throw new Error('Assistant exceeded the file policy.');
  if (paths.length) validateFiles({ ...task.session.files, ...output.files }, task.attempt.scenario);
  return { kind: result.kind, ...output } as const;
}

/** Journals reservations before any provider call. Never retries or resumes paid work. */
export async function recordRoleRun(version: string, attempts: BenchmarkAttempt[], options: { acknowledgePaidApi: boolean; maxUsd: number; roles?: EvaluationRole[]; persist: (run: RoleRun) => Promise<void>; executor?: RoleExecutor; now?: () => Date }): Promise<RoleRun> {
  if (options.acknowledgePaidApi !== true) throw new Error('Paid API calls require an explicit acknowledgement.');
  if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0 || options.maxUsd > 1000) throw new Error('Configure a finite benchmark spending cap between zero and 1000 USD.');
  const plan = createRolePlan(version, attempts, options.roles);
  if (plan.estimatedUpperUsd > options.maxUsd + Number.EPSILON) throw new Error('The complete planned reservation exceeds the benchmark spending cap.');
  if (!options.executor) {
    const caps = capabilities();
    if (!caps.ai || (plan.tasks.some(task => task.role === 'coach') && !caps.coaching)) throw new Error('The selected production provider roles must be configured before recording.');
  }
  const now = options.now ?? (() => new Date());
  const run: RoleRun = { version: 1, provenance: 'operator-model-evaluation', corpus: 'development-regression', benchmarkVersion: version, benchmarkDigest: plan.benchmarkDigest, runId: randomUUID(), policy: plan.policy, promptVersion: PROMPT_VERSION, createdAt: now().toISOString(), state: 'running', stopReason: null, planned: plan.planned, entries: [] };
  await options.persist(structuredClone(run));
  for (const task of plan.tasks) {
    const entry: RoleRun['entries'][number] = { caseId: task.attempt.recipe.id, role: task.role, contextDigest: task.contextDigest, state: 'reserved', reservedUsd: task.reservedUsd, knownUsd: 0, uncertainUsd: task.reservedUsd, failure: null, inference: null, output: null };
    run.entries.push(entry);
    await options.persist(structuredClone(run));
    let result: JobResult | undefined;
    try {
      result = await (options.executor ?? executeProductionRole)(task);
      const inference = inferenceSchema.parse(result.inference);
      entry.inference = inference;
      if (inference.requestedModel !== plan.policy.model || inference.promptVersion !== PROMPT_VERSION || !inference.validated || !inference.responseId || /^(?:authored|synthetic|fixture)/.test(inference.returnedModel) || Date.parse(inference.completedAt) < Date.parse(inference.startedAt)) throw new Error('Missing recorded provider provenance.');
      entry.output = validatedOutput(task, result);
      entry.state = 'validated';
    } catch (error) {
      const inference = result?.inference ?? (error instanceof ProviderFailure ? error.inference : undefined);
      if (inference && inferenceSchema.safeParse(inference).success) entry.inference = inference;
      entry.output = null;
      entry.state = 'rejected'; entry.failure = entry.inference ? 'provider-or-validation' : 'missing-provenance';
      if (!result && error instanceof ProviderFailure && !error.mayHaveBilled) { entry.knownUsd = 0; entry.uncertainUsd = 0; }
    }
    const actual = entry.inference?.usd ?? result?.actualUsd;
    if (actual !== undefined && Number.isFinite(actual) && actual >= 0) { entry.knownUsd = actual; entry.uncertainUsd = 0; }
    if (entry.knownUsd > entry.reservedUsd + 0.000001) { entry.state = 'rejected'; entry.output = null; entry.failure = 'cost-bound-exceeded'; run.state = 'stopped'; run.stopReason = 'cost-bound-exceeded'; }
    else if (entry.uncertainUsd > 0) { entry.state = 'uncertain'; entry.output = null; run.state = 'stopped'; run.stopReason = 'uncertain-charge'; }
    await options.persist(structuredClone(run));
    if (run.state === 'stopped') break;
  }
  if (run.state !== 'stopped') run.state = 'completed';
  await options.persist(structuredClone(run));
  return run;
}

function checkedRun(value: unknown): RoleRun {
  const run = roleRunSchema.parse(value);
  const key = (row: { caseId: string; role: string }) => `${row.caseId}:${row.role}`;
  const planned = new Map(run.planned.map(row => [key(row), row]));
  if (planned.size !== run.planned.length || new Set(run.entries.map(key)).size !== run.entries.length || run.entries.some(entry => !planned.has(key(entry)) || entry.contextDigest !== planned.get(key(entry))!.contextDigest || entry.reservedUsd !== planned.get(key(entry))!.reservedUsd)) throw new Error('Model run entries do not match their unique planned contexts.');
  if (planDigest(run.benchmarkVersion, run.planned) !== run.benchmarkDigest) throw new Error('The model run benchmark digest does not match.');
  if (run.state === 'completed' && (run.entries.length !== run.planned.length || run.entries.some(entry => entry.state === 'reserved'))) throw new Error('The completed run is missing terminal entries.');
  if ((run.state !== 'stopped' && run.stopReason !== null) || (run.state === 'stopped' && run.stopReason === null) || (run.state === 'completed' && run.entries.some(entry => entry.state === 'uncertain'))) throw new Error('The run state does not match its recorded stop condition.');
  for (const entry of run.entries) {
    if (entry.inference && Date.parse(entry.inference.completedAt) < Date.parse(entry.inference.startedAt)) throw new Error('Provider timing is out of order.');
    if (entry.state === 'validated' && (!entry.inference?.validated || !entry.inference.responseId || /^(?:authored|synthetic|fixture)/.test(entry.inference.returnedModel) || !entry.output || entry.output.kind !== providerRole(entry.role) || entry.inference.requestedModel !== run.policy.model || entry.inference.promptVersion !== run.promptVersion || entry.knownUsd !== entry.inference.usd || entry.uncertainUsd !== 0 || entry.failure !== null)) throw new Error('A validated entry lacks matching provider provenance.');
    if (entry.state !== 'validated' && entry.output !== null) throw new Error('Only validated entries can carry a candidate output.');
    if (entry.state === 'reserved' && (entry.knownUsd !== 0 || entry.uncertainUsd !== entry.reservedUsd || entry.inference !== null)) throw new Error('An outstanding reservation has inconsistent accounting.');
    if (entry.state === 'uncertain' && entry.uncertainUsd !== entry.reservedUsd) throw new Error('An uncertain call must retain its complete reservation.');
    if (entry.knownUsd > entry.reservedUsd + 0.000001 && (run.stopReason !== 'cost-bound-exceeded' || entry.failure !== 'cost-bound-exceeded')) throw new Error('A cost-bound violation must stop the run.');
  }
  return run;
}

export function roleReviewTemplate(value: unknown) {
  const run = checkedRun(value);
  return { version: 1, runId: run.runId, benchmarkVersion: run.benchmarkVersion, benchmarkDigest: run.benchmarkDigest, provenance: 'human-review-required', cases: run.entries.filter(entry => entry.state === 'validated').map(entry => ({ caseId: entry.caseId, role: entry.role, candidateDigest: digest(entry), reviews: [], adjudication: null })) };
}

/** Comparison reports recorded coverage/cost/latency only; expert quality is pending. */
export function compareRoleRuns(values: unknown[]) {
  if (!values.length) throw new Error('Supply at least one recorded model run.');
  const runs = values.map(checkedRun);
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('A model run cannot be counted twice.');
  if (runs.some(run => run.benchmarkDigest !== runs[0].benchmarkDigest || run.benchmarkVersion !== runs[0].benchmarkVersion || run.promptVersion !== runs[0].promptVersion)) throw new Error('Compare the same benchmark contexts and prompt version.');
  return { benchmarkVersion: runs[0].benchmarkVersion, benchmarkDigest: runs[0].benchmarkDigest, corpus: 'development-regression', quality: 'pending-independent-human-review', rows: runs.flatMap(run => EVALUATION_ROLES.filter(role => run.planned.some(row => row.role === role)).map(role => {
    const entries = run.entries.filter(row => row.role === role), durations = entries.flatMap(row => row.inference ? [Date.parse(row.inference.completedAt) - Date.parse(row.inference.startedAt)] : []).sort((a, b) => a - b);
    return { runId: run.runId, requestedModel: run.policy.model, role, runState: run.state, planned: run.planned.filter(row => row.role === role).length, attempted: entries.length, validated: entries.filter(row => row.state === 'validated').length, knownUsd: entries.reduce((total, row) => total + row.knownUsd, 0), uncertainUsd: entries.reduce((total, row) => total + row.uncertainUsd, 0), latencySamples: durations.length, providerCompletionP95Ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null };
  })) };
}
