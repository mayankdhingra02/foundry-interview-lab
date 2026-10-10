import { completeFixtureJob } from './inference-fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePracticeStore, MemoryPracticeStore } from '../lib/server/store';
import { harness, owner, requestId, scenario } from './review-fixtures';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('persisted event replay boundaries', () => {
  it('rolls back malformed events in memory instead of acknowledging an invalid replay', async () => {
    const context = harness(new MemoryPracticeStore()); const session = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
    await expect(context.store.transaction(db => { db.sessions[session.id].events[0].sequence = 2; })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await context.practice.getSession(owner, session.id)).events[0].sequence).toBe(1);
    await expect(context.store.transaction(db => { db.sessions[session.id].events[0].sessionId = 'other-session'; })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects corrupt stored event versions without overwriting the existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-event-read-')); temporary.push(directory);
    const context = harness(new FilePracticeStore(directory)), session = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
    const file = join(directory, 'practice.json'), db = JSON.parse(await readFile(file, 'utf8')); db.sessions[session.id].events[0].schemaVersion = 99;
    const original = JSON.stringify(db); await writeFile(file, original);
    await expect(new FilePracticeStore(directory).read()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(context.store.transaction(() => undefined)).rejects.toMatchObject({ code: 'unavailable' }); expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('emits an evidence link for assistant proposals without putting proposed source into the event', async () => {
    const context = harness(), session = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
    await context.practice.requestAssistant(owner, session.id, { requestId: requestId(), expectedRevision: session.revision, mode: 'edit', message: 'Propose a change.' });
    const claim = await context.practice.claimJob('fixture-worker');
    await completeFixtureJob(context.practice, claim!, { kind: 'assistant', model: 'synthetic-fixture', message: 'Inspect this change.', files: { 'main.py': 'PRIVATE-PROPOSED-SOURCE' }, actualUsd: 0 });
    const view = await context.practice.getSession(owner, session.id), event = view.events.find(event => event.type === 'assistant.edit-proposed');
    expect(event?.payload).toEqual({ jobId: claim!.job.id, proposalId: view.editProposals[0].id, baseSnapshotId: view.editProposals[0].baseSnapshotId, baseSha256: view.editProposals[0].baseSha256, paths: ['main.py'] });
    expect(JSON.stringify(event)).not.toContain('PRIVATE-PROPOSED-SOURCE');
  });
});
