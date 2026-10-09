import { randomUUID } from 'node:crypto';
import { DomainError } from '../interview-practice/domain';
import type { PracticeDatabase, RequestRecord } from '../interview-practice/types';

/** Minimal replay markers, never copied response bodies or submitted content. */
export function rememberErasedRequests(database: PracticeDatabase, ownerId: string, sessionId: string, requests: Pick<RequestRecord, 'requestId' | 'fingerprint'>[], now: string) {
  if (requests.some(record => !/^[a-zA-Z0-9_-]{8,128}$/.test(record.requestId) || !/^[a-f0-9]{64}$/.test(record.fingerprint))) throw new DomainError('unavailable', 'Erased request identities could not be verified. No partial deletion was committed.');
  // Bound each persisted row independently of the total acknowledged history.
  const batches = Math.max(1, Math.ceil(requests.length / 100));
  for (let index = 0; index < batches; index++) {
    const erasedRequests = requests.slice(index * 100, (index + 1) * 100).map(({ requestId, fingerprint }) => ({ requestId, fingerprint }));
    database.deletions.push({ id: randomUUID(), ownerId, sessionId, createdAt: now, state: 'completed', objectKeys: [], completedAt: now, ...(erasedRequests.length ? { erasedRequests } : {}) });
  }
}

export function assertRequestNotErased(database: PracticeDatabase, ownerId: string, requestId: string, fingerprint: string) {
  for (const deletion of database.deletions) {
    if (deletion.ownerId !== ownerId || deletion.erasedRequests === undefined) continue;
    if (!Array.isArray(deletion.erasedRequests) || deletion.erasedRequests.length > 100) throw new DomainError('unavailable', 'Erased request identities could not be verified.');
    for (const record of deletion.erasedRequests) {
      if (!record || typeof record !== 'object' || !/^[a-zA-Z0-9_-]{8,128}$/.test(record.requestId) || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new DomainError('unavailable', 'Erased request identities could not be verified.');
      if (record.requestId !== requestId) continue;
      if (record.fingerprint !== fingerprint) throw new DomainError('conflict', 'This request key was already used for different input.');
      throw new DomainError('request_deleted', 'The original attempt or request was deleted. Review saved attempts, then explicitly start a new action with a new request key.');
    }
  }
}
