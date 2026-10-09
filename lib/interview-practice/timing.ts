import { z } from 'zod';
import type { SessionConfiguration } from './types';

export const MAX_ADVISORY_MINUTES = 180;
export const practiceConditionsSchema = z.object({
  timing: z.enum(['standard', 'extra-15', 'extra-30']),
  participation: z.enum(['text-or-voice', 'written-only']),
}).strict();
export type PracticeSetupConditions = z.infer<typeof practiceConditionsSchema>;
export const DEFAULT_PRACTICE_CONDITIONS: PracticeSetupConditions = { timing: 'standard', participation: 'text-or-voice' };
export function setupExtraMinutes(timing: PracticeSetupConditions['timing']): number {
  return timing === 'extra-15' ? 15 : timing === 'extra-30' ? 30 : 0;
}

/** Timing records the learner's practice conditions; no rating logic consumes it. */
export function timingConditions(configuration: SessionConfiguration) {
  const originalTargetMinutes = configuration.originalTargetMinutes ?? configuration.targetMinutes;
  return {
    originalTargetMinutes,
    targetMinutes: configuration.targetMinutes,
    extendedMinutes: Math.max(0, configuration.targetMinutes - originalTargetMinutes),
    setupExtraMinutes: setupExtraMinutes(configuration.practiceConditions?.timing ?? 'standard'),
    participation: configuration.practiceConditions?.participation ?? 'text-or-voice',
    // Existing free-text values remain readable; new setup never collects them.
    recordedConditionCount: configuration.accommodations.length
      + (configuration.practiceConditions?.timing && configuration.practiceConditions.timing !== 'standard' ? 1 : 0)
      + (configuration.practiceConditions?.participation === 'written-only' ? 1 : 0),
  };
}

export function describeTiming(configuration: SessionConfiguration): string {
  const conditions = timingConditions(configuration);
  return `Original advisory target ${conditions.originalTargetMinutes} min${conditions.setupExtraMinutes ? ` (includes ${conditions.setupExtraMinutes} min selected at setup)` : ''}. Current target ${conditions.targetMinutes} min${conditions.extendedMinutes ? `; extended by ${conditions.extendedMinutes} min` : ''}. ${conditions.participation === 'written-only' ? 'Written-only participation selected.' : 'Text participation available; voice optional when enabled.'} Time and participation choices do not lower rubric ratings.`;
}
