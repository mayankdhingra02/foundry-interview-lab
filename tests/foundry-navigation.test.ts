import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgression, type ProgressionResult } from '../lib/interview-practice/progression';
import { withFoundryNavigation } from '../lib/server/foundry-navigation';

function fixture(): ProgressionResult {
  const result = buildProgression([], []);
  result.studyPlan.foundryLessons.push({ id: 'correctness', title: 'Correctness', foundryPath: '/dsa/foundations/correctness', estimatedMinutes: 20, competencies: ['verification'], verifiedFrom: 'main-foundry-source', verifiedAt: '2026-10-09', requiresFoundryIntegration: true });
  result.studyPlan.steps.push({ kind: 'lesson', id: 'lesson:correctness', title: 'Correctness', reason: 'Source reference.', foundryPath: '/dsa/foundations/correctness', competencyIds: ['verification'], estimatedMinutes: 20, requiresFoundryIntegration: true });
  return result;
}
afterEach(() => vi.unstubAllEnvs());
describe('configured Foundry lesson navigation', () => {
  it('adds only a reviewed exact route without mutating observations or the pure plan', () => {
    const original = fixture(), before = structuredClone(original);
    const result = withFoundryNavigation(original, { origin: 'https://foundry.example', production: true });
    expect(result.studyPlan.foundryLessons[0].navigation).toEqual({ status: 'available', href: 'https://foundry.example/dsa/foundations/correctness' });
    expect(result.studyPlan.steps[0]).toMatchObject({ navigation: result.studyPlan.foundryLessons[0].navigation });
    expect(result.skills).toEqual(before.skills); expect(result.details).toEqual(before.details); expect(original).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('sessionId=');
  });
  it('remains explicitly unavailable without a host', () => {
    expect(withFoundryNavigation(fixture(), { production: true }).studyPlan.foundryLessons[0].navigation).toEqual({ status: 'unavailable', reason: 'not-configured' });
  });
  it.each(['javascript:alert(1)', '//foundry.example', 'https://owner:secret@foundry.example', 'https://foundry.example/prefix', 'https://foundry.example/../', 'https://foundry.example?next=/x', 'https://foundry.example#fragment', 'https://foundry.example ', 'http://foundry.example', 'https://FOUNDRY.example', 'https://foundry.example:443'])('rejects an ambiguous or unsafe configured origin: %s', origin => {
    const result = withFoundryNavigation(fixture(), { origin, production: true });
    expect(result.studyPlan.foundryLessons[0].navigation).toEqual({ status: 'unavailable', reason: 'invalid-configuration' });
    expect(JSON.stringify(result)).not.toContain(origin);
  });
  it('allows a canonical root slash and preserves a configured nondefault HTTPS port', () => {
    const result = withFoundryNavigation(fixture(), { origin: 'https://foundry.example:8443/', production: true });
    expect(result.studyPlan.foundryLessons[0].navigation).toMatchObject({ href: 'https://foundry.example:8443/dsa/foundations/correctness' });
  });
  it('permits HTTP only for an explicit local development host', () => {
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001']) {
      expect(withFoundryNavigation(fixture(), { origin, production: false }).studyPlan.foundryLessons[0].navigation?.status).toBe('available');
      expect(withFoundryNavigation(fixture(), { origin, production: true }).studyPlan.foundryLessons[0].navigation?.status).toBe('unavailable');
    }
    expect(withFoundryNavigation(fixture(), { origin: 'http://localhost.evil.example', production: false }).studyPlan.foundryLessons[0].navigation?.status).toBe('unavailable');
  });
  it('rejects unknown IDs, modified paths and traversal even with a valid host', () => {
    const original = fixture(); original.studyPlan.foundryLessons[0].foundryPath = '//evil.example';
    const step = original.studyPlan.steps[0]; if (step.kind !== 'lesson') throw new Error('Fixture'); step.id = 'lesson:unreviewed';
    const result = withFoundryNavigation(original, { origin: 'https://foundry.example', production: true });
    expect(result.studyPlan.foundryLessons[0].navigation).toEqual({ status: 'unavailable', reason: 'unknown-lesson' });
    expect(result.studyPlan.steps[0]).toMatchObject({ navigation: { status: 'unavailable', reason: 'unknown-lesson' } });
  });
  it('reads the server runtime configuration without a build-time browser variable', () => {
    vi.stubEnv('FOUNDRY_SITE_ORIGIN', 'https://first.example'); vi.stubEnv('NODE_ENV', 'production');
    expect(withFoundryNavigation(fixture()).studyPlan.foundryLessons[0].navigation).toMatchObject({ href: 'https://first.example/dsa/foundations/correctness' });
    vi.stubEnv('FOUNDRY_SITE_ORIGIN', 'https://second.example');
    expect(withFoundryNavigation(fixture()).studyPlan.foundryLessons[0].navigation).toMatchObject({ href: 'https://second.example/dsa/foundations/correctness' });
  });
});
