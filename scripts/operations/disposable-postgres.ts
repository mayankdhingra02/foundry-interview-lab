import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const exec = promisify(execFile);
export type DisposableDatabase = { container: string; admin: Pool; service: Pool; migrationVersions: string[]; restoreAndVerify: () => Promise<{ durationMs: number; matchingSessions: boolean; matchingSnapshots: boolean }> };
const docker = (args: string[], maxBuffer = 64_000) => exec('docker', args, { timeout: 30_000, maxBuffer, encoding: 'utf8' });

/** Independent max-one contender for this fixture's service pool; never reads
 * DATABASE_URL. pg-pool hides password from enumeration, so a spread alone
 * silently drops the disposable credential. Do not log these options. */
export function disposableServiceContender(source: Pool, applicationName: string): Pool {
  return new Pool({ ...source.options, password: source.options.password, max: 1, application_name: applicationName });
}

function restoreInput(container: string, dump: Buffer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'pg_restore', '-U', 'postgres', '-d', 'foundry_restored', '--no-owner', '--exit-on-error'], { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Disposable restore timed out.')); }, 30_000);
    child.stderr.on('data', () => { /* Do not print catalog or fixture contents. */ });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Disposable restore could not start.')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error('Disposable restore failed.')); });
    child.stdin.on('error', () => undefined); child.stdin.end(dump);
  });
}

/** Never reads DATABASE_URL. Only this newly created local container is mutated. */
export async function withDisposablePostgres<T>(operation: (database: DisposableDatabase) => Promise<T>): Promise<T> {
  const container = `foundry-ops-pg-${randomUUID().slice(0, 12)}`;
  const password = randomBytes(24).toString('hex');
  let admin: Pool | undefined, service: Pool | undefined;
  try {
    await docker(['run', '--pull=never', '--rm', '-d', '--name', container, '--label=foundry.operations-qualification=true', '--memory=512m', '--cpus=2', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=foundry_qualification', '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
    const port = Number((await docker(['port', container, '5432/tcp'])).stdout.trim().split(':').at(-1));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Disposable PostgreSQL port was invalid.');
    const config = { host: '127.0.0.1', port, user: 'postgres', password, database: 'foundry_qualification', max: 12, connectionTimeoutMillis: 1000 };
    admin = new Pool(config);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) { try { await admin.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
    await admin.query(await readFile(resolve('deploy/disposable-auth.sql'), 'utf8'));
    const migrationVersions = (await readdir(resolve('supabase/migrations'))).filter(file => /^\d{12,}_.*\.sql$/.test(file)).sort();
    for (const file of migrationVersions) await admin.query(await readFile(resolve('supabase/migrations', file), 'utf8'));
    service = new Pool({ ...config, options: '-c role=service_role' });
    const original = admin;
    const restoreAndVerify = async () => {
      const started = Date.now();
      await original.query('create database foundry_restored');
      const dump = await exec('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'foundry_qualification', '--format=custom'], { timeout: 30_000, maxBuffer: 16_000_000, encoding: 'buffer' });
      await restoreInput(container, dump.stdout);
      const restored = new Pool({ ...config, database: 'foundry_restored' });
      try {
        const fingerprints = async (db: Pool) => (await db.query<{ sessions: string; snapshots: string }>("select coalesce((select md5(string_agg(id::text || runtime_payload::text,',' order by id)) from public.ai_practice_sessions),'') as sessions,coalesce((select md5(string_agg(id::text || content_sha256,',' order by id)) from public.ai_practice_snapshots),'') as snapshots")).rows[0];
        const left = await fingerprints(original), right = await fingerprints(restored);
        return { durationMs: Date.now() - started, matchingSessions: left.sessions === right.sessions, matchingSnapshots: left.snapshots === right.snapshots };
      } finally { await restored.end(); }
    };
    return await operation({ container, admin, service, migrationVersions, restoreAndVerify });
  } finally {
    await service?.end(); await admin?.end();
    // No prune, shared volumes, pre-existing container, or hosted database is touched.
    await docker(['rm', '--force', container]).catch(() => undefined);
  }
}
