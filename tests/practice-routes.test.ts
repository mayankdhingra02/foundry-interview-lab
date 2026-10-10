import { describe, expect, it } from 'vitest';
import { practiceApiPath, practiceRoutes, practiceWorkspacePath, type PracticeApiSegments, type PracticeMountProfile } from '../lib/interview-practice/routes';

const id = '73efbd73-729b-4b58-80ab-8c67240ef3db';

describe('reviewed practice mount profiles', () => {
  it('preserves every standalone route by default', () => {
    expect(practiceRoutes()).toEqual({
      profile: 'standalone', feature: '/interview-practice', history: '/history',
      progress: '/progress', settings: '/settings', accountSettings: '/settings', support: '/internal',
      api: { practice: '/api/interview-practice', identity: '/api/auth/session', account: '/api/account', accountExport: '/api/account/export', support: '/api/internal' },
    });
    expect(practiceRoutes('standalone')).toBe(practiceRoutes());
    expect(practiceWorkspacePath(id)).toBe(`/interview-practice/${id}`);
    expect(practiceApiPath(['sessions', id, 'workspace'])).toBe(`/api/interview-practice/sessions/${id}/workspace`);
  });

  it('keeps feature data and support under the Foundry feature namespace', () => {
    expect(practiceRoutes('foundry')).toEqual({
      profile: 'foundry', feature: '/interview-practice', history: '/interview-practice/history',
      progress: '/interview-practice/progress', settings: '/interview-practice/settings',
      accountSettings: '/settings/account', support: '/interview-practice/internal',
      api: { practice: '/api/interview-practice', identity: '/api/interview-practice/identity', account: '/api/interview-practice/account', accountExport: '/api/interview-practice/account/export', support: '/api/interview-practice/internal' },
    });
  });

  it('returns immutable profiles including nested API destinations', () => {
    for (const profile of ['standalone', 'foundry'] as const) {
      const routes = practiceRoutes(profile);
      expect(Object.isFrozen(routes)).toBe(true); expect(Object.isFrozen(routes.api)).toBe(true);
      expect(() => { (routes as { feature: string }).feature = '//evil.example'; }).toThrow();
      expect(() => { (routes.api as { identity: string }).identity = 'https://evil.example'; }).toThrow();
      for (const path of [...Object.values(routes).filter(value => typeof value === 'string' && value.startsWith('/')), ...Object.values(routes.api)]) {
        expect(path).toMatch(/^\/(?!\/)[a-z/-]+$/);
      }
    }
  });

  it.each(['', 'custom', 'FOUNDRY', '/interview-practice', '../foundry', 'https://evil.example', '//evil.example', 'foundry?next=//evil.example', null, {}, ['foundry']])('rejects arbitrary runtime mount configuration: %j', value => {
    const profile = value as PracticeMountProfile;
    expect(() => practiceRoutes(profile)).toThrow('Unknown practice mount profile.');
    expect(() => practiceWorkspacePath(id, profile)).toThrow();
    expect(() => practiceApiPath(['sessions'], profile)).toThrow();
  });
});

describe('bounded workspace and API destinations', () => {
  it.each(['standalone', 'foundry'] as const)('constructs only known API templates for %s', profile => {
    const routes: PracticeApiSegments[] = [
      ['capabilities'], ['scenarios'], ['progress'], ['sessions'], ['sessions', id],
      ['jobs', id], ['jobs', id, 'cancel'], ['reviews', id, 'consent'],
      ['sessions', id, 'voice', 'speak'], ['sessions', id, 'voice', 'transcribe'],
      ...(['workspace', 'commands', 'timing', 'turns', 'interaction', 'runs', 'assistant',
        'edit-decisions', 'undo-edit', 'hints', 'drills', 'reports', 'reviews', 'events',
        'export', 'observations'] as const).map(operation => ['sessions', id, operation] as const),
    ];
    expect(practiceWorkspacePath(id, profile)).toBe(`/interview-practice/${id}`);
    for (const route of routes) expect(practiceApiPath(route, profile)).toBe(`/api/interview-practice/${route.join('/')}`);
  });

  it.each(['', '.', '..', '../history', `${id}/../settings`, `${id}?after=1`, `${id}#fragment`,
    `${id}\n`, ` ${id}`, `${id}/`, '%2e%2e', '%2Fhistory', '\\evil.example',
    'https://evil.example', '//evil.example', 'x'.repeat(5000),
    '73efbd73-729b-0b58-80ab-8c67240ef3db', '73efbd73-729b-4b58-00ab-8c67240ef3db',
    null, 42, {}])('rejects an unsafe or invalid dynamic ID: %j', value => {
    expect(() => practiceWorkspacePath(value as string)).toThrow('A practice workspace UUID is required.');
    expect(() => practiceApiPath(['sessions', value as string])).toThrow('Unknown practice API route.');
    expect(() => practiceApiPath(['jobs', value as string, 'cancel'])).toThrow();
    expect(() => practiceApiPath(['reviews', value as string, 'consent'])).toThrow();
  });

  it.each([
    [], ['settings'], ['https://evil.example'], ['//evil.example'], ['../sessions'], ['sessions/../account'],
    ['sessions?next=//evil.example'], ['sessions', id, '..'], ['sessions', id, 'unknown'],
    ['sessions', id, 'voice'], ['sessions', id, 'voice', 'exec'], ['sessions', id, 'events', 'extra'],
    ['sessions', id, 'voice', 'speak', 'extra'], ['jobs', id, 'export'], ['reviews', id],
    ['reviews', id, 'consent?redirect=https://evil.example'], null, 'sessions', {},
  ])('rejects arbitrary, malformed or expanded endpoint templates: %j', segments => {
    expect(() => practiceApiPath(segments as PracticeApiSegments)).toThrow('Unknown practice API route.');
  });
});
