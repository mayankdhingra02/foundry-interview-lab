import 'server-only';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { annotationSchema, attemptContextDigest, candidateDigest, candidateSetSchema, type BenchmarkAttempt, type Candidate, type HumanAnnotations, type RuntimeCapture } from '../../evals/benchmark';
import { digest } from '../interview-practice/domain';
import { HttpError } from './http';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/);
const version = z.string().min(1).max(100);
export const EVALUATION_REVIEW_MAX_BYTES = 2_000_000;
const bindingSchema = z.object({
  caseId: version, benchmarkVersion: version, recipeDigest: hash,
  scenarioId: version, scenarioVersion: version, scenarioDigest: hash, rubricVersion: version,
  fixtureDigest: hash, contextDigest: hash, executionDigest: hash,
  candidateDigest: hash, annotationDigest: hash, reviewArtifactsDigest: hash,
}).strict();
export const evaluationApprovalSchema = z.object({
  binding: bindingSchema, decision: z.enum(['approved', 'revoked']), decidedBy: identity,
  decidedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  scope: z.literal('fixed-synthetic-staff-display'),
  attestations: z.object({ syntheticOnly: z.literal(true), contentQualityReviewed: z.literal(true), privacyReviewed: z.literal(true), displayApproved: z.literal(true) }).strict(),
}).strict();
export const evaluationReviewBundleSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal('fixed-synthetic-staff-display'),
  benchmarkVersion: version, recipesDigest: hash, captureDigest: hash, baselineDigest: hash,
  candidates: candidateSetSchema, annotations: annotationSchema,
  approvals: z.array(evaluationApprovalSchema).max(60),
}).strict();
export type EvaluationReviewBundle = z.infer<typeof evaluationReviewBundleSchema>;
export type ApprovalRecord = z.infer<typeof evaluationApprovalSchema>;
export type DisplayApproval = {
  status: 'pending' | 'blocked' | 'approved' | 'revoked' | 'expired';
  reason: 'not-recorded' | 'approved' | 'revoked' | 'expired' | 'binding-mismatch' | 'review-incomplete' | 'reviewer-unrecognized' | 'invalid-time';
  decidedAt?: string; expiresAt?: string; artifactDigest?: string;
};
export type ReviewImport = { bundle: EvaluationReviewBundle; authorizedReviewerIds: ReadonlySet<string>; artifactDigest: string; now: number };

export function evaluationApprovalBinding(benchmarkVersion: string, attempt: BenchmarkAttempt, candidate: Candidate, annotation: HumanAnnotations['cases'][number], artifacts: Pick<EvaluationReviewBundle, 'candidates' | 'annotations'>) {
  return bindingSchema.parse({
    caseId: attempt.recipe.id, benchmarkVersion, recipeDigest: digest(attempt.recipe),
    scenarioId: attempt.scenario.id, scenarioVersion: attempt.scenario.version, scenarioDigest: attempt.session.scenarioDigest, rubricVersion: candidate.rubricVersion,
    fixtureDigest: attempt.fixtureIdentity.digest, contextDigest: attemptContextDigest(attempt), executionDigest: digest(attempt.executionContext),
    candidateDigest: candidateDigest(candidate), annotationDigest: digest(annotation), reviewArtifactsDigest: digest(artifacts),
  });
}

/** An operator-supplied record is a display authorization, not proof of expert
 * identity, independent judgment, provider execution or model qualification. */
