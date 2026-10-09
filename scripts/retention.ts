import { dirname, resolve } from 'node:path';
import { FilePracticeStore, type PracticeStore } from '../lib/server/store';
import { RETENTION_POLICY, RetentionError, runRetention } from '../lib/server/retention';

const help = 'Usage: node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/retention.ts [--dry-run|--apply] [--max-rows 1..1000]';
let close: (() => Promise<void>) | undefined;
try {
  const args = process.argv.slice(2);
  let apply = false, modeChosen = false, maxRows: number = RETENTION_POLICY.defaultBatchRows;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') { console.log(help); process.exit(0); }
    if (arg === '--apply' || arg === '--dry-run') {
      if (modeChosen) throw new RetentionError('invalid_options');
      apply = arg === '--apply'; modeChosen = true;
    } else if (arg === '--max-rows') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new RetentionError('invalid_options');
      maxRows = Number(value);
      if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > RETENTION_POLICY.maximumBatchRows) throw new RetentionError('invalid_options');
    } else throw new RetentionError('invalid_options');
  }
  let store: PracticeStore;
  if (process.env.DATABASE_URL) {
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const postgres = new PostgresPracticeStore(process.env.DATABASE_URL);
    store = postgres; close = () => postgres.close();
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('storage_unconfigured');
    store = new FilePracticeStore(dirname(resolve(process.env.PRACTICE_DATA_PATH || './data/practice.json')));
  }
  console.log(JSON.stringify(await runRetention(store, { apply, maxRows })));
} catch (error) {
  console.error(JSON.stringify({ event: 'retention.failed', category: error instanceof RetentionError ? error.code : 'storage_or_policy_unavailable' }));
  process.exitCode = 1;
} finally { await close?.().catch(() => { console.error(JSON.stringify({ event: 'retention.close.failed' })); process.exitCode = 1; }); }
