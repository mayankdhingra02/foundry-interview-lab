import { z } from 'zod';

// No arbitrary property bag: codes, transcripts, paths and free text do not fit.
export const latencyMetric = z.enum(['workspace.save', 'text.turn', 'job.queue', 'sandbox.provision', 'run.result', 'report.ready', 'voice.transcribe', 'voice.playback', 'voice.answer-to-audio']);
const duration = z.number().finite().min(0).max(3_600_000);
const outcome = z.enum(['acknowledged', 'failed', 'cancelled']);
export const telemetryObservation = z.discriminatedUnion('event', [
  z.object({ event: z.literal('practice.started'), mode: z.enum(['practice', 'simulation']) }).strict(),
  z.object({ event: z.literal('practice.submitted'), mode: z.enum(['practice', 'simulation']) }).strict(),
  z.object({ event: z.literal('assistance.requested'), mode: z.enum(['ask', 'plan', 'edit']) }).strict(),
  z.object({ event: z.literal('feedback.opened'), reportKind: z.enum(['original', 'corrected']) }).strict(),
  z.object({ event: z.literal('focused-drill.completed'), provenance: z.literal('learner-self-report') }).strict(),
  z.object({ event: z.literal('unseen-retest.completed'), priorFocusedDrill: z.literal(true), exposureBasis: z.literal('saved-history-only') }).strict(),
  z.object({ event: z.literal('latency.measured'), metric: latencyMetric, durationMs: duration, outcome, jobKind: z.enum(['run', 'interviewer', 'assistant', 'coach']).optional() }).strict(),
]);
export type TelemetryObservation = z.infer<typeof telemetryObservation>;
export type LatencyMetric = z.infer<typeof latencyMetric>;
export type TelemetryOrigin = 'server' | 'browser-unverified';

// Browser observations are descriptive and never become skill/evidence facts.
export const browserObservation = z.discriminatedUnion('event', [
  z.object({ event: z.literal('feedback.opened'), eventId: z.string().uuid(), reportId: z.string().uuid() }).strict(),
  z.object({ event: z.literal('latency.measured'), eventId: z.string().uuid(), metric: latencyMetric, durationMs: duration, outcome, jobId: z.string().uuid().optional() }).strict(),
]);
export type BrowserObservation = z.infer<typeof browserObservation>;
