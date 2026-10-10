import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { runnerHealth } from '../runtime/runner';
import { configuredRuntimeBinding, DEFAULT_SCENARIO_IMAGE } from '../runtime/binding';
import { authMode } from './config';

type Query = Pick<Pool, 'query'>;
const exec = promisify(execFile);
let operationsPool: Pool | undefined;
function pool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  return operationsPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2_000, statement_timeout: 2_000, idleTimeoutMillis: 10_000 });
}
const executionEnabled = () => process.env.FEATURE_EXECUTION !== 'false';
export type Readiness = { status: 'ready' | 'not_ready'; service: 'foundry-interview-lab'; checks: { configuration: 'ok' | 'unconfigured'; storage: 'ok' | 'unavailable' | 'unconfigured'; schema: 'ok' | 'missing' | 'not_checked'; worker: 'ok' | 'stale' | 'not_checked'; execution: 'ok' | 'blocked' | 'unavailable' | 'disabled' | 'not_checked' }; checkedAt: string };

export async function recordWorkerHeartbeat(db: Query, workerId: string, runnerReady: boolean, stopping = false): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workerId)) throw new Error('Invalid worker identifier.');
  await db.query('insert into public.practice_worker_heartbeats(worker_id,runner_ready,stopping) values ($1,$2,$3) on conflict(worker_id) do update set last_seen_at=now(),runner_ready=excluded.runner_ready,stopping=excluded.stopping', [workerId, runnerReady, stopping]);
}
export async function setExecutionAdmission(db: Query, blocked: boolean, reason: 'cleanup_unconfirmed' | 'operator_hold' | null): Promise<void> {
  if (blocked !== (reason !== null)) throw new Error('Admission state and reason disagree.');
  const result = await db.query('update public.practice_operations_state set blocked=$1,reason_code=$2,updated_at=now() where key=$3', [blocked, reason, 'execution_admission']);
  if (result.rowCount !== 1) throw new Error('Execution admission state is missing.');
}
export async function executionAdmissionOpen(): Promise<boolean> {
  if (!runnerHealth().admitting) return false;
  const db = pool();
  if (!db) return process.env.NODE_ENV !== 'production';
  try { return (await db.query<{ blocked: boolean }>("select blocked from public.practice_operations_state where key='execution_admission'")).rows[0]?.blocked === false; }
  catch { return false; }
}
export async function blockExecutionAdmission(): Promise<void> {
  const db = pool();
  if (!db) return;
  await setExecutionAdmission(db, true, 'cleanup_unconfirmed');
}

