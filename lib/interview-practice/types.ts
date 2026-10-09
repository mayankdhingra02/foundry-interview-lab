import type { PracticeEvent } from './events';
import type { LearnerCheckBinding } from './check-policy';
import type { PracticeSetupConditions } from './timing';
export type { EventType, PracticeEvent } from './events';

export type PracticeMode = 'practice' | 'simulation';
export type Lifecycle = 'active' | 'paused' | 'reviewing' | 'completed';
export type ScenarioStage = { id: string; title: string; brief: string; requirements: string[] };
export type RubricCriterion = { id: string; name: string; description: string; anchors: { strong: string; developing: string; needsWork: string } };
export type ScenarioProbe = { id: string; stageId: string; competencyId: string; question: string; hint?: string };
export type ScenarioTest = { id: string; title: string; source: string; visible: boolean; timeoutSeconds: number };
export type PracticeDrill = { id: string; title: string; competencyId: string; lesson: string; exercise: string };
export type Scenario = {
  id: string; version: string; title: string; summary: string; durationMinutes: number;
  level: string; tags: string[]; language: 'python'; files: Record<string, string>;
  stages: ScenarioStage[]; rubric: RubricCriterion[]; probes: ScenarioProbe[]; hints: string[];
  tests: ScenarioTest[]; referenceFiles: Record<string, string>; drills: PracticeDrill[];
  rights: string; runtime: { image: string; timeoutSeconds: number; memoryMb: number };
};
// Public test metadata is useful to the learner. Private test source and solutions are never exposed.
export type PublicScenario = Omit<Scenario, 'referenceFiles' | 'tests' | 'probes' | 'hints'> & {
  tests: Array<Omit<ScenarioTest, 'source'> & { source?: string }>;
};
export type SessionConfiguration = { role: string; level: string; skills: string[]; targetMinutes: number; aiHelp: boolean; accommodations: string[]; voice?: boolean; practiceConditions?: PracticeSetupConditions; originalTargetMinutes?: number };
export type Snapshot = { id: string; sequence: number; createdAt: string; sha256: string; files: Record<string, string> };
export type Turn = { id: string; role: 'interviewer' | 'learner'; text: string; source: 'typed' | 'transcribed' | 'corrected' | 'model' | 'authored'; createdAt: string; replyTo?: string; competencyId?: string; evidenceIds: string[] };
export type TestObservation = { id: string; title: string; status: 'passed' | 'failed' | 'error' | 'skipped'; detail?: string };
export type RunExecution = { status: 'completed' | 'infrastructure_error' | 'timeout'; command: string; stdout: string; stderr: string; exitCode: number | null; tests: TestObservation[]; durationMs: number; runtimeDigest?: string };
export type TestRun = RunExecution & { id: string; jobId: string; snapshotId: string; snapshotSha256: string; createdAt: string; testSuiteDigest: string; learnerCheck?: LearnerCheckBinding };
export type AssistantMessage = { id: string; role: 'learner' | 'assistant'; text: string; createdAt: string; model?: string; mode?: 'ask' | 'plan' | 'edit' };
export type EditProposal = { id: string; jobId: string; baseSnapshotId: string; baseSha256: string; files: Record<string, string>; status: 'pending' | 'accepted' | 'rejected'; createdAt: string; decidedAt?: string; undoneAt?: string; undoSnapshotId?: string };
export type EvidenceItem = { id: string; kind: 'snapshot' | 'test' | 'utterance' | 'edit-decision' | 'assistant'; label: string; content: string; sha256: string; snapshotId?: string; file?: string; testId?: string; turnId?: string; runId?: string; source: string };
export type EvidenceManifest = { digest: string; watermark: number; items: EvidenceItem[]; frozenAt: string };
export type RubricLevel = 'Strong' | 'Developing' | 'Needs work' | 'Not observed';
export type CoachingFinding = { criterionId: string; level: RubricLevel; feedback: string; evidenceIds: string[]; confidence: 'low' | 'medium' | 'high' };
export type CoachOutput = { overview: string; rubric: CoachingFinding[]; nextPractice: Array<{ drillId: string; reason: string }> };
export type CoachingReport = CoachOutput & { id: string; generationId: string; createdAt: string; model: string; promptVersion: string; rubricVersion: string; evidenceDigest: string; evidence: EvidenceItem[]; correction?: { sourceReportId: string; reason: string; publishedAt: string } };
export type InterviewProposal = { action: 'ask_probe' | 'end_debrief'; question?: string; competencyId?: string; evidenceIds: string[]; probeId?: string };
export type JobKind = 'run' | 'interviewer' | 'assistant' | 'coach';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type InferenceRecord = { requestedModel: string; returnedModel: string; promptVersion: string; inputTokens: number; outputTokens: number; providerRequestId?: string; responseId?: string; startedAt: string; completedAt: string; usd: number; validated: boolean };
export type PracticeJob = { id: string; sessionId: string; ownerId: string; kind: JobKind; state: JobState; requestId: string; fingerprint: string; snapshotId: string; input: Record<string, unknown>; createdAt: string; updatedAt: string; attempt: number; reservationSequence: number; fencingToken: number; claimToken: string | null; workerId: string | null; leaseExpiresAt: string | null; cancellationRequested: boolean; safeError?: string; reservedUsd: number; actualUsd?: number; inference?: InferenceRecord };
export type JobClaim = { job: PracticeJob; workerId: string; claimToken: string; fencingToken: number };
export type JobView = Omit<PracticeJob, 'ownerId' | 'claimToken' | 'workerId' | 'input' | 'fingerprint' | 'inference'>;
export type JobResult = (
  | { kind: 'run'; run: RunExecution; actualUsd?: number }
  | { kind: 'interviewer'; proposal: InterviewProposal; model: string; actualUsd?: number }
  | { kind: 'assistant'; message: string; files?: Record<string, string>; model: string; actualUsd?: number }
  | { kind: 'coach'; report: CoachOutput; model: string; promptVersion: string; actualUsd?: number }) & { inference?: InferenceRecord };
