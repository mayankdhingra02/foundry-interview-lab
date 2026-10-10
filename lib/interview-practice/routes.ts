/** Mounts are reviewed application routes, never caller-supplied URL prefixes. */
export type PracticeMountProfile = 'standalone' | 'foundry';
export type PracticeRoutes = Readonly<{
  profile: PracticeMountProfile;
  feature: string;
  history: string;
  progress: string;
  settings: string;
  accountSettings: string;
  support: string;
  api: Readonly<{
    practice: string;
    identity: string;
    /** Practice-data deletion only; this is not identity-account deletion. */
    account: string;
    accountExport: string;
    support: string;
  }>;
}>;

const mounts: Readonly<Record<PracticeMountProfile, PracticeRoutes>> = Object.freeze({
  standalone: Object.freeze({
    profile: 'standalone',
    feature: '/interview-practice',
    history: '/history',
    progress: '/progress',
    settings: '/settings',
    accountSettings: '/settings',
    support: '/internal',
    api: Object.freeze({
      practice: '/api/interview-practice',
      identity: '/api/auth/session',
      account: '/api/account',
      accountExport: '/api/account/export',
      support: '/api/internal',
    }),
  }),
  foundry: Object.freeze({
    profile: 'foundry',
    feature: '/interview-practice',
    history: '/interview-practice/history',
    progress: '/interview-practice/progress',
    settings: '/interview-practice/settings',
    accountSettings: '/settings/account',
    support: '/interview-practice/internal',
    api: Object.freeze({
      practice: '/api/interview-practice',
      identity: '/api/interview-practice/identity',
      account: '/api/interview-practice/account',
      accountExport: '/api/interview-practice/account/export',
      support: '/api/interview-practice/internal',
    }),
  }),
});

/** Runtime checks also protect JavaScript callers and unvalidated configuration. */
export function practiceRoutes(profile: PracticeMountProfile = 'standalone'): PracticeRoutes {
  if (profile !== 'standalone' && profile !== 'foundry') throw new Error('Unknown practice mount profile.');
  return mounts[profile];
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function practiceWorkspacePath(id: string, profile: PracticeMountProfile = 'standalone'): string {
  const routes = practiceRoutes(profile);
  if (!uuid(id)) throw new Error('A practice workspace UUID is required.');
  return `${routes.feature}/${id}`;
}

export type PracticeSessionOperation = 'workspace' | 'commands' | 'timing' | 'turns' | 'interaction' |
  'runs' | 'assistant' | 'edit-decisions' | 'undo-edit' | 'hints' | 'drills' | 'reports' |
  'reviews' | 'events' | 'export' | 'observations';
export type PracticeApiSegments =
  | readonly ['capabilities' | 'scenarios' | 'progress' | 'sessions']
  | readonly ['sessions', string]
  | readonly ['sessions', string, PracticeSessionOperation]
  | readonly ['sessions', string, 'voice', 'transcribe' | 'speak']
  | readonly ['jobs', string]
  | readonly ['jobs', string, 'cancel']
  | readonly ['reviews', string, 'consent'];

const sessionOperations: ReadonlySet<string> = new Set<PracticeSessionOperation>([
  'workspace', 'commands', 'timing', 'turns', 'interaction', 'runs', 'assistant',
  'edit-decisions', 'undo-edit', 'hints', 'drills', 'reports', 'reviews', 'events',
  'export', 'observations',
]);

/** Construct only existing practice API templates; queries are a separate concern. */
export function practiceApiPath(segments: PracticeApiSegments, profile: PracticeMountProfile = 'standalone'): string {
  const routes = practiceRoutes(profile);
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) throw new Error('Unknown practice API route.');
  const [resource, id, operation, action] = segments;
  const valid = segments.length === 1
    ? ['capabilities', 'scenarios', 'progress', 'sessions'].includes(resource)
    : uuid(id) && (
      resource === 'sessions' && (segments.length === 2 ||
        segments.length === 3 && sessionOperations.has(operation) ||
        segments.length === 4 && operation === 'voice' && ['transcribe', 'speak'].includes(action)) ||
      resource === 'jobs' && (segments.length === 2 || segments.length === 3 && operation === 'cancel') ||
      resource === 'reviews' && segments.length === 3 && operation === 'consent'
    );
  if (!valid) throw new Error('Unknown practice API route.');
  return `${routes.api.practice}/${segments.join('/')}`;
}
