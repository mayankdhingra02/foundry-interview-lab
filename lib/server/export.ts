import type { Session } from '../interview-practice/types';
import { sessionView } from './session-service';

/** Owner export includes every acknowledged snapshot; excludes worker credentials and provider diagnostics. */
export function exportPracticeSession(session: Session) {
  return { exportVersion: 1, ...sessionView(session), snapshots: structuredClone(session.snapshots) };
}
