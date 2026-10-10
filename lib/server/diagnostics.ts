import 'server-only';
import { randomUUID } from 'node:crypto';

export type FailureCategory = 'identity_unavailable' | 'configuration_unavailable' | 'execution_unavailable' | 'assistance_unavailable' | 'voice_unavailable' | 'billing_unavailable' | 'unexpected_failure';
export interface FailureDiagnostic {
  readonly schemaVersion: 1;
  readonly event: 'request.failed';
  readonly reference: string;
  readonly status: number;
  readonly category: FailureCategory;
}
export type DiagnosticSink = (diagnostic: FailureDiagnostic) => void | Promise<void>;

// Only exact application-owned codes select a category. Unknown codes are never logged.
function category(code?: string): FailureCategory {
  switch (code) {
    case 'identity_unconfigured': case 'sign_in_unavailable': return 'identity_unavailable';
    case 'storage_unconfigured': case 'rollout_unconfigured': return 'configuration_unavailable';
    case 'runner_unavailable': return 'execution_unavailable';
    case 'assistant_unavailable': return 'assistance_unavailable';
    case 'voice_unavailable': case 'voice_provider_unavailable': case 'invalid_speech_audio': return 'voice_unavailable';
    case 'billing_unconfigured': return 'billing_unavailable';
    default: return 'unexpected_failure';
  }
}

const stderr: DiagnosticSink = diagnostic => { console.error(JSON.stringify(diagnostic)); };

/** Diagnostic lookup only: no request, actor, session, error object or learner content is accepted. */
export function recordOperationalFailure(status: number, code?: string, sink: DiagnosticSink = stderr): string | undefined {
  if (!Number.isInteger(status) || status < 500 || status > 599) return undefined;
  const reference = randomUUID();
  const diagnostic: FailureDiagnostic = Object.freeze({ schemaVersion: 1, event: 'request.failed', reference, status, category: category(code) });
  try {
    // A collector outage must neither replace the response nor produce an unhandled rejection.
    void Promise.resolve(sink(diagnostic)).catch(() => undefined);
  } catch { /* Best effort; the reference may have no retained diagnostic during a collector outage. */ }
  return reference;
}
