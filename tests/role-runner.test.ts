import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadRecipes, loadRuntimeCapture, materializeAttempt, conservativeReport, type BenchmarkAttempt } from '../evals/benchmark';
import { compareRoleRuns, createRolePlan, recordRoleRun, roleReviewTemplate, roleRunSchema, validateRoleRun, type RoleExecutor, type RoleRun } from '../evals/role-runner';
import { authoredQuestion, PROMPT_VERSION, ProviderFailure } from '../lib/ai/provider';
import { inferenceBindingDigest, type InferenceBinding } from '../lib/ai/binding';

let version: string, attempt: BenchmarkAttempt;
const temporary: string[] = [];
beforeEach(async () => {
  vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('An unmocked external call is forbidden in this test.'); }));
  const recipes = await loadRecipes(); version = recipes.version;
  attempt = materializeAttempt(recipes.cases.find(row => row.id === 'money-starter')!, await loadRuntimeCapture());
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const inference = (binding?: InferenceBinding) => ({ requestedModel: 'gpt-5.4-mini', returnedModel: 'unit-mocked-model', promptVersion: PROMPT_VERSION, inputTokens: 1000, outputTokens: 200, responseId: 'unit-test-not-an-actual-provider-response', startedAt: '2026-10-09T13:00:00.000Z', completedAt: '2026-10-09T13:00:01.000Z', usd: 0.00165, validated: true, ...(binding ? { provider: binding.provider, role: binding.role, schemaVersion: binding.schemaVersion, contextVersion: binding.contextVersion, bindingDigest: inferenceBindingDigest(binding) } : {}) });
const executor: RoleExecutor = async task => {
  const common = { model: 'unit-mocked-model', inference: inference(task.inferenceBinding), actualUsd: 0.00165 };
  if (task.role === 'interviewer') return { kind: 'interviewer', proposal: authoredQuestion(task.attempt.scenario, task.session), ...common };
  if (task.role === 'coach') return { kind: 'coach', report: conservativeReport(task.attempt), promptVersion: PROMPT_VERSION, ...common };
  return { kind: 'assistant', message: 'Unit-only response; no provider was contacted.', files: {}, ...common };
};
const options = () => ({ acknowledgePaidApi: true, maxUsd: 1, executor, persist: vi.fn(async (_run: RoleRun) => { void _run; }) });

