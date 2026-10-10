import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

if (process.env.FOUNDRY_CONTAINER_SMOKE !== '1') throw new Error('Set FOUNDRY_CONTAINER_SMOKE=1 to launch only the already-built local qualification images.');
const exec = promisify(execFile), name = `foundry-ops-web-${randomUUID().slice(0, 12)}`;
const docker = (args: string[]) => exec('docker', args, { timeout: 30_000, maxBuffer: 16_000 });
try {
  await docker(['run', '--pull=never', '--rm', '-d', '--name', name, '--label=foundry.operations-qualification=true', '--read-only', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m', '--tmpfs=/app/.next/cache:rw,nosuid,nodev,size=64m', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-p', '127.0.0.1::3000', 'foundry-lab-ops-qualification:web']);
  const port = Number((await docker(['port', name, '3000/tcp'])).stdout.trim().split(':').at(-1));
  let live: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) { try { live = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); if (live.ok) break; } catch { /* bounded startup poll */ } await delay(100); }
  const readiness = await fetch(`http://127.0.0.1:${port}/api/health/readiness`, { signal: AbortSignal.timeout(3000) });
  const state = await readiness.json() as { status?: string; checks?: { storage?: string } };
  const home = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) });
  const uid = (await docker(['exec', name, 'id', '-u'])).stdout.trim();
  const omitted = (await docker(['exec', name, 'node', '-e', 'for(const p of ["eslint","eslint-config-next","typescript","vitest"]){try{require.resolve(p);process.exit(1)}catch(e){if(e.code!=="MODULE_NOT_FOUND")throw e}}console.log("development-tools-absent")'])).stdout.trim() === 'development-tools-absent';
  const worker = await docker(['run', '--pull=never', '--rm', '--read-only', '--tmpfs=/tmp:rw,nosuid,nodev,size=32m', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint=node', 'foundry-lab-ops-qualification:worker', '--conditions=react-server', '--import=tsx', '-e', 'Promise.all([import("./lib/runtime/runner.ts"),import("./lib/server/operations.ts")]).then(()=>console.log("worker-imports-ok"))']);
  const dockerClient = await docker(['run', '--pull=never', '--rm', '--entrypoint=docker', 'foundry-lab-ops-qualification:worker', '--version']);
  const checks = { webLiveness: live?.status === 200, homepage: home.ok, missingStorageReadinessFails: readiness.status === 503 && state.status === 'not_ready' && state.checks?.storage === 'unconfigured', unprivilegedWeb: uid === '1000', developmentToolsOmitted: omitted, workerRuntimeImports: worker.stdout.includes('worker-imports-ok'), workerDockerClientStarts: dockerClient.stdout.startsWith('Docker version') };
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'Local already-built image startup smoke; no credentials, hosted services, learner execution, or public deployment.', checks, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed' }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally { await docker(['rm', '--force', name]).catch(() => undefined); }
