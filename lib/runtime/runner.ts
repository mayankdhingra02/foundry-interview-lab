import 'server-only';

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { validateFiles } from '../interview-practice/domain';
import type { RunExecution, Scenario, ScenarioTest, TestObservation } from '../interview-practice/types';
import { configuredRuntimeBinding, parseRuntimeBinding, runtimeBindingConfigured, type RuntimeBinding } from './binding';

export type ExecuteOptions = { signal?: AbortSignal; includeProtected?: boolean; runtimeBinding?: RuntimeBinding };
type CommandResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean; outputLimited: boolean; error?: string };
type CommandOptions = { signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number; input?: string };
type CheckResult = { id: string; status: TestObservation['status']; testsRun: number; detail: string };

const OUTPUT_LIMIT = 64_000;
const DETAIL_LIMIT = 4_000;
const MANAGEMENT_TIMEOUT = 5_000;
const MAX_SUITES = 8;
let admissionBlock: string | null = null;

function bounded(value: string, bytes = OUTPUT_LIMIT) { return Buffer.from(value).subarray(0, bytes).toString('utf8'); }
function cancelled(signal?: AbortSignal) { return signal?.aborted === true; }

/** Configuration is not a Docker health check. The daemon/image is qualified on each run. */
export function configuredRunner(): boolean {
  return (process.env.RUNNER_MODE || 'docker') === 'docker' && runtimeBindingConfigured();
}

/** This worker's admission latch is not a shared multi-worker circuit breaker. */
export function runnerHealth(): { configured: boolean; admitting: boolean; blockedReason: string | null } {
  const configured = configuredRunner();
  return { configured, admitting: configured && admissionBlock === null, blockedReason: admissionBlock };
}

/** Operator-only: call after reconciling abandoned execution containers. */
export function resetRunnerAdmission(): void { admissionBlock = null; }

/** No bind mount, published port, host network, host PID namespace, or product secret. */
export function buildDockerArguments(name: string, image: string, memoryMb: number): string[] {
  if (!/^foundry-run-[a-f0-9-]+$/.test(name)) throw new Error('Invalid execution container name.');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Execute an inspected immutable image ID.');
  const memory = Math.max(64, Math.min(256, Math.floor(memoryMb)));
  return ['create', '--pull=never', '-i', '--name', name,
    '--label=foundry.interview-execution=true', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
    `--memory=${memory}m`, `--memory-swap=${memory}m`, '--cpus=1', '--user=65534:65534',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777', '--shm-size=8m',
    '--ulimit=nofile=128:128', '--ulimit=fsize=16777216:16777216',
    '--log-driver=none', '--no-healthcheck', '--init', '--entrypoint=python',
    image, '-I', '-B', '-u', '-'];
}

