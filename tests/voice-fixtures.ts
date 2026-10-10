import type { PracticeStore } from '../lib/server/store';

// Synthetic debrief state for isolated speech/quota tests. Session command,
// event and authored-interviewer transitions have their own domain tests.
export async function voiceDebriefFixture(store: PracticeStore, sessionId: string) {
  await store.transaction(db => {
    const session = db.sessions[sessionId];
    session.stageId = 'debrief';
    session.codeFrozenSnapshotId = session.snapshots[0].id;
  });
}
