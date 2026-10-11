import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../interview-practice/domain';
import { parseSessionEvents } from '../interview-practice/events';
import type { PracticeDatabase } from '../interview-practice/types';
import { preserveAccountClosings, validateAccountClosings } from '../interview-practice/account-closing';
import { validateStoredPrivateCleanup } from '../interview-practice/private-cleanup';

export const emptyDatabase = (): PracticeDatabase => ({ schemaVersion: 1, sessions: {}, requests: {}, ledger: [], deletions: [] });
/** Persistence validation rejects the whole operation; it never drops a bad replay record. */
export function validateStoredEvents(database: PracticeDatabase) {
  validateAccountClosings(database);
  validateStoredPrivateCleanup(database);
  try {
    for (const [id, session] of Object.entries(database.sessions)) {
      if (session.id !== id) throw new Error('invalid_session_identity');
      session.events = parseSessionEvents(session.events, id);
    }
  } catch {
    throw new DomainError('unavailable', 'Practice event storage could not be validated. Existing data was not overwritten.');
  }
}
export interface PracticeStore {
  read(): Promise<PracticeDatabase>;
  transaction<T>(operation: (database: PracticeDatabase) => T | Promise<T>): Promise<T>;
  /** Local adapters can create the map; PostgreSQL requires its dedicated migration. */
  readonly supportsAccountClosing?: boolean;
  /** Trusted transaction-only extension; returns no learner contents. */
  captureOwnerObjectKeys?(ownerId: string): Promise<string[]>;
  /** PostgreSQL must verify durable private accounting before permanent close. */
  assertDurableAccounting?(): Promise<void>;
}
// This adapter deliberately targets one local machine. Public deployments must select a qualified database adapter.
export class FilePracticeStore implements PracticeStore {
  readonly supportsAccountClosing = true;
  readonly file: string;
  readonly lock: string;
  constructor(readonly directory: string, private readonly lockTimeoutMs = 10_000) {
    this.file = join(directory, 'practice.json'); this.lock = join(directory, '.transaction-lock');
  }
  private async load(): Promise<PracticeDatabase> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as PracticeDatabase;
      if (value.schemaVersion !== 1 || !value.sessions || !value.requests || !Array.isArray(value.ledger) || !Array.isArray(value.deletions)) throw new Error('invalid_store');
      if (value.reviews && (!value.reviews.cases || !value.reviews.drafts || !value.reviews.decisions || !value.reviews.publications || !Array.isArray(value.reviews.audits))) throw new Error('invalid_review_store');
      validateStoredEvents(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase();
      throw new DomainError('unavailable', 'Practice storage could not be read. The existing data was not overwritten.');
    }
  }
  async read(): Promise<PracticeDatabase> { return structuredClone(await this.load()); }
  private async recoverAbandonedLock() {
    const recovery = join(this.directory, '.lock-recovery');
    try { await mkdir(recovery, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
    try {
      // Only one reclaimer examines/removes a dead lock. Contenders cannot remove a successor's live lock.
      let abandoned = false;
      try {
        const owner = JSON.parse(await readFile(join(this.lock, 'owner.json'), 'utf8')) as { pid: number };
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const metadata = await stat(this.lock).catch(() => null);
          abandoned = metadata !== null && Date.now() - metadata.mtimeMs > 30_000;
        }
      }
      if (abandoned) await rm(this.lock, { recursive: true, force: true });
    } finally { await rm(recovery, { recursive: true, force: true }); }
  }
  private async acquire(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(this.lock, { mode: 0o700 });
        try { await writeFile(join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 }); }
        catch (error) { await rm(this.lock, { recursive: true, force: true }); throw error; }
        return () => rm(this.lock, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.recoverAbandonedLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new DomainError('unavailable', 'Practice storage is busy. Retry the same request key.');
        await delay(25);
      }
    }
  }
  async transaction<T>(operation: (database: PracticeDatabase) => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const database = await this.load(), before = structuredClone(database.accountClosings), result = await operation(database);
      preserveAccountClosings({ ...database, accountClosings: before }, database);
      validateStoredEvents(database);
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(database)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return structuredClone(result);
    } finally { await rm(temp, { force: true }).catch(() => undefined); await release(); }
  }
}
export class MemoryPracticeStore implements PracticeStore {
  readonly supportsAccountClosing = true;
  private database = emptyDatabase();
  private tail: Promise<void> = Promise.resolve();
  async read() { await this.tail; const copy = structuredClone(this.database); validateStoredEvents(copy); return copy; }
  async transaction<T>(operation: (database: PracticeDatabase) => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const copy = structuredClone(this.database); validateStoredEvents(copy);
      const result = await operation(copy); validateStoredEvents(copy); preserveAccountClosings(this.database, copy);
      this.database = copy; return structuredClone(result);
    } finally { release(); }
  }
}
