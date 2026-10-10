import { pathToFileURL } from 'node:url';
import { canaryPlan, parseCanaryArguments, runDisposableCanary } from '../../lib/server/canary';

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCanaryArguments(args);
    if (options.mode === 'plan') { console.log(JSON.stringify(canaryPlan())); return 0; }
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await runDisposableCanary({ context: options.context, isolatedExecutionHost: options.isolatedExecutionHost, signal: controller.signal });
      console.log(JSON.stringify(result));
      return result.status === 'passed' ? 0 : 1;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } catch {
    console.error(JSON.stringify({ event: 'canary.failed', category: 'invalid_options', actionsPerformed: 0 }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
