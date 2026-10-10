import { RETENTION_POLICY } from '@/lib/server/retention';
import './retention-notice.css';

// Server rendered from the actual maintenance policy; no private store is read.
export function RetentionNotice() {
  return <section className="settings-section retention-disclosure" aria-labelledby="retention-heading">
    <h2 id="retention-heading">How long practice data stays</h2>
    <p>These are this application’s current storage and maintenance rules. The day counts below are the earliest eligibility for cleanup, subject to the listed protections. They are not guaranteed deletion deadlines; maintenance must be run by the deployment operator.</p>
    <dl className="retention-periods">
      <div><dt>Private attempts and reports</dt><dd>Saved code, explanations, evidence and reports stay until you delete the attempt or your Interview Lab practice data. This maintenance policy does not automatically expire them.</dd></div>
      <div><dt>Application audio replay</dt><dd>Raw microphone audio and synthesized playback are not stored for replay by this application. Optional speech sends content to its configured provider for processing.</dd></div>
      <div><dt>Request and deletion records</dt><dd>Eligible for cleanup after {RETENTION_POLICY.metadataDays} days. Active attempts, unfinished cleanup and dependent replay records remain protected. A request cache may contain a redundant copy of your work; deleting practice data uses the separate erasure workflow.</dd></div>
      <div><dt>Minimal usage counters</dt><dd>Complete, settled usage groups become eligible after {RETENTION_POLICY.ledgerDays} days. Pending or uncertain charges, active obligations and ambiguous records are retained for reconciliation. Deleting an attempt does not reset usage limits.</dd></div>
      <div><dt>Support and payment records</dt><dd>Support history has no automatic expiry in this maintenance operation. Support permissions, erasure, payment records and any separate retention obligations follow their own workflows.</dd></div>
    </dl>
    <p>Downloaded exports remain on your device and cannot be revoked by the app. Backups, model and speech providers, payment services and any approved monitoring system have separate policies. Application deletion does not promise instant deletion of every external copy.</p>
    <p className="muted">Maintenance policy: {RETENTION_POLICY.version}. No cleanup schedule or provider/backup expiry is established by this notice. A hosted deployment must publish its approved policy and qualify those operations before launch.</p>
  </section>;
}
