import { dirname, resolve } from 'node:path';
import { FilePracticeStore, type PracticeStore } from '../lib/server/store';
import { runPrivateFileCleanup } from '../lib/server/private-file-cleanup';
import { privateStorageOrigin, SupabasePrivateObjectStore } from '../lib/server/private-object-store';
import { PRIVATE_CLEANUP_POLICY } from '../lib/interview-practice/private-cleanup';

const help = 'Usage: node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/private-file-cleanup.ts [--dry-run|--apply --acknowledge-private-file-deletion] [--max-records 1..5] [--max-objects 1..20] [--allow-local-storage]';
let close: (() => Promise<void>) | undefined;
try {
  const args = process.argv.slice(2);
  let apply = false, chosen = false, acknowledge = false, allowLocal = false;
  let maxRecords: number = PRIVATE_CLEANUP_POLICY.defaultRecords, maxObjects: number = PRIVATE_CLEANUP_POLICY.defaultObjects;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') { console.log(help); process.exit(0); }
    if (argument === '--dry-run' || argument === '--apply') { if (chosen) throw new Error(); apply = argument === '--apply'; chosen = true; }
    else if (argument === '--acknowledge-private-file-deletion') { if (acknowledge) throw new Error(); acknowledge = true; }
    else if (argument === '--allow-local-storage') { if (allowLocal || process.env.NODE_ENV === 'production') throw new Error(); allowLocal = true; }
    else if (argument === '--max-records' || argument === '--max-objects') {
      const raw = args[++index], value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < 1 || value > (argument === '--max-records' ? PRIVATE_CLEANUP_POLICY.maxRecords : PRIVATE_CLEANUP_POLICY.maxObjects)) throw new Error();
      if (argument === '--max-records') maxRecords = value; else maxObjects = value;
    } else throw new Error();
  }
  if (acknowledge !== apply || (apply && process.env.FEATURE_PRIVATE_FILE_CLEANUP !== 'true')) throw new Error();
  let objects: SupabasePrivateObjectStore | undefined;
  if (apply) {
    const url = process.env.PRACTICE_PRIVATE_STORAGE_PROJECT_URL ?? '';
    // An independently explicit target must match the shared Auth/Storage project.
    if (privateStorageOrigin(url, allowLocal) !== privateStorageOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', allowLocal)) throw new Error();
    if (process.env.DATABASE_URL) {
      const database = new URL(process.env.DATABASE_URL), project = new URL(url);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && ['127.0.0.1', 'localhost', '[::1]'].includes(project.hostname);
      const ref = project.hostname.split('.')[0];
      const hosted = database.hostname === `db.${ref}.supabase.co` || (database.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(database.username).split('.').at(-1) === ref);
      if ((!allowLocal || !loopback) && !hosted) throw new Error();
    } else if (!allowLocal) throw new Error();
    objects = new SupabasePrivateObjectStore({ url, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', allowLocal });
  }
  let store: PracticeStore;
  if (process.env.DATABASE_URL) {
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const postgres = new PostgresPracticeStore(process.env.DATABASE_URL); store = postgres; close = () => postgres.close();
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error();
    store = new FilePracticeStore(dirname(resolve(process.env.PRACTICE_DATA_PATH || './data/practice.json')));
  }
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try { console.log(JSON.stringify(await runPrivateFileCleanup(store, objects, { apply, maxRecords, maxObjects, signal: controller.signal }))); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
} catch {
  console.error(JSON.stringify({ event: 'private_file_cleanup.failed', category: 'storage_policy_or_options_unavailable' })); process.exitCode = 1;
} finally { await close?.().catch(() => { console.error(JSON.stringify({ event: 'private_file_cleanup.close_failed' })); process.exitCode = 1; }); }