describe('explicit role benchmark recording', () => {
  it('creates a zero-call plan covering three independent roles and all assistant modes', () => {
    const plan = createRolePlan(version, [attempt]);
    expect(plan.planned.map(row => row.role)).toEqual(['interviewer', 'coach', 'assistant-ask', 'assistant-plan', 'assistant-edit']);
    expect(plan.estimatedUpperUsd).toBeGreaterThan(0);
    expect(new Set(plan.planned.map(row => row.contextDigest)).size).toBe(5);
    expect(plan.planned[0]).toMatchObject({ scenarioId: attempt.scenario.id, scenarioVersion: attempt.scenario.version, rubricVersion: attempt.scenario.version, evidenceDigest: attempt.session.frozenEvidence!.digest, runtimeDigests: [attempt.session.runs[0].runtimeDigest] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing acknowledgement and insufficient or malformed budgets before persistence or execution', async () => {
    const opts = options(), execute = vi.fn(executor); opts.executor = execute;
    await expect(recordRoleRun(version, [attempt], { ...opts, acknowledgePaidApi: false })).rejects.toThrow('acknowledgement');
    for (const maxUsd of [0, NaN, Infinity, -1, 1001, 0.000001]) await expect(recordRoleRun(version, [attempt], { ...opts, maxUsd })).rejects.toThrow();
    expect(opts.persist).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('refuses duplicate/unknown roles and duplicate/empty cases', () => {
    expect(() => createRolePlan(version, [attempt, attempt])).toThrow('distinct');
    expect(() => createRolePlan(version, [])).toThrow();
    expect(() => createRolePlan(version, [attempt], ['coach', 'coach'])).toThrow();
    expect(() => createRolePlan(version, [attempt], ['invalid' as 'coach'])).toThrow();
  });
  it('requires configured production roles and performs zero calls if credentials are absent', async () => {
    await expect(recordRoleRun(version, [attempt], { ...options(), executor: undefined })).rejects.toThrow('configured');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists each reservation before execution, preserves separate response identities and never mutates the attempt', async () => {
    const original = structuredClone(attempt), journals: RoleRun[] = [];
    const result = await recordRoleRun(version, [attempt], { ...options(), persist: async run => { journals.push(run); }, executor: async task => {
      const entry = journals.at(-1)!.entries.at(-1)!;
      expect(entry).toMatchObject({ role: task.role, state: 'reserved', uncertainUsd: task.reservedUsd });
      return executor(task);
    } });
    expect(result.state).toBe('completed'); expect(result.entries.every(row => row.state === 'validated')).toBe(true);
    expect(result.entries).toHaveLength(5); expect(roleRunSchema.parse(result)).toEqual(result);
    expect(journals[1].entries[0].state).toBe('reserved');
    expect(journals[1].entries[0].output).toBeNull(); expect(attempt).toEqual(original);
  });
  it('does not call a provider when the pre-call journal cannot be saved', async () => {
    const execute = vi.fn(executor);
    let writes = 0;
    await expect(recordRoleRun(version, [attempt], { ...options(), executor: execute, persist: async () => { if (++writes === 2) throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps the outstanding journal when recording the result fails and makes no next call', async () => {
    const execute = vi.fn(executor), journals: RoleRun[] = []; let writes = 0;
    await expect(recordRoleRun(version, [attempt], { ...options(), executor: execute, persist: async run => { if (++writes === 3) throw new Error('disk unavailable'); journals.push(run); } })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1); expect(journals.at(-1)!.entries[0].state).toBe('reserved');
  });
  it('stops without retrying after uncertain billing and retains the full reservation', async () => {
    const execute = vi.fn(async () => { throw new ProviderFailure(true); });
    const result = await recordRoleRun(version, [attempt], { ...options(), executor: execute });
    expect(result).toMatchObject({ state: 'stopped', stopReason: 'uncertain-charge' });
    expect(result.entries).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1);
    expect(result.entries[0].uncertainUsd).toBe(result.planned[0].reservedUsd);
  });
  it('records definite no-charge rejections without attributing authored fallback to a model', async () => {
    const result = await recordRoleRun(version, [attempt], { ...options(), roles: ['interviewer'], executor: async task => ({ kind: 'interviewer', proposal: authoredQuestion(task.attempt.scenario, task.session), model: 'authored', actualUsd: 0 }) });
    expect(result.entries[0]).toMatchObject({ state: 'rejected', knownUsd: 0, uncertainUsd: 0, output: null });
    expect(compareRoleRuns([result]).rows[0].validated).toBe(0);
  });
  it('retains known charged usage for invalid or fallback output', async () => {
    const result = await recordRoleRun(version, [attempt], { ...options(), roles: ['interviewer'], executor: async task => ({ ...await executor(task), inference: { ...inference(), validated: false } }) });
    expect(result.entries[0]).toMatchObject({ state: 'rejected', knownUsd: 0.00165, uncertainUsd: 0, output: null });
  });
  it('does not let an executor replace the separately journaled policy', async () => {
    const run = await recordRoleRun(version, [attempt], { ...options(), roles: ['assistant-ask'], executor: async task => {
      task.inferenceBinding = { ...task.inferenceBinding, inputRate: 0.5 };
      return executor(task);
    } });
    expect(run.entries[0]).toMatchObject({ state: 'rejected', output: null, knownUsd: 0.00165 });
    expect(run.inferenceBindings![0].inputRate).toBe(0.75);
  });
  it('stops at an unexpected provider cost above the admitted bound', async () => {
    const execute = vi.fn(async task => ({ ...await executor(task), inference: { ...inference(), usd: 1 }, actualUsd: 1 }));
    const result = await recordRoleRun(version, [attempt], { ...options(), executor: execute });
    expect(result.stopReason).toBe('cost-bound-exceeded'); expect(execute).toHaveBeenCalledTimes(1);
    expect(result.entries[0].knownUsd).toBe(1); expect(result.entries[0].output).toBeNull();
  });
  it('rejects assistant silent edits and paths outside the admitted workspace', async () => {
    for (const role of ['assistant-ask', 'assistant-plan', 'assistant-edit'] as const) {
      const result = await recordRoleRun(version, [attempt], { ...options(), roles: [role], executor: async () => ({ kind: 'assistant', message: 'Invalid unit patch', files: { '../secret.py': 'x' }, model: 'unit-mocked-model', inference: inference(), actualUsd: 0.00165 }) });
      expect(result.entries[0].state).toBe('rejected'); expect(result.entries[0].output).toBeNull();
    }
    for (const role of ['assistant-ask', 'assistant-plan'] as const) {
      const result = await recordRoleRun(version, [attempt], { ...options(), roles: [role], executor: async () => ({ kind: 'assistant', message: 'Forbidden ask/plan mutation', files: attempt.session.files, model: 'unit-mocked-model', inference: inference(), actualUsd: 0.00165 }) });
      expect(result.entries[0].state).toBe('rejected');
    }
  });
  it('exercises the actual production adapter for all five tasks with mocked HTTP and no paid calls', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-key-never-sent'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
    const calls: Array<{ instructions: string; input: Array<{ content: string }>; text: { format: { name: string } } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push(body);
      const value = body.text.format.name === 'foundry_coach' ? conservativeReport(attempt) : body.text.format.name === 'foundry_interviewer' ? authoredQuestion(attempt.scenario, attempt.session) : { message: 'Mocked response only.', files: [] };
      return new Response(JSON.stringify({ id: `unit-only-response-${calls.length}`, status: 'completed', model: 'unit-mocked-model', usage: { input_tokens: 1000, output_tokens: 200 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
    }));
    const result = await recordRoleRun(version, [attempt], { ...options(), executor: undefined });
    expect(result.entries.every(row => row.state === 'validated')).toBe(true); expect(calls).toHaveLength(5);
    expect(calls.slice(2).map(row => JSON.parse(row.input[0].content).mode)).toEqual(['ask', 'plan', 'edit']);
    for (const body of calls.slice(2)) expect(body.input[0].content).not.toContain(attempt.scenario.tests.find(test => !test.visible)!.source);
  });
  it('executes the journaled policy after model, pricing and output settings drift', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-test-key-never-sent'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
    const bodies: Array<{ model: string; max_output_tokens: number; text: { format: { name: string } } }> = [], journals: RoleRun[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      const value = body.text.format.name === 'foundry_coach' ? conservativeReport(attempt) : body.text.format.name === 'foundry_interviewer' ? authoredQuestion(attempt.scenario, attempt.session) : { message: 'Hypothetical captured-policy response.', files: [] };
      return new Response(JSON.stringify({ id: `unit-policy-response-${bodies.length}`, status: 'completed', model: 'unit-resolved-snapshot', usage: { input_tokens: 1000, output_tokens: 200 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
    }));
    const run = await recordRoleRun(version, [attempt], { ...options(), executor: undefined, persist: async row => {
      journals.push(row);
      vi.stubEnv('OPENAI_MODEL', 'different-current-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '900'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '600');
    } });
    expect(bodies).toHaveLength(5); expect(bodies.every(body => body.model === 'gpt-5.4-mini' && body.max_output_tokens === 2400)).toBe(true);
    expect(run.entries.every(entry => entry.state === 'validated' && entry.knownUsd === 0.00165)).toBe(true);
    expect(journals[0].inferenceBindings).toHaveLength(3);
    expect(run.planned.map(row => row.reservedUsd)).toEqual(journals[0].planned.map(row => row.reservedUsd));
    expect(validateRoleRun(run)).toEqual(run);
  });
});

describe('offline model comparison and independent review handoff', () => {
  it('reads historical recordings without binding fields and rejects partial provenance downgrades', async () => {
    const run = await recordRoleRun(version, [attempt], options()), legacy = structuredClone(run);
    delete legacy.inferenceBindings;
    expect(() => validateRoleRun(legacy)).toThrow('missing its recorded policy');
    for (const entry of legacy.entries) for (const field of ['provider', 'role', 'schemaVersion', 'contextVersion', 'bindingDigest'] as const) delete entry.inference?.[field];
    vi.stubEnv('OPENAI_MODEL', 'invalid-current-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid');
    expect(validateRoleRun(legacy)).toEqual(legacy); expect(compareRoleRuns([legacy]).quality).toBe('pending-independent-human-review');
    expect(roleReviewTemplate(legacy).cases).toHaveLength(5);
  });
  it('rejects altered recorded policy, reserve, role coverage and bound candidate identity offline', async () => {
    const run = await recordRoleRun(version, [attempt], options());
    const changes: Array<(copy: RoleRun) => void> = [
      copy => { copy.policy.inputRate += 1; },
      copy => { copy.inferenceBindings![0].reserveUsd += 0.01; },
      copy => { copy.inferenceBindings!.pop(); },
      copy => { copy.inferenceBindings!.push(copy.inferenceBindings![0]); },
      copy => { copy.entries[0].inference!.bindingDigest = 'f'.repeat(64); },
      copy => { delete copy.entries[0].inference!.schemaVersion; },
    ];
    for (const change of changes) { const copy = structuredClone(run); change(copy); expect(() => validateRoleRun(copy)).toThrow(); }
  });
  it('reports coverage, complete-response latency and cost while keeping quality pending', async () => {
    const run = await recordRoleRun(version, [attempt], options()), comparison = compareRoleRuns([run]);
    expect(comparison.quality).toBe('pending-independent-human-review'); expect(comparison.rows).toHaveLength(5);
    expect(comparison.rows.every(row => row.validated === 1 && row.providerCompletionP95Ms === 1000)).toBe(true);
    const template = roleReviewTemplate(run);
    expect(template.cases).toHaveLength(5);
    expect(template.cases.every(row => !row.reviews.length && row.adjudication === null)).toBe(true);
  });
  it('refuses mismatched contexts, duplicate runs and forged entry accounting', async () => {
    const run = await recordRoleRun(version, [attempt], options());
    expect(() => compareRoleRuns([run, run])).toThrow('twice');
    const changed = structuredClone(run); changed.planned[0].contextDigest = 'a'.repeat(64);
    expect(() => compareRoleRuns([changed])).toThrow('contexts');
    const invalid = structuredClone(run); invalid.entries[0].knownUsd = 0;
    expect(() => compareRoleRuns([invalid])).toThrow('provenance');
    const another = await recordRoleRun(version, [attempt], { ...options(), roles: ['coach'] });
    expect(() => compareRoleRuns([run, another])).toThrow('same benchmark');
  });
  it('prints only a plan by default and writes private artifacts exclusively through the CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-role-cli-')); temporary.push(directory);
    const output = join(directory, 'plan.json'), exec = promisify(execFile);
    const args = ['--conditions=react-server', '--import=tsx', 'scripts/benchmark-models.ts', '--cases', 'money-starter', '--roles', 'coach', '--output', output];
    await exec(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: '' } });
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ mode: 'plan-only', providerCalls: 0, plannedCalls: 1 });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(exec(process.execPath, args, { cwd: process.cwd() })).rejects.toThrow();
    await writeFile(output, 'sentinel');
    await expect(exec(process.execPath, [...args, '--record'], { cwd: process.cwd() })).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('sentinel');
  });
});