/** The only learner-code transfer is a JSON/base64 data payload over container stdin. */
export function buildPythonBundle(files: Record<string, string>, test: ScenarioTest, nonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid result nonce.');
  const payload = Buffer.from(JSON.stringify({ files, source: test.source, id: test.id, nonce }), 'utf8').toString('base64');
  return `import base64, importlib.util, json, os, sys, tempfile, unittest
payload = json.loads(base64.b64decode('${payload}'))
class BoundedResult(unittest.TestResult):
    def describe(self, test, err):
        return (str(test.id())[:200] + ': ' + type(err[1]).__name__ + ': ' + str(err[1])[:1200])[:1600]
    def addFailure(self, test, err):
        self.failures.append((test, self.describe(test, err)))
    def addError(self, test, err):
        self.errors.append((test, self.describe(test, err)))
    def addSubTest(self, test, subtest, err):
        if err is not None:
            target = self.failures if issubclass(err[0], test.failureException) else self.errors
            target.append((subtest, self.describe(subtest, err)))
with tempfile.TemporaryDirectory(dir='/tmp') as work:
    os.chdir(work)
    sys.path.insert(0, work)
    for name, content in payload['files'].items():
        path = os.path.join(work, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(content)
        os.chmod(path, 0o444)
    contract = os.path.join(work, '_foundry_contract.py')
    with open(contract, 'w', encoding='utf-8') as handle:
        handle.write(payload['source'])
    os.chmod(contract, 0o444)
    try:
        spec = importlib.util.spec_from_file_location('_foundry_contract', contract)
        module = importlib.util.module_from_spec(spec)
        sys.modules['_foundry_contract'] = module
        spec.loader.exec_module(module)
        suite = unittest.defaultTestLoader.loadTestsFromModule(module)
        result = suite.run(BoundedResult())
        if result.testsRun < 1:
            row = {'status':'error','testsRun':0,'detail':'No unittest checks were discovered.'}
        else:
            status = 'error' if result.errors else 'failed' if result.failures or result.unexpectedSuccesses else 'skipped' if len(result.skipped) == result.testsRun else 'passed'
            diagnostics = [detail for _, detail in (result.failures + result.errors)[:12]]
            if result.unexpectedSuccesses:
                diagnostics.append('Unexpected success in an expected-failure check.')
            row = {'status':status,'testsRun':result.testsRun,'detail':'\\n'.join(diagnostics)[:4000]}
    except BaseException as error:
        row = {'status':'error','testsRun':0,'detail':(type(error).__name__ + ': ' + str(error))[:4000]}
    row['id'] = payload['id']
    row['nonce'] = payload['nonce']
    print('FOUNDRY_CHECK_' + payload['nonce'] + ':' + json.dumps(row), flush=True)
    sys.exit(0 if row['status'] in ('passed','skipped') else 1)
`;
}

/** A nonce prevents incidental output collisions; it is not tamper-resistant grading. */
export function parseTestResult(stdout: string, test: ScenarioTest, nonce: string, exitCode: number | null): TestObservation {
  const marker = `FOUNDRY_CHECK_${nonce}:`;
  const matches = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  const invalid = (detail: string): TestObservation => ({ id: test.id, title: test.title, status: 'error', detail });
  if (matches.length !== 1) return invalid('The process did not return one validated check result. No success is inferred from its exit code or printed output.');
  let row: CheckResult & { nonce: string };
  try { row = JSON.parse(matches[0].slice(marker.length)); } catch { return invalid('The process returned malformed check evidence.'); }
  if (!row || row.id !== test.id || row.nonce !== nonce || !['passed', 'failed', 'error', 'skipped'].includes(row.status) ||
    !Number.isSafeInteger(row.testsRun) || row.testsRun < 0 || row.testsRun > 1_000 || typeof row.detail !== 'string' || row.detail.length > DETAIL_LIMIT ||
    (row.status !== 'error' && row.testsRun === 0) || ((row.status === 'passed' || row.status === 'skipped') && exitCode !== 0)) {
    return invalid('The process returned invalid or contradictory check evidence.');
  }
  return { id: test.id, title: test.title, status: row.status, ...(row.detail ? { detail: row.detail } : {}) };
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function command(args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise(resolve => {
    if (cancelled(options.signal)) return resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, outputLimited: false });
    let child: ReturnType<typeof spawn>;
    try { child = spawn('docker', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: dockerEnvironment() }); }
    catch { return resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: false, outputLimited: false, error: 'Docker could not be started.' }); }
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let seenBytes = 0, timedOut = false, aborted = false, outputLimited = false, settled = false;
    const cap = options.maxOutputBytes ?? OUTPUT_LIMIT;
    const stop = () => { try { child.kill('SIGKILL'); } catch { /* cleanup still runs by name */ } };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.timeoutMs));
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode, timedOut, aborted, outputLimited, ...(error ? { error } : {}) });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]] as const) {
      stream?.on('data', (chunk: Buffer) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const keep = Math.max(0, cap - stdout.length - stderr.length);
        if (keep) {
          if (isError) stderr = Buffer.concat([stderr, data.subarray(0, keep)]);
          else stdout = Buffer.concat([stdout, data.subarray(0, keep)]);
        }
        seenBytes += data.length;
        if (seenBytes > cap) { outputLimited = true; stop(); }
      });
    }
    child.once('error', () => finish(null, 'Docker could not be started.'));
    child.once('close', code => finish(code));
    child.stdin?.on('error', () => { /* an early child exit may close stdin */ });
    child.stdin?.end(options.input || '');
    if (cancelled(options.signal)) onAbort();
  });
}

