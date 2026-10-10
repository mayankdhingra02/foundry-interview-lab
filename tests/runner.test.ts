import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario, listScenarios } from '../lib/content/scenarios';
import { buildDockerArguments, buildPythonBundle, configuredRunner, executeScenario, parseTestResult, resetRunnerAdmission, runnerHealth } from '../lib/runtime/runner';
import type { Scenario, ScenarioTest } from '../lib/interview-practice/types';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn() };
});

const imageId = `sha256:${'a'.repeat(64)}`;
const nonce = 'b'.repeat(32);
const spawnMock = vi.mocked(spawn);
const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const qualifiedImageId = process.env.PYTHON_IMAGE_ID;
const example = () => getScenario('monetary-validation')!;
const publicTest = () => example().tests.find(test => test.visible)!;

function row(test: ScenarioTest, resultNonce = nonce, status = 'passed', testsRun = 4) {
  return `FOUNDRY_CHECK_${resultNonce}:${JSON.stringify({ id: test.id, nonce: resultNonce, status, testsRun, detail: '' })}\n`;
}

type FakeOptions = { hangStart?: boolean; cleanupFails?: boolean; outputFlood?: boolean; onStart?: () => void; inspectId?: string; imageMissing?: boolean };
function installFakeDocker(options: FakeOptions = {}) {
  const calls: string[][] = [];
  spawnMock.mockImplementation((_program, argumentList) => {
    const args = argumentList as string[];
    calls.push(args);
    const emitter = new EventEmitter();
    const stdout = new PassThrough(), stderr = new PassThrough();
    let input = '', closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true; stdout.end(); stderr.end(); emitter.emit('close', code);
    };
    const stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk.toString(); callback(); } });
    const child = Object.assign(emitter, { stdout, stderr, stdin, kill: vi.fn(() => { queueMicrotask(() => close(null)); return true; }) });
    if (args[0] === 'start') {
      stdin.once('finish', () => {
        options.onStart?.();
        if (options.hangStart) return;
        queueMicrotask(() => {
          if (options.outputFlood) { stdout.write('x'.repeat(70_000)); return; }
          const payloadMatch = input.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)!;
          const payload = JSON.parse(Buffer.from(payloadMatch[1], 'base64').toString('utf8'));
          stdout.write(`FOUNDRY_CHECK_${payload.nonce}:${JSON.stringify({ id: payload.id, nonce: payload.nonce, status: 'passed', testsRun: 4, detail: '' })}\n`);
          close(0);
        });
      });
    } else {
      queueMicrotask(() => {
        if (args[0] === 'image') {
          if (options.imageMissing) { stderr.write('No such image'); close(1); return; }
          stdout.write((options.inspectId ?? imageId) + '\n');
        }
        if (args[0] === 'create') stdout.write('container-id\n');
        if (args[0] === 'rm' && options.cleanupFails) { stderr.write('Docker daemon unavailable'); close(1); }
        else close(0);
      });
    }
    return child as unknown as ChildProcess;
  });
  return calls;
}