/** Public-safe readiness: no URLs, credential state, IDs, queue details, or exception bodies. */
export async function probeReadiness(db: Query | null, options: { executionRequired?: boolean; configurationReady?: boolean; now?: () => Date } = {}): Promise<Readiness> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const checks: Readiness['checks'] = { configuration: options.configurationReady === false ? 'unconfigured' : 'ok', storage: db ? 'unavailable' : 'unconfigured', schema: 'not_checked', worker: 'not_checked', execution: options.executionRequired === false ? 'disabled' : 'not_checked' };
  const result = () => ({ status: Object.values(checks).every(value => ['ok', 'disabled'].includes(value)) ? 'ready' as const : 'not_ready' as const, service: 'foundry-interview-lab' as const, checks, checkedAt });
  if (!db) return result();
  try {
    await db.query('select 1'); checks.storage = 'ok';
    const schema = await db.query<{ ready: boolean }>("select to_regclass('public.ai_practice_sessions') is not null and to_regclass('public.ai_practice_snapshots') is not null and to_regclass('public.ai_practice_jobs') is not null and to_regclass('public.practice_worker_heartbeats') is not null and to_regclass('public.practice_operations_state') is not null as ready");
    checks.schema = schema.rows[0]?.ready ? 'ok' : 'missing';
    if (checks.schema !== 'ok') return result();
    const workers = await db.query<{ fresh: boolean; runner_ready: boolean }>("select coalesce(bool_or(not stopping and last_seen_at >= now() - interval '90 seconds'),false) as fresh,coalesce(bool_or(not stopping and runner_ready and last_seen_at >= now() - interval '90 seconds'),false) as runner_ready from public.practice_worker_heartbeats");
    checks.worker = workers.rows[0]?.fresh ? 'ok' : 'stale';
    if (options.executionRequired !== false) {
      const state = await db.query<{ blocked: boolean }>("select blocked from public.practice_operations_state where key='execution_admission'");
      checks.execution = state.rows[0]?.blocked !== false ? 'blocked' : workers.rows[0]?.runner_ready ? 'ok' : 'unavailable';
    }
  } catch { if (checks.storage !== 'ok') checks.storage = 'unavailable'; else if (checks.schema === 'ok') checks.worker = 'not_checked'; }
  return result();
}
export async function readiness(): Promise<Readiness> {
  let configurationReady = authMode() !== 'unconfigured';
  if (authMode() === 'local' && (process.env.SESSION_SECRET?.length ?? 0) < 32) configurationReady = false;
  try { new URL(process.env.APP_URL || (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:3000' : '')); }
  catch { configurationReady = false; }
  return probeReadiness(pool(), { executionRequired: executionEnabled(), configurationReady });
}

/** Restricted operational counters. Never expose this response as learner-facing health. */
export async function operationalCounters(db: Query) {
  const result = await db.query<{ queued: number; running: number; expired: number; oldest_queue_seconds: number; pending_deletions: number }>("select (select count(*)::int from public.ai_practice_jobs where state='queued') as queued,(select count(*)::int from public.ai_practice_jobs where state='running') as running,(select count(*)::int from public.ai_practice_jobs where state='running' and lease_expires_at < now()) as expired,coalesce((select extract(epoch from now()-min(created_at))::int from public.ai_practice_jobs where state='queued'),0) as oldest_queue_seconds,(select count(*)::int from public.ai_practice_deletions where state <> 'completed') as pending_deletions");
  return result.rows[0];
}

async function probeDocker(): Promise<boolean> {
  if (!runnerHealth().admitting) return false;
  const binding = configuredRuntimeBinding({ runtime: { image: DEFAULT_SCENARIO_IMAGE,memoryMb: 128,timeoutSeconds: 30 } });
  if (!binding) return false;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name];
  try { const result = await exec('docker', ['image', 'inspect', binding.imageId, '--format', '{{.Id}}'], { timeout: 5_000, maxBuffer: 4_000, env }); return result.stdout.trim() === binding.imageId; }
  catch { return false; }
}

/** Start once per worker process, with the same stable ID used for job claims. */
export async function startWorkerHeartbeat(workerId: string): Promise<() => Promise<void>> {
  const db = pool();
  if (!db) return async () => undefined;
  let stopping = false, inFlight: Promise<void> | undefined;
  const beat = () => inFlight ??= (async () => {
    const runnerReady = !executionEnabled() || await probeDocker();
    if (!runnerHealth().admitting && runnerHealth().blockedReason) await setExecutionAdmission(db, true, 'cleanup_unconfirmed');
    await recordWorkerHeartbeat(db, workerId, runnerReady, stopping);
  })().catch(() => { console.error(JSON.stringify({ event: 'worker.heartbeat.failed', category: 'operations_storage' })); }).finally(() => { inFlight = undefined; });
  await beat();
  const interval = setInterval(() => { void beat(); }, 15_000);
  interval.unref();
  return async () => { stopping = true; clearInterval(interval); await inFlight; await recordWorkerHeartbeat(db, workerId, false, true).catch(() => undefined); };
}

export type ContainerMetadata = { id: string; name: string; createdAt: string; labels: Record<string, string> };
export function orphanCandidates(containers: ContainerMetadata[], now = new Date()): ContainerMetadata[] {
  return containers.filter(container => /^[a-f0-9]{12,64}$/.test(container.id) && /^\/?foundry-run-[a-f0-9-]+$/.test(container.name) && container.labels['foundry.interview-execution'] === 'true' && Number.isFinite(Date.parse(container.createdAt)) && now.getTime() - Date.parse(container.createdAt) > 10 * 60_000);
}
