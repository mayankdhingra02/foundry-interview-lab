import { setTimeout as delay } from 'node:timers/promises';
import { getService } from '../lib/server/application';
import { processOneJob } from '../lib/server/worker';
import { getBillingService } from '../lib/billing/application';
import { randomUUID } from 'node:crypto';

let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
const service = await getService();
const billing = getBillingService(), workerId = process.env.WORKER_ID || `worker-${randomUUID()}`;
console.log(JSON.stringify({ event: 'worker.started', pid: process.pid }));
while (!stopped) {
  try {
    const commerce = billing ? await billing.processNextWebhook(workerId) : false;
    const practice = await processOneJob(service, workerId);
    if (!commerce && !practice) await delay(1000);
  }
  catch { console.error(JSON.stringify({ event: 'worker.iteration.failed' })); await delay(2000); }
}
