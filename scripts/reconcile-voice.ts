import { dirname, resolve } from 'node:path';
import { DomainError } from '../lib/interview-practice/domain';
import { FilePracticeStore, type PracticeStore } from '../lib/server/store';
import { reconcileVoiceReservations, VOICE_RECONCILIATION_POLICY } from '../lib/voice/ledger';

const help = 'Usage: node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/reconcile-voice.ts [--dry-run|--apply] [--max-reservations 1..500]';
let close: (() => Promise<void>) | undefined;
try {
  const args = process.argv.slice(2);
  let apply = false, modeChosen = false, maxReservations: number = VOICE_RECONCILIATION_POLICY.defaultBatch;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') { console.log(help); process.exit(0); }
    if (arg === '--apply' || arg === '--dry-run') {
      if (modeChosen) throw new DomainError('invalid', 'invalid_options');
      apply = arg === '--apply'; modeChosen = true;
    } else if (arg === '--max-reservations') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new DomainError('invalid', 'invalid_options');
      maxReservations = Number(value);
      if (!Number.isSafeInteger(maxReservations) || maxReservations < 1 || maxReservations > VOICE_RECONCILIATION_POLICY.maximumBatch) throw new DomainError('invalid', 'invalid_options');
    } else throw new DomainError('invalid', 'invalid_options');
  }
  let store: PracticeStore;
  if (process.env.DATABASE_URL) {
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const postgres = new PostgresPracticeStore(process.env.DATABASE_URL); store = postgres; close = () => postgres.close();
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('storage_unconfigured');
    store = new FilePracticeStore(dirname(resolve(process.env.PRACTICE_DATA_PATH || './data/practice.json')));
  }
  console.log(JSON.stringify(await reconcileVoiceReservations(store, { apply, maxReservations })));
} catch (error) {
  console.error(JSON.stringify({ event: 'voice.reconciliation.failed', category: error instanceof DomainError && error.code === 'invalid' ? 'invalid_options' : 'storage_or_policy_unavailable' })); process.exitCode = 1;
} finally { await close?.().catch(() => { console.error(JSON.stringify({ event: 'voice.reconciliation.close.failed' })); process.exitCode = 1; }); }