beforeEach(() => {
  resetRunnerAdmission();
  spawnMock.mockReset();
  vi.stubEnv('RUNNER_MODE', 'docker');
  vi.stubEnv('PYTHON_IMAGE', 'python:3.11-slim');
  vi.stubEnv('PYTHON_IMAGE_ID', imageId);
  vi.stubEnv('RUNNER_ALLOWED_IMAGES', 'python:3.11-slim');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('snapshot runner contracts', () => {
  it('selects only the configured Docker adapter', async () => {
    vi.stubEnv('RUNNER_MODE', 'remote');
    expect(configuredRunner()).toBe(false);
    const result = await executeScenario(example(), example().files);
    expect(result.status).toBe('infrastructure_error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('creates an isolated, bounded unprivileged container without host mounts or egress', () => {
    const args = buildDockerArguments('foundry-run-01234567-89ab', imageId, 999);
    for (const argument of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--user=65534:65534', '--log-driver=none']) {
      expect(args).toContain(argument);
    }
    expect(args.some(value => value.startsWith('--tmpfs=/tmp:rw,noexec,nosuid,nodev,'))).toBe(true);
    expect(args).not.toContain('--privileged');
    expect(args.some(value => /^(--mount|--volume|-v|--env-file|--publish|-p)$/.test(value))).toBe(false);
    expect(() => buildDockerArguments('unsafe-name', imageId, 256)).toThrow();
    expect(() => buildDockerArguments('foundry-run-01234567', 'uninspected:latest', 256)).toThrow();
  });

  it('serializes code only as data and includes only the selected server test source', () => {
    const files = { 'service.py': "print('$(touch /host-sentinel)')\n" };
    const bundle = buildPythonBundle(files, publicTest(), nonce);
    expect(bundle).not.toContain('touch /host-sentinel');
    const encoded = bundle.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)![1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(payload.files).toEqual(files);
    expect(payload.source).toBe(publicTest().source);
    expect(payload).not.toHaveProperty('referenceFiles');
  });

  it('rejects fabricated, mismatched, duplicate, empty, or contradictory result evidence', () => {
    const test = publicTest();
    expect(parseTestResult(row(test), test, nonce, 0).status).toBe('passed');
    expect(parseTestResult('all checks passed', test, nonce, 0).status).toBe('error');
    expect(parseTestResult(row(test, 'c'.repeat(32)), test, nonce, 0).status).toBe('error');
    expect(parseTestResult(row(test) + row(test), test, nonce, 0).status).toBe('error');
    expect(parseTestResult(row(test, nonce, 'passed', 0), test, nonce, 0).status).toBe('error');
    expect(parseTestResult(row(test), test, nonce, 1).status).toBe('error');
    expect(parseTestResult(row({ ...test, id: 'another-id' }), test, nonce, 0).status).toBe('error');
  });

  it('runs public checks by default and destroys the container after success', async () => {
    const calls = installFakeDocker();
    const scenario = example();
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status).toBe('completed');
    expect(result.tests.map(test => test.id)).toEqual(scenario.tests.filter(test => test.visible).map(test => test.id));
    expect(result.runtimeDigest).toBe(imageId);
    expect(result.stdout).not.toContain('FOUNDRY_CHECK_');
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(1);
    expect(calls.find(args => args[0] === 'create')).toContain(imageId);
    const spawnOptions = spawnMock.mock.calls[0][2] as { shell: boolean; env: NodeJS.ProcessEnv };
    expect(spawnOptions.shell).toBe(false);
    expect(spawnOptions.env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('runs every selected test file in its own container', async () => {
    const calls = installFakeDocker();
    const scenario = example();
    const result = await executeScenario(scenario, scenario.files, { includeProtected: true });
    expect(result.tests.map(test => test.id)).toEqual(scenario.tests.map(test => test.id));
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(2);
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(2);
  });

  it('rejects unsafe workspace files and unapproved images before execution', async () => {
    const scenario = example();
    expect((await executeScenario(scenario, { ...scenario.files, '../escape.py': 'pass' })).status).toBe('infrastructure_error');
    vi.stubEnv('PYTHON_IMAGE', 'unapproved:latest');
    expect((await executeScenario(scenario, scenario.files)).status).toBe('infrastructure_error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('executes the admitted image ID even after the configured alias and pin change', async () => {
    const calls = installFakeDocker(), scenario = example();
    vi.stubEnv('PYTHON_IMAGE', 'different:latest');
    vi.stubEnv('PYTHON_IMAGE_ID', `sha256:${'c'.repeat(64)}`);
    const result = await executeScenario(scenario, scenario.files, { runtimeBinding: { version: 1, scenarioImage: scenario.runtime.image, imageAlias: 'python:3.11-slim', imageId } });
    expect(result.status).toBe('completed');
    expect(result.runtimeDigest).toBe(imageId);
    expect(calls[0]).toEqual(['image','inspect',imageId,'--format','{{.Id}}']);
    expect(calls.find(args => args[0] === 'create')).toContain(imageId);
    expect(calls.flat()).not.toContain('different:latest');
  });

  it.each([{ imageMissing: true }, { inspectId: `sha256:${'c'.repeat(64)}` }])('does not create or pull a container when the admitted cached image is absent or mismatched: %j', async options => {
    const calls = installFakeDocker(options), scenario = example();
    const result = await executeScenario(scenario,scenario.files);
    expect(result.status).toBe('infrastructure_error');
    expect(result.tests).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0,3)).toEqual(['image','inspect',imageId]);
  });

  it('fails closed on an absent pin and an invalid explicit binding before Docker I/O', async () => {
    const scenario = example();
    vi.stubEnv('PYTHON_IMAGE_ID','');
    expect(configuredRunner()).toBe(false);
    expect((await executeScenario(scenario,scenario.files)).status).toBe('infrastructure_error');
    expect((await executeScenario(scenario,scenario.files,{ runtimeBinding: { version: 1, scenarioImage: 'foreign:latest',imageAlias: scenario.runtime.image,imageId } })).status).toBe('infrastructure_error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not admit an already cancelled run', async () => {
    const controller = new AbortController(); controller.abort();
    const scenario = example();
    expect((await executeScenario(scenario, scenario.files, { signal: controller.signal })).status).toBe('infrastructure_error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('lease-loss cancellation destroys the active sandbox before returning', async () => {
    let onStarted!: () => void;
    const started = new Promise<void>(resolve => { onStarted = resolve; });
    const calls = installFakeDocker({ hangStart: true, onStart: onStarted });
    const controller = new AbortController(), scenario = example();
    const pending = executeScenario(scenario, scenario.files, { signal: controller.signal, includeProtected: true });
    await started; controller.abort();
    const result = await pending;
    expect(result.status).toBe('infrastructure_error');
    expect(result.stderr).toContain('cancelled');
    expect(calls.some(args => args[0] === 'rm')).toBe(true);
    expect(result.tests.every(test => test.status === 'skipped')).toBe(true);
  });

  it('time limits kill and clean the sandbox without reporting test failures', async () => {
    const calls = installFakeDocker({ hangStart: true });
    const scenario = example(); scenario.runtime.timeoutSeconds = 1;
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status).toBe('timeout');
    expect(result.tests.every(test => test.status === 'skipped')).toBe(true);
    expect(calls.some(args => args[0] === 'rm')).toBe(true);
  });

  it('bounds runaway output and cleans up before returning', async () => {
    const calls = installFakeDocker({ outputFlood: true });
    const scenario = example();
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status).toBe('infrastructure_error');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64_000);
    expect(result.stderr).toContain('output exceeded');
    expect(calls.some(args => args[0] === 'rm')).toBe(true);
  });

  it('refuses to publish a successful run if cleanup cannot be confirmed', async () => {
    const calls = installFakeDocker({ cleanupFails: true });
    const scenario = example();
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status).toBe('infrastructure_error');
    expect(result.stderr).toContain('cleanup could not be confirmed');
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(3);
    expect(runnerHealth().admitting).toBe(false);
    const callCount = calls.length;
    expect((await executeScenario(scenario, scenario.files)).status).toBe('infrastructure_error');
    expect(calls).toHaveLength(callCount);
    resetRunnerAdmission();
    expect(runnerHealth().admitting).toBe(true);
  });
});

const realDocker = process.env.FOUNDRY_DOCKER_INTEGRATION === '1';
describe.runIf(realDocker)('real isolated Docker execution', () => {
  beforeEach(() => { spawnMock.mockImplementation(actualProcess.spawn); vi.stubEnv('PYTHON_IMAGE_ID', qualifiedImageId); });

  it.each(listScenarios())('reference passes selected suites in Python 3.11: $id', async scenario => {
    const result = await executeScenario(scenario, scenario.referenceFiles, { includeProtected: true });
    expect(result.status, result.stderr).toBe('completed');
    expect(result.exitCode, JSON.stringify(result.tests)).toBe(0);
    expect(result.tests.map(test => test.id)).toEqual(scenario.tests.map(test => test.id));
    expect(result.tests.every(test => test.status === 'passed'), JSON.stringify(result.tests)).toBe(true);
    expect(result.runtimeDigest).toMatch(/^sha256:/);
  }, 60_000);

  it.each(listScenarios())('starter fails a disclosed check in Docker: $id', async scenario => {
    const result = await executeScenario(scenario, scenario.files, { includeProtected: true });
    expect(result.status, result.stderr).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.tests.some(test => test.status === 'failed' || test.status === 'error')).toBe(true);
  }, 60_000);

  function probeScenario(source: string): Scenario {
    const scenario = example();
    scenario.files = { 'probe.py': source };
    scenario.referenceFiles = { ...scenario.files };
    scenario.tests = [{ id: 'isolation-probe', title: 'Isolation probe', visible: true, timeoutSeconds: 10, source: 'import unittest\nimport probe\nclass ProbeTests(unittest.TestCase):\n    def test_probe(self):\n        self.assertTrue(probe.check())\n' }];
    return scenario;
  }

  it('has no product secrets, no writable root, no host path, and no external network', async () => {
    vi.stubEnv('FOUNDRY_RUNNER_TEST_SECRET', 'host-only-test-sentinel');
    const scenario = probeScenario(`import os, socket\ndef check():\n    assert os.getuid() == 65534\n    assert os.getenv('FOUNDRY_RUNNER_TEST_SECRET') is None\n    assert not os.path.exists('/Users/mayankdhingra')\n    try:\n        open('/foundry-root-write', 'w')\n    except OSError:\n        pass\n    else:\n        return False\n    try:\n        socket.create_connection(('1.1.1.1', 443), timeout=0.2)\n    except OSError:\n        return True\n    return False\n`);
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status, result.stderr).toBe('completed');
    expect(result.tests[0].status, JSON.stringify(result.tests)).toBe('passed');
  }, 60_000);

  it('destroys a real timed-out process and its children', async () => {
    const scenario = probeScenario('import subprocess, sys, time\ndef check():\n    children = [subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"]) for _ in range(3)]\n    time.sleep(60)\n    return bool(children)\n');
    scenario.runtime.timeoutSeconds = 2;
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status, result.stderr).toBe('timeout');
    const remaining = spawnSync('docker', ['ps', '-aq', '--filter', 'label=foundry.interview-execution=true'], { encoding: 'utf8' });
    expect(remaining.status, remaining.stderr).toBe(0);
    expect(remaining.stdout.trim()).toBe('');
  }, 60_000);

  it('bounds actual runaway stdout and destroys its container', async () => {
    const scenario = probeScenario('def check():\n    while True:\n        print("x" * 4096, flush=True)\n');
    const result = await executeScenario(scenario, scenario.files);
    expect(result.status, result.stderr).toBe('infrastructure_error');
    expect(result.stderr).toContain('output exceeded');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64_000);
    const remaining = spawnSync('docker', ['ps', '-aq', '--filter', 'label=foundry.interview-execution=true'], { encoding: 'utf8' });
    expect(remaining.status, remaining.stderr).toBe(0);
    expect(remaining.stdout.trim()).toBe('');
  }, 60_000);

  it('cancels and destroys a real active execution', async () => {
    const scenario = probeScenario('import time\ndef check():\n    time.sleep(60)\n    return True\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const result = await executeScenario(scenario, scenario.files, { signal: controller.signal });
      expect(result.status, result.stderr).toBe('infrastructure_error');
      expect(result.stderr).toContain('cancelled');
      const remaining = spawnSync('docker', ['ps', '-aq', '--filter', 'label=foundry.interview-execution=true'], { encoding: 'utf8' });
      expect(remaining.status, remaining.stderr).toBe(0);
      expect(remaining.stdout.trim()).toBe('');
    } finally { clearTimeout(timer); }
  }, 60_000);
});