export type Mutation = { requestId: string; expectedRevision: number };
export type UsageSummary = { reservedUsd: number; spentUsd: number; uncertainUsd: number; runs: number; aiCalls: number; voiceAllocatedSeconds?: number };
export type Session = {
  id: string; ownerId: string; scenarioId: string; scenarioVersion: string; scenarioDigest: string;
  scenario: PublicScenario; mode: PracticeMode; configuration: SessionConfiguration; lifecycle: Lifecycle;
  stageId: string; revision: number; files: Record<string, string>; snapshots: Snapshot[];
  codeFrozenSnapshotId: string | null; frozenEvidence: EvidenceManifest | null;
  events: PracticeEvent[]; turns: Turn[]; runs: TestRun[]; jobs: PracticeJob[];
  assistantMessages: AssistantMessage[]; editProposals: EditProposal[]; reports: CoachingReport[];
  usage: UsageSummary; createdAt: string; updatedAt: string; hintsOpened: number; completedDrillIds: string[]; promptExposure: 'fresh' | 'repeated';
};
export type SessionView = Omit<Session, 'ownerId' | 'scenarioDigest' | 'snapshots' | 'jobs'> & {
  jobs: JobView[];
  evidence: EvidenceItem[];
  // Transport may add these from server configuration, never infer configured provider availability.
  capabilities?: { interviewer: boolean; assistant: boolean; voice: boolean; runner: boolean };
};
export type RequestRecord = { ownerId: string; requestId: string; fingerprint: string; result: unknown; createdAt: string; sessionId?: string };
export type LedgerEntry = { id: string; ownerId: string; sessionId: string; operationId: string; kind: 'admission' | 'reservation' | 'settlement' | 'uncertain'; amountUsd: number; createdAt: string; budgetAt?: string };
export type DeletionRecord = { id: string; ownerId: string; sessionId: string; createdAt: string; state: 'pending' | 'completed'; objectKeys: string[]; completedAt?: string; erasedRequests?: Array<{ requestId: string; fingerprint: string }> };
export type ReviewCase = { id: string; ownerId: string; sessionId: string; reportId: string | null; category: 'feedback' | 'technical'; message: string; criterionIds: string[]; status: 'open' | 'triaged' | 'resolved'; revision: number; inspectionConsent: boolean; supportActionsConsent: boolean; consentVersion: 'support-inspection-v1'; consentExpiresAt: string | null; createdAt: string; updatedAt: string; resolution?: string };
export type CorrectionDraft = { id: string; ownerId: string; sessionId: string; caseId: string; sourceReportId: string; reportId: string; generationId: string; evidenceDigest: string; evidenceWatermark: number; reason: string; report: CoachOutput; createdBy: string; createdAt: string };
export type CorrectionDecision = { id: string; ownerId: string; sessionId: string; caseId: string; draftId: string; reviewerId: string; decision: 'approve' | 'reject'; note: string; createdAt: string };
export type CorrectionPublication = { id: string; ownerId: string; sessionId: string; caseId: string; draftId: string; reportId: string; generationId: string; publishedBy: string; createdAt: string };
export type ReviewAudit = { id: string; actorId: string; ownerId?: string; sessionId?: string; caseId?: string; action: string; purpose: string; createdAt: string; targetId?: string };
export type ReviewDatabase = { cases: Record<string, ReviewCase>; drafts: Record<string, CorrectionDraft>; decisions: Record<string, CorrectionDecision>; publications: Record<string, CorrectionPublication>; audits: ReviewAudit[] };
export type PracticeDatabase = { schemaVersion: 1; sessions: Record<string, Session>; requests: Record<string, RequestRecord>; ledger: LedgerEntry[]; deletions: DeletionRecord[]; reviews?: ReviewDatabase };
