import { setTimeout as delay } from 'node:timers/promises';
import { getService } from '../lib/server/application';
import { processOneJob } from '../lib/server/worker';
import { getBillingService } from '../lib/billing/application';
import { randomUUID } from 'node:crypto';
import { startWorkerHeartbeat } from '../lib/server/operations';
import { closePracticeDatabasePool } from '../lib/server/database-pool';

let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
let stopHeartbeat: (() => Promise<void>) | undefined;
try {
  const service = await getService();
  const billing = getBillingService(), workerId = process.env.WORKER_ID || `worker-${randomUUID()}`;
  stopHeartbeat = await startWorkerHeartbeat(workerId);
  console.log(JSON.stringify({ event: 'worker.started', pid: process.pid }));
  while (!stopped) {
    try {
      const commerce = billing ? await billing.processNextWebhook(workerId) : false;
      const practice = await processOneJob(service, workerId);
      if (!commerce && !practice) await delay(1000);
    }
    catch { console.error(JSON.stringify({ event: 'worker.iteration.failed' })); await delay(2000); }
  }
} finally {
  try { await stopHeartbeat?.(); }
  finally { await closePracticeDatabasePool(); }
}