async function destroyContainer(name: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await command(['rm', '--force', name], { timeoutMs: MANAGEMENT_TIMEOUT, maxOutputBytes: 4_000 });
    if (result.exitCode === 0 || /No such container/i.test(result.stderr)) return true;
  }
  return false;
}

function notRun(tests: ScenarioTest[], detail: string): TestObservation[] {
  return tests.map(test => ({ id: test.id, title: test.title, status: 'skipped', detail }));
}

export async function executeScenario(scenario: Scenario, files: Record<string, string>, options: ExecuteOptions = {}): Promise<RunExecution> {
  const started = Date.now();
  const safeCommand = 'docker isolated Python unittest (immutable snapshot; no host mounts or network)';
  const base = (status: RunExecution['status'], detail: string, tests: TestObservation[] = [], runtimeDigest?: string): RunExecution => ({
    status, command: safeCommand, stdout: '', stderr: bounded(detail), exitCode: null, tests, durationMs: Date.now() - started, ...(runtimeDigest ? { runtimeDigest } : {}),
  });
  if ((process.env.RUNNER_MODE || 'docker') !== 'docker') return base('infrastructure_error', 'A qualified remote execution and cancellation contract is not configured. Select the Docker runner; learner code was not executed.');
  if (admissionBlock) return base('infrastructure_error', admissionBlock);
  if (cancelled(options.signal)) return base('infrastructure_error', 'Execution was cancelled before admission; learner code was not executed.');
  let snapshot: Record<string, string>, packageCopy: Scenario, binding: RuntimeBinding | null;
  try {
    packageCopy = structuredClone(scenario);
    snapshot = validateFiles(files, packageCopy);
    binding = options.runtimeBinding === undefined ? configuredRuntimeBinding(packageCopy) : parseRuntimeBinding(options.runtimeBinding, packageCopy.runtime.image);
    if (!binding) return base('infrastructure_error', 'A reviewed immutable Python runtime binding is required. Learner code was not executed.');
  } catch (error) { return base('infrastructure_error', error instanceof Error ? error.message : 'Execution input was rejected.'); }
  const tests = packageCopy.tests.filter(test => options.includeProtected === true || test.visible);
  if (!tests.length || tests.length > MAX_SUITES) return base('infrastructure_error', 'The admitted scenario must have between one and eight selected check files.');
  const deadline = started + Math.max(1, Math.min(60, packageCopy.runtime.timeoutSeconds)) * 1_000;
  const imageId = binding.imageId;
  const inspection = await command(['image', 'inspect', imageId, '--format', '{{.Id}}'], { signal: options.signal, timeoutMs: Math.min(MANAGEMENT_TIMEOUT, Math.max(1, deadline - Date.now())), maxOutputBytes: 4_000 });
  if (inspection.aborted) return base('infrastructure_error', 'Execution was cancelled before creating a container.');
  if (inspection.timedOut) return base('timeout', 'The execution runtime did not respond within the admitted time budget.');
  if (inspection.exitCode !== 0 || inspection.stdout.trim() !== imageId) return base('infrastructure_error', 'The exact admitted Python image is unavailable or mismatched. No image is pulled or substituted; saved work is unchanged.');
  const observations: TestObservation[] = [];
  let stdout = '', stderr = '', exitCode = 0;
  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    if (cancelled(options.signal)) return { ...base('infrastructure_error', 'Execution was cancelled; completed observations are retained and remaining checks were not run.', [...observations, ...notRun(tests.slice(index), 'Not run because execution was cancelled.')], imageId), stdout };
    if (Date.now() >= deadline) return { ...base('timeout', 'The snapshot exceeded its total execution time budget.', [...observations, ...notRun(tests.slice(index), 'Not run because the execution deadline expired.')], imageId), stdout };
    const name = `foundry-run-${randomUUID()}`;
    const nonce = randomBytes(16).toString('hex');
    let result: CommandResult | undefined;
    let managementFailure = false, cleanupConfirmed = false;
    try {
      const created = await command(buildDockerArguments(name, imageId, packageCopy.runtime.memoryMb), {
        signal: options.signal, timeoutMs: Math.min(MANAGEMENT_TIMEOUT, Math.max(1, deadline - Date.now())), maxOutputBytes: 4_000,
      });
      if (created.exitCode !== 0 || created.error || created.timedOut || created.aborted) { result = created; managementFailure = true; }
      else {
        result = await command(['start', '--attach', '--interactive', name], {
          signal: options.signal,
          timeoutMs: Math.min(Math.max(1, Math.min(60, test.timeoutSeconds)) * 1_000, Math.max(1, deadline - Date.now())),
          input: buildPythonBundle(snapshot, test, nonce),
        });
      }
    } finally {
      // No caller signal is forwarded: cancellation must not cancel cleanup itself.
      cleanupConfirmed = await destroyContainer(name);
    }
    if (!cleanupConfirmed) {
      admissionBlock = 'Container cleanup could not be confirmed. This worker blocks new execution until an operator reconciles containers labeled foundry.interview-execution=true and resets admission.';
      return { ...base('infrastructure_error', admissionBlock, [...observations, ...notRun(tests.slice(index), 'No validated result: container cleanup was not confirmed.')], imageId), stdout };
    }
    if (!result) return base('infrastructure_error', 'Execution did not return a process result.', observations, imageId);
    const cleanedOutput = result.stdout.split(/\r?\n/).filter(line => !line.startsWith(`FOUNDRY_CHECK_${nonce}:`)).join('\n');
    stdout = bounded(stdout + (cleanedOutput ? `[${test.id}]\n${cleanedOutput}\n` : ''));
    stderr = bounded(stderr + (result.stderr ? `[${test.id}]\n${result.stderr}\n` : ''));
    if (result.aborted) return { ...base('infrastructure_error', 'Execution was cancelled and its container was destroyed.', [...observations, ...notRun(tests.slice(index), 'Not run to completion because execution was cancelled.')], imageId), stdout };
    if (result.timedOut) return { ...base('timeout', 'The execution time limit was exceeded and its container was destroyed. This is a resource observation, not a skill rating.', [...observations, ...notRun(tests.slice(index), 'No completed observation: execution time limit exceeded.')], imageId), stdout };
    if (result.outputLimited) return { ...base('infrastructure_error', 'Execution output exceeded 64 KB and its container was destroyed. No success is inferred from truncated output.', [...observations, ...notRun(tests.slice(index), 'No validated result: output limit exceeded.')], imageId), stdout };
    if (managementFailure || result.error) return { ...base('infrastructure_error', 'The approved sandbox could not be created or started. Learner work is saved.', [...observations, ...notRun(tests.slice(index), 'Not run: execution infrastructure unavailable.')], imageId), stdout };
    const observation = parseTestResult(result.stdout, test, nonce, result.exitCode);
    observations.push(observation);
    if (observation.status === 'failed' || observation.status === 'error') exitCode = 1;
  }
  return { status: 'completed', command: safeCommand, stdout, stderr, exitCode, tests: observations, durationMs: Date.now() - started, runtimeDigest: imageId };
}
