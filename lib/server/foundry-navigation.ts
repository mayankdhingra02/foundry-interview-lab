import 'server-only';
import { isAuthoredFoundryLesson, type FoundryLessonNavigation, type ProgressionResult } from '../interview-practice/progression';

type Configuration = { origin?: string; production: boolean };
function configuredOrigin({ origin, production }: Configuration): { origin: string } | { reason: 'not-configured' | 'invalid-configuration' } {
  if (!origin) return { reason: 'not-configured' };
  // Accept a bare origin, optionally with its root slash. Reject credentials,
  // normalized traversal, queries, fragments and whitespace instead of fixing
  // operator typos into a different destination. Nothing is fetched here.
  if (origin.length > 2048 || /\s/.test(origin)) return { reason: 'invalid-configuration' };
  try {
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        ![url.origin, `${url.origin}/`].includes(origin) ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production))) return { reason: 'invalid-configuration' };
    return { origin: url.origin };
  } catch { return { reason: 'invalid-configuration' }; }
}

export function withFoundryNavigation(result: ProgressionResult, configuration: Configuration = { origin: process.env.FOUNDRY_SITE_ORIGIN, production: process.env.NODE_ENV === 'production' }): ProgressionResult {
  const configured = configuredOrigin(configuration);
  const navigation = (id: string, path: string): FoundryLessonNavigation => {
    if (!isAuthoredFoundryLesson(id, path)) return { status: 'unavailable', reason: 'unknown-lesson' };
    if ('reason' in configured) return { status: 'unavailable', reason: configured.reason };
    return { status: 'available', href: configured.origin + path };
  };
  const copy = structuredClone(result);
  for (const reference of copy.studyPlan.foundryLessons) reference.navigation = navigation(reference.id, reference.foundryPath);
  for (const step of copy.studyPlan.steps) if (step.kind === 'lesson') {
    step.navigation = navigation(step.id.startsWith('lesson:') ? step.id.slice(7) : '', step.foundryPath);
    if (step.navigation.status === 'available') step.reason = 'Review this related Foundry lesson in a new tab. You may need to sign in on Foundry.';
  }
  if (copy.studyPlan.steps.some(step => step.kind === 'lesson' && step.navigation?.status === 'available')) {
    copy.studyPlan.limitations = copy.studyPlan.limitations.filter(item => item !== 'Related Foundry lesson paths are source references until the main-site integration supplies navigation.');
    copy.studyPlan.limitations.push('Lesson destinations are configured source mappings. Their live availability and Foundry sign-in must be qualified separately; opening a lesson does not record completion.');
  }
  return copy;
}
