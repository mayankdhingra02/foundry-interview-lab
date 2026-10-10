import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getScenario } from '../../lib/content/scenarios';
import { digest } from '../../lib/interview-practice/domain';
import { operationalCounters, probeReadiness, recordWorkerHeartbeat, setExecutionAdmission } from '../../lib/server/operations';
import { PostgresPracticeStore } from '../../lib/server/postgres-store';
import { SessionService } from '../../lib/server/session-service';
import { withDisposablePostgres } from './disposable-postgres';

if (process.env.FOUNDRY_OPERATIONS_QUALIFICATION !== '1') throw new Error('Set FOUNDRY_OPERATIONS_QUALIFICATION=1 to create a disposable local database. Hosted DATABASE_URL is never used.');
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)] ?? 0;
const result = await withDisposablePostgres(async database => {
  const scenario = getScenario('monetary-validation')!, ownerIds = Array.from({ length: 10 }, () => randomUUID());
  await database.admin.query('insert into auth.users(id) select unnest($1::uuid[])', [ownerIds]);
  const service = new SessionService(new PostgresPracticeStore(database.service), getScenario, { maxDailySessions: 20 });
  const sessions = await Promise.all(ownerIds.map(ownerId => service.createSession(ownerId, { scenarioId: scenario.id, requestId: randomUUID() })));
  const saveMs: number[] = [], durable: boolean[] = [];
  await Promise.all(sessions.map(async (created, index) => {
    let session = created.session;
    for (let save = 0; save < 5; save += 1) {
      const files = structuredClone(session.files), path = Object.keys(files).find(path => path.endsWith('.py'))!;
      files[path] += `\n# Synthetic qualification edit ${index}/${save}\n`;
      const input = { requestId: randomUUID(), expectedRevision: session.revision, files };
      const started = performance.now(); session = (await service.saveWorkspace(ownerIds[index], session.id, input)).session;
      saveMs.push(performance.now() - started);
      const replay = await service.saveWorkspace(ownerIds[index], session.id, input);
      const restarted = new SessionService(new PostgresPracticeStore(database.service), getScenario);
      durable.push(digest((await restarted.getSession(ownerIds[index], session.id)).files) === digest(files) && replay.session.revision === session.revision);
    }
  }));
  const firstOwner = ownerIds[0]; let first = (await service.listSessions(firstOwner))[0];
  const writes = await Promise.allSettled([service.saveWorkspace(firstOwner, first.id, { requestId: randomUUID(), expectedRevision: first.revision, files: first.files }), service.saveWorkspace(firstOwner, first.id, { requestId: randomUUID(), expectedRevision: first.revision, files: first.files })]);
  const staleWriteRejected = writes.filter(row => row.status === 'fulfilled').length === 1;
  first = await service.getSession(firstOwner, first.id);
  let clock = new Date();
  const leaseService = new SessionService(new PostgresPracticeStore(database.service), getScenario, { now: () => clock, leaseMs: 1000 });
  await leaseService.requestRun(firstOwner, first.id, { requestId: randomUUID(), expectedRevision: first.revision });
  const oldClaim = await leaseService.claimJob('qualification-old'); clock = new Date(clock.getTime() + 1100);
  const recoveredService = new SessionService(new PostgresPracticeStore(database.service), getScenario, { now: () => clock, leaseMs: 1000 });
  const currentClaim = await recoveredService.claimJob('qualification-new');
  const staleCompletionRejected = await recoveredService.completeJob(oldClaim!, { kind: 'run', actualUsd: 0, run: { status: 'timeout', command: 'synthetic recovery fixture; no code executed', stdout: '', stderr: 'Planned interruption', exitCode: null, tests: [], durationMs: 0 } }) === false;
  await recoveredService.failJob(currentClaim!, 'Planned technical interruption in disposable recovery qualification.', 0);
  await recordWorkerHeartbeat(database.service, 'qualification-worker', true);
  const ready = await probeReadiness(database.service);
  await setExecutionAdmission(database.service, true, 'cleanup_unconfirmed');
  const blocked = await probeReadiness(database.service);
  await setExecutionAdmission(database.service, false, null);
  const anonymous = await database.admin.connect(); let operationalRowsPrivate = false;
  try { await anonymous.query('begin; set local role anon'); try { await anonymous.query('select * from public.practice_worker_heartbeats'); } catch (error) { operationalRowsPrivate = (error as { code?: string }).code === '42501'; } }
  finally { await anonymous.query('rollback'); anonymous.release(); }
  const backupRestore = await database.restoreAndVerify();
  const counters = await operationalCounters(database.service);
  const checks = { acknowledgedSavesPreserved: durable.every(Boolean), duplicateReplayPreserved: durable.every(Boolean), staleWriteRejected, leaseTakeoverFencesOldWorker: staleCompletionRejected && currentClaim!.fencingToken > oldClaim!.fencingToken, freshWorkerReady: ready.status === 'ready', sharedCleanupHoldBlocksReadiness: blocked.checks.execution === 'blocked', operationalRowsPrivate, backupRestoresSessions: backupRestore.matchingSessions, backupRestoresSnapshotDigests: backupRestore.matchingSnapshots };
  const saveP95Ms = percentile(saveMs, 0.95);
  return { generatedAt: new Date().toISOString(), scope: 'Disposable local PostgreSQL migration, durable save, replay, lease recovery, operations and backup/restore smoke. No provider inference or hosted load.', migrations: database.migrationVersions, load: { simultaneousSyntheticSessions: 10, acknowledgedSaves: saveMs.length, saveP50Ms: percentile(saveMs, 0.5), saveP95Ms, saveMaxMs: Math.max(...saveMs), targetSaveP95Ms: 1000 }, recovery: { ...checks, backupRestoreMs: backupRestore.durationMs }, safeCounters: counters, status: Object.values(checks).every(Boolean) && saveP95Ms < 1000 ? 'passed' : 'failed', limitations: ['Small localhost smoke; does not establish hosted beta capacity or monthly availability.', 'No live model, voice, browser-network interruption, or public isolation claim.', 'Local backup/restore is not a production RPO/RTO or backup-retention qualification.'] };
});
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) { const path = process.argv[outputIndex + 1]; if (!path || path.startsWith('--')) throw new Error('--output needs a path.'); await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(resolve(path), JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