export function resolveDisplayApproval(input: ReviewImport | undefined, benchmarkVersion: string, attempt: BenchmarkAttempt, candidate: Candidate | undefined, annotation: HumanAnnotations['cases'][number] | undefined, adjudicated: boolean): DisplayApproval {
  const record = input?.bundle.approvals.find(row => row.binding.caseId === attempt.recipe.id);
  if (!input || !record) return { status: 'pending', reason: 'not-recorded' };
  if (!candidate || !annotation || candidate.rubricVersion !== attempt.scenario.version || digest(record.binding) !== digest(evaluationApprovalBinding(benchmarkVersion, attempt, candidate, annotation, { candidates: input.bundle.candidates, annotations: input.bundle.annotations }))) return { status: 'blocked', reason: 'binding-mismatch' };
  const actors = [record.decidedBy, ...annotation.reviews.map(row => row.reviewerId), annotation.adjudication?.adjudicatorId ?? ''];
  if (actors.some(id => !input.authorizedReviewerIds.has(id))) return { status: 'blocked', reason: 'reviewer-unrecognized' };
  const decided = Date.parse(record.decidedAt), expires = Date.parse(record.expiresAt), reviewed = Date.parse(annotation.adjudication?.completedAt ?? '');
  if (!Number.isFinite(input.now) || decided > input.now || expires <= decided || !Number.isFinite(reviewed) || decided < reviewed) return { status: 'blocked', reason: 'invalid-time' };
  const metadata = { decidedAt: record.decidedAt, expiresAt: record.expiresAt, artifactDigest: input.artifactDigest };
  if (record.decision === 'revoked') return { status: 'revoked', reason: 'revoked', ...metadata };
  if (expires <= input.now) return { status: 'expired', reason: 'expired', ...metadata };
  if (!adjudicated) return { status: 'blocked', reason: 'review-incomplete' };
  return { status: 'approved', reason: 'approved', ...metadata };
}

const unavailable = () => new HttpError(503, 'evaluation_review_unavailable', 'The configured evaluation review artifact is unavailable or invalid. No approved content is displayed.');
function parseReviewers(value: string | undefined): ReadonlySet<string> {
  const ids = (value ?? '').split(',');
  if (!ids.length || ids.length > 100 || ids.some(id => !identity.safeParse(id).success) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw unavailable();
  return new Set(ids);
}

/** Only a runtime-configured external private file is accepted. The HTTP caller
 * cannot choose paths; every request reopens the file and checks current policy. */
export async function readEvaluationReviewBundle(env: Readonly<Record<string, string | undefined>> = process.env): Promise<ReviewImport | undefined> {
  const path = env.EVALUATION_REVIEW_BUNDLE_PATH, pin = env.EVALUATION_REVIEW_BUNDLE_SHA256, reviewers = env.EVALUATION_REVIEWER_IDS;
  if (!path && !pin && !reviewers) return undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path || !isAbsolute(path) || !hash.safeParse(pin).success) throw unavailable();
    const authorizedReviewerIds = parseReviewers(reviewers), absolute = resolve(path), project = resolve(process.cwd());
    if (absolute === project || absolute.startsWith(project + sep)) throw unavailable();
    let cursor = parse(absolute).root;
    for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
      cursor = join(cursor, part); const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) throw unavailable();
      if (metadata.isDirectory()) {
        try { await lstat(join(cursor, '.git')); throw unavailable(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const before = await lstat(absolute), parent = await lstat(dirname(absolute));
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || !parent.isDirectory() || (parent.mode & 0o077) !== 0 || before.size < 1 || before.size > EVALUATION_REVIEW_MAX_BYTES) throw unavailable();
    file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || opened.size !== before.size) throw unavailable();
    const bytes = Buffer.alloc(opened.size + 1); let offset = 0;
    while (offset < bytes.length) { const chunk = await file.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
    const after = await file.stat(), current = await lstat(absolute);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink()) throw unavailable();
    const artifactDigest = createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
    if (artifactDigest !== pin) throw unavailable();
    const bundle = evaluationReviewBundleSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
    if (bundle.candidates.candidates.length > 60 || bundle.annotations.cases.length > 60 || new Set(bundle.approvals.map(row => row.binding.caseId)).size !== bundle.approvals.length) throw unavailable();
    return { bundle, authorizedReviewerIds, artifactDigest, now: Date.now() };
  } catch { throw unavailable(); }
  finally { await file?.close(); }
}

export function assertReviewSourceBinding(review: ReviewImport, sources: { recipes: unknown; capture: RuntimeCapture; baseline: unknown; benchmarkVersion: string }) {
  const bundle = evaluationReviewBundleSchema.parse(review.bundle);
  if (bundle.benchmarkVersion !== sources.benchmarkVersion || bundle.recipesDigest !== digest(sources.recipes) || bundle.captureDigest !== digest(sources.capture) || bundle.baselineDigest !== digest(sources.baseline) || new Set(bundle.approvals.map(row => row.binding.caseId)).size !== bundle.approvals.length) throw unavailable();
}
