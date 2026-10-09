import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { buildEvidence } from '../lib/interview-practice/evidence';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';

async function setup(accept = true, noop = false) {
  const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario);
  const base = (await service.createSession('owner', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
  await service.requestAssistant('owner', base.id, { requestId: randomUUID(), expectedRevision: base.revision, mode: 'edit', message: 'Synthetic proposal' });
  const claim = (await service.claimJob('fixture-worker'))!;
  await service.completeJob(claim, { kind: 'assistant', message: 'Synthetic change', files: { 'quote.py': noop ? base.files['quote.py'] : '# Proposed change' }, model: 'fixture', actualUsd: 0 });
  let current = await service.getSession('owner', base.id); const proposalId = current.editProposals[0].id;
  current = (await service.decideEdit('owner', base.id, { requestId: randomUUID(), expectedRevision: current.revision, proposalId, decision: accept ? 'accept' : 'reject' })).session;
  const input = { requestId: randomUUID(), expectedRevision: current.revision, proposalId };
  return { store, service, base, current, input };
}

describe('accepted assistant edit undo', () => {
  it('restores original files with new immutable evidence and retains the original acceptance', async () => {
    const { store, service, base, current, input } = await setup(), before = await service.exportSession('owner', base.id);
    const ledger = (await store.read()).ledger;
    const result = await service.undoEdit('owner', base.id, input), after = await service.exportSession('owner', base.id);
    expect(result.session.files).toEqual(base.files); expect(after.snapshots.length).toBe(before.snapshots.length + 1);
    expect(after.snapshots.slice(0,-1)).toEqual(before.snapshots); expect(after.events.slice(0,-1)).toEqual(before.events);
    expect(result.session.editProposals[0]).toMatchObject({ status: 'accepted', decidedAt: current.editProposals[0].decidedAt, undoneAt: expect.any(String), undoSnapshotId: after.snapshots.at(-1)!.id });
    expect(after.events.at(-1)).toMatchObject({ type: 'workspace.saved', requestId: input.requestId, source: 'learner', payload: { snapshotId: after.snapshots.at(-1)!.id, sha256: after.snapshots.at(-1)!.sha256 } });
    const evidence = buildEvidence(after).find(item => item.kind === 'edit-decision')!;
    expect(evidence.label).toBe('AI edit accepted, later undone'); expect(JSON.parse(evidence.content).undoSnapshotId).toBe(after.snapshots.at(-1)!.id);
    expect((await store.read()).ledger).toEqual(ledger); // Undo never enqueues new provider work.
    expect(result.session.jobs).toEqual(current.jobs);
  });
  it('replays the exact restoration once without erasing later manual work', async () => {
    const { store, service, base, input } = await setup();
    const first = await service.undoEdit('owner', base.id, input);
    await service.saveWorkspace('owner', base.id, { requestId: randomUUID(), expectedRevision: first.session.revision, files: { ...first.session.files, 'quote.py': '# Later manual work' } });
    const saved = await store.read();
    expect(await service.undoEdit('owner', base.id, input)).toEqual(first); expect(await store.read()).toEqual(saved);
  });
  it('rejects newer manual files without changing them', async () => {
    const { store, service, base, current, input } = await setup();
    const saved = await service.saveWorkspace('owner', base.id, { requestId: randomUUID(), expectedRevision: current.revision, files: { ...current.files, 'quote.py': '# Newer manual work' } });
    const before = await store.read();
    await expect(service.undoEdit('owner', base.id, { ...input, expectedRevision: saved.session.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.read()).toEqual(before);
  });
  for (const condition of ['paused','frozen','rejected','already-undone','foreign-owner','stale-revision'] as const) it(`rejects ${condition} undo`, async () => {
    const { store, service, base, current, input } = await setup(condition !== 'rejected');
    if (condition === 'paused') current.revision = (await service.command('owner', base.id, { requestId: randomUUID(), expectedRevision: current.revision, action: 'pause' })).session.revision;
    if (condition === 'frozen') current.revision = (await service.command('owner', base.id, { requestId: randomUUID(), expectedRevision: current.revision, action: 'finish' })).session.revision;
    if (condition === 'already-undone') current.revision = (await service.undoEdit('owner', base.id, input)).session.revision;
    const before = await store.read();
    await expect(service.undoEdit(condition === 'foreign-owner' ? 'someone-else' : 'owner', base.id, { ...input, requestId: randomUUID(), expectedRevision: condition === 'stale-revision' ? 0 : current.revision })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|not_found/) });
    expect(await store.read()).toEqual(before);
  });
  it('records no-op acceptance undo without inventing changed file content', async () => {
    const { service, base, input } = await setup(true, true), before = await service.exportSession('owner', base.id);
    await service.undoEdit('owner', base.id, input); const after = await service.exportSession('owner', base.id);
    expect(after.files).toEqual(base.files); expect(after.snapshots).toEqual(before.snapshots); expect(after.editProposals[0].undoneAt).toBeDefined();
  });
});
