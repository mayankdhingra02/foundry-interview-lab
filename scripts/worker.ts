import { setTimeout as delay } from 'node:timers/promises';
import { getService } from '../lib/server/application';
import { processOneJob } from '../lib/server/worker';

let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
const service = await getService();
console.log(JSON.stringify({ event: 'worker.started', pid: process.pid }));
while (!stopped) {
  try { if (!await processOneJob(service)) await delay(1000); }
  catch { console.error(JSON.stringify({ event: 'worker.iteration.failed' })); await delay(2000); }
}
