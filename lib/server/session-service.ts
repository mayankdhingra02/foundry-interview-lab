import { randomUUID } from 'node:crypto';
import { appendEvent, assertActive, assertCoding, assertRequestId, assertRevision, boundedText, createSnapshot, digest, DomainError, ownedSession, requestKey, selectedSnapshot, toPublicScenario, validateFiles } from '../interview-practice/domain';
import { buildEvidence, freezeEvidence, validateInterviewProposal, validateReport } from '../interview-practice/evidence';
import type { InferenceRecord, JobClaim, JobKind, JobResult, JobView, Mutation, PracticeDatabase, PracticeJob, Scenario, Session, SessionConfiguration, SessionView } from '../interview-practice/types';
import type { PracticeStore } from './store';

export type SessionAdmissionContext = { ownerId: string; sessionId: string; scenarioId: string; scenarioVersion: string; requestId: string; now: string; database: PracticeDatabase };
export type ServiceOptions = { now?: () => Date; maxDailySessions?: number; maxActiveSessions?: number; maxDailyUsd?: number; maxMonthlyUsd?: number; maxGlobalDailyUsd?: number; maxSessionUsd?: number; maxRuns?: number; maxAiCalls?: number; leaseMs?: number; reservations?: Partial<Record<JobKind, number>>; admissionPolicy?: (context: SessionAdmissionContext) => Promise<void> };
export type CreateSessionInput = { scenarioId: string; version?: string; mode?: 'practice' | 'simulation'; requestId: string; configuration?: Partial<SessionConfiguration>; role?: string; level?: string; skills?: string[]; targetMinutes?: number; durationMinutes?: number; aiHelp?: boolean; aiAssistance?: boolean; accommodations?: string[] };
export type SessionMutationResult = { session: SessionView; job?: JobView; hint?: string };
export type TrustedSupportGuard = (database: PracticeDatabase, now: string) => void;
export function publicJob(job: PracticeJob): JobView {
  const { ownerId: _owner, claimToken: _claim, workerId: _worker, input: _input, fingerprint: _fingerprint, inference: _inference, ...view } = structuredClone(job);
  void _owner; void _claim; void _worker; void _input; void _fingerprint; void _inference;
  return view;
}
export function sessionView(session: Session): SessionView {
  const { ownerId: _owner, scenarioDigest: _digest, snapshots: _snapshots, jobs, ...view } = structuredClone(session);
  void _owner; void _digest; void _snapshots;
  return { ...view, jobs: jobs.map(publicJob), evidence: session.frozenEvidence?.items ?? buildEvidence(session) };
}
export class SessionService {
  private readonly now: () => Date;
  private readonly limits: Required<Omit<ServiceOptions, 'now' | 'reservations' | 'admissionPolicy'>>;
  private readonly admissionPolicy: ServiceOptions['admissionPolicy'];
  private readonly reservations: Record<JobKind, number>;
  constructor(readonly store: PracticeStore, private readonly resolveScenario: (id: string, version?: string) => Scenario | null, options: ServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.admissionPolicy = options.admissionPolicy;
    const { now: _now, reservations: _reservations, admissionPolicy: _policy, ...limits } = options;
    void _now; void _reservations; void _policy;
    this.limits = { maxDailySessions: 10, maxActiveSessions: 3, maxDailyUsd: 5, maxMonthlyUsd: 50, maxGlobalDailyUsd: 50, maxSessionUsd: 1, maxRuns: 30, maxAiCalls: 25, leaseMs: 60_000, ...limits };
    this.reservations = { run: 0, interviewer: 0.04, assistant: 0.08, coach: 0.15, ...options.reservations };
    if (Object.values(this.limits).some(value => !Number.isFinite(value) || value <= 0) || Object.values(this.reservations).some(value => !Number.isFinite(value) || value < 0)) throw new DomainError('invalid', 'Practice limits must be finite positive numbers and reservations nonnegative.');
  }
  private at() { return this.now().toISOString(); }
  private scenario(session: Session) {
    const scenario = this.resolveScenario(session.scenarioId, session.scenarioVersion);
    if (!scenario || digest(scenario) !== session.scenarioDigest) throw new DomainError('unavailable', 'This saved scenario version changed. Restore its original package before continuing.');
    return scenario;
  }
  private async mutate<T>(ownerId: string, requestId: string, operation: string, payload: unknown, sessionId: string | undefined, apply: (db: PracticeDatabase, now: string) => T | Promise<T>): Promise<T> {
    if (!ownerId || ownerId.length > 200) throw new DomainError('invalid', 'A verified owner is required.');
    assertRequestId(requestId);
    const fingerprint = digest({ operation, payload, sessionId: sessionId ?? null });
    return this.store.transaction(async db => {
      const key = requestKey(ownerId, requestId), existing = db.requests[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new DomainError('conflict', 'This request key was already used for different input.');
        return existing.result as T;
      }
      const now = this.at(), result = await apply(db, now);
      db.requests[key] = { ownerId, requestId, fingerprint, result: structuredClone(result), createdAt: now, ...(sessionId ? { sessionId } : {}) };
      return result;
    });
  }
  private reserve(db: PracticeDatabase, session: Session, job: PracticeJob, amount: number, now: string) {
    const commitment = session.usage.reservedUsd + session.usage.spentUsd + session.usage.uncertainUsd;
    const daily = db.ledger.filter(l => l.ownerId === session.ownerId && l.createdAt.slice(0, 10) === now.slice(0, 10)).reduce((sum, l) => sum + l.amountUsd, 0);
    const monthly = db.ledger.filter(l => l.ownerId === session.ownerId && l.createdAt.slice(0, 7) === now.slice(0, 7)).reduce((sum, l) => sum + l.amountUsd, 0);
    const globalDaily = db.ledger.filter(l => l.createdAt.slice(0, 10) === now.slice(0, 10)).reduce((sum, l) => sum + l.amountUsd, 0);
    if (amount > 0 && (commitment + amount > this.limits.maxSessionUsd + 1e-9 || daily + amount > this.limits.maxDailyUsd + 1e-9 || monthly + amount > this.limits.maxMonthlyUsd + 1e-9 || globalDaily + amount > this.limits.maxGlobalDailyUsd + 1e-9)) throw new DomainError('quota', 'The AI budget cannot cover this request. Your work is still saved.');
    session.usage.reservedUsd += amount;
    job.reservationSequence = (job.reservationSequence ?? 0) + 1;
    db.ledger.push({ id: randomUUID(), ownerId: session.ownerId, sessionId: session.id, operationId: `${job.id}:${job.reservationSequence}:reserve`, kind: 'reservation', amountUsd: amount, createdAt: now });
  }
  private enqueue(db: PracticeDatabase, session: Session, kind: JobKind, requestId: string, input: Record<string, unknown>, now: string): PracticeJob {
    if (kind === 'run' && session.usage.runs >= this.limits.maxRuns) throw new DomainError('quota', 'This attempt has reached its test-run limit.');
    const aiLimitReached = kind !== 'run' && session.usage.aiCalls >= this.limits.maxAiCalls;
    if (kind === 'assistant' && aiLimitReached) throw new DomainError('quota', 'This attempt has reached its AI request limit.');
    if (session.jobs.some(j => j.kind === kind && ['queued', 'running'].includes(j.state))) throw new DomainError('conflict', `A ${kind} operation is already pending.`);
    const job: PracticeJob = { id: randomUUID(), sessionId: session.id, ownerId: session.ownerId, kind, state: 'queued', requestId, fingerprint: digest(input), snapshotId: selectedSnapshot(session).id, input: structuredClone(input), createdAt: now, updatedAt: now, attempt: 0, reservationSequence: 0, fencingToken: 0, claimToken: null, workerId: null, leaseExpiresAt: null, cancellationRequested: false, reservedUsd: this.reservations[kind] };
    if ((kind === 'interviewer' || kind === 'coach') && (aiLimitReached || job.reservedUsd === 0)) { job.reservedUsd = 0; job.input.forceAuthored = true; }
    try { this.reserve(db, session, job, job.reservedUsd, now); }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'quota' || (kind !== 'interviewer' && kind !== 'coach')) throw error;
      job.reservedUsd = 0; job.input.forceAuthored = true;
      this.reserve(db, session, job, 0, now);
    }
    session.jobs.push(job);
    if (kind === 'run') session.usage.runs += 1; else if (!job.input.forceAuthored) session.usage.aiCalls += 1;
    return job;
  }
  private settle(db: PracticeDatabase, session: Session, job: PracticeJob, now: string, actualUsd?: number, definitelyNotCalled = false) {
    if (actualUsd !== undefined && (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > 100)) throw new DomainError('invalid', 'Invalid provider usage settlement.');
    session.usage.reservedUsd = Math.max(0, session.usage.reservedUsd - job.reservedUsd);
    const actual = definitelyNotCalled ? 0 : actualUsd;
    if (actual === undefined && job.reservedUsd > 0) {
      session.usage.uncertainUsd += job.reservedUsd;
      db.ledger.push({ id: randomUUID(), ownerId: session.ownerId, sessionId: session.id, operationId: `${job.id}:${job.reservationSequence}:uncertain`, kind: 'uncertain', amountUsd: 0, createdAt: now });
    } else {
      session.usage.spentUsd += actual ?? 0; job.actualUsd = actual ?? 0;
      db.ledger.push({ id: randomUUID(), ownerId: session.ownerId, sessionId: session.id, operationId: `${job.id}:${job.reservationSequence}:settle`, kind: 'settlement', amountUsd: (actual ?? 0) - job.reservedUsd, createdAt: now });
    }
  }
  async createSession(ownerId: string, input: CreateSessionInput): Promise<SessionMutationResult> {
    const { requestId, ...creation } = input;
    return this.mutate(ownerId, requestId, 'create', creation, undefined, async (db, now) => {
      const scenario = this.resolveScenario(input.scenarioId, input.version);
      if (!scenario?.stages.length || !scenario.rubric.length) throw new DomainError('not_found', 'Scenario not found.');
      const all = Object.values(db.sessions).filter(s => s.ownerId === ownerId);
      const dailyAdmissions = db.ledger.filter(l => l.ownerId === ownerId && l.kind === 'admission' && l.createdAt.slice(0, 10) === now.slice(0, 10)).length;
      if (dailyAdmissions >= this.limits.maxDailySessions || all.filter(s => ['active', 'paused', 'reviewing'].includes(s.lifecycle)).length >= this.limits.maxActiveSessions) throw new DomainError('quota', 'Session limit reached. Finish an existing attempt or try again later.');
      if (input.mode !== undefined && !['practice', 'simulation'].includes(input.mode)) throw new DomainError('invalid', 'Select practice or simulation mode.');
      const config = input.configuration ?? {};
      const configuration: SessionConfiguration = { role: (config.role ?? input.role ?? 'Backend engineer').slice(0, 120), level: (config.level ?? input.level ?? scenario.level).slice(0, 100), skills: config.skills ?? input.skills ?? [...scenario.tags], targetMinutes: config.targetMinutes ?? input.targetMinutes ?? input.durationMinutes ?? scenario.durationMinutes, aiHelp: config.aiHelp ?? input.aiHelp ?? input.aiAssistance ?? true, accommodations: config.accommodations ?? input.accommodations ?? [] };
      if (!Number.isInteger(configuration.targetMinutes) || configuration.targetMinutes < 5 || configuration.targetMinutes > 180 || !Array.isArray(configuration.skills) || configuration.skills.length > 20 || configuration.skills.some(s => typeof s !== 'string' || s.length > 100) || !Array.isArray(configuration.accommodations) || configuration.accommodations.length > 10 || configuration.accommodations.some(s => typeof s !== 'string' || s.length > 200) || typeof configuration.aiHelp !== 'boolean') throw new DomainError('invalid', 'Invalid session configuration.');
      const session: Session = { id: randomUUID(), ownerId, scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), scenario: toPublicScenario(scenario), mode: input.mode ?? 'practice', configuration, lifecycle: 'active', stageId: scenario.stages[0].id, revision: 0, files: validateFiles(scenario.files, scenario), snapshots: [], codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: all.some(s => s.scenarioId === scenario.id) ? 'repeated' : 'fresh' };
      await this.admissionPolicy?.({ ownerId, sessionId: session.id, scenarioId: scenario.id, scenarioVersion: scenario.version, requestId, now, database: db });
      createSnapshot(session, session.files, now); appendEvent(session, 'session.started', { scenarioId: scenario.id, scenarioVersion: scenario.version, mode: session.mode }, input.requestId, now, 'learner');
      db.sessions[session.id] = session;
      db.ledger.push({ id: randomUUID(), ownerId, sessionId: session.id, operationId: `${session.id}:admission`, kind: 'admission', amountUsd: 0, createdAt: now });
      // Tie admission cache to this session so deletion erases cached private state too.
      const result = { session: sessionView(session) };
      return result;
    });
  }
  async listSessions(ownerId: string) { return Object.values((await this.store.read()).sessions).filter(s => s.ownerId === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(sessionView); }
  async getSession(ownerId: string, id: string) { return sessionView(ownedSession((await this.store.read()).sessions, ownerId, id)); }
  async exportSession(ownerId: string, id: string) { return structuredClone(ownedSession((await this.store.read()).sessions, ownerId, id)); }
  async exportAccount(ownerId: string) { return Object.values((await this.store.read()).sessions).filter(s => s.ownerId === ownerId); }
  async events(ownerId: string, id: string, after = 0) {
    if (!Number.isInteger(after) || after < 0) throw new DomainError('invalid', 'Invalid replay sequence.');
    return (await this.exportSession(ownerId, id)).events.filter(e => e.sequence > after);
  }
  async saveWorkspace(ownerId: string, id: string, input: Mutation & { files: Record<string, string> }): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'workspace', { files: input.files }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertCoding(session);
      session.files = validateFiles(input.files, this.scenario(session));
      const snapshot = createSnapshot(session, session.files, now);
      appendEvent(session, 'workspace.saved', { snapshotId: snapshot.id, sha256: snapshot.sha256 }, input.requestId, now, 'learner');
      return { session: sessionView(session) };
    });
  }
  async command(ownerId: string, id: string, input: Mutation & { action: 'advance' | 'pause' | 'resume' | 'finish' | 'submit' }): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'command', { action: input.action }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision);
      const scenario = this.scenario(session);
      if (input.action === 'pause') { assertActive(session); session.lifecycle = 'paused'; appendEvent(session, 'session.paused', {}, input.requestId, now, 'learner'); }
      else if (input.action === 'resume') { if (session.lifecycle !== 'paused') throw new DomainError('conflict', 'This session is not paused.'); session.lifecycle = 'active'; appendEvent(session, 'session.resumed', {}, input.requestId, now, 'learner'); }
      else if (input.action === 'advance') {
        assertCoding(session);
        const index = scenario.stages.findIndex(s => s.id === session.stageId), next = scenario.stages[index + 1];
        if (!next || next.id === 'debrief') throw new DomainError('conflict', 'Choose Finish coding to freeze your work and enter debrief.');
        session.stageId = next.id; appendEvent(session, 'stage.changed', { stageId: next.id }, input.requestId, now, 'learner');
      } else if (input.action === 'finish') {
        assertCoding(session);
        if (session.jobs.some(j => ['queued', 'running'].includes(j.state))) throw new DomainError('conflict', 'Wait for pending work, or cancel it, before finishing coding.');
        session.codeFrozenSnapshotId = selectedSnapshot(session).id; session.stageId = 'debrief';
        appendEvent(session, 'coding.finished', { snapshotId: session.codeFrozenSnapshotId }, input.requestId, now, 'learner');
        const job = this.enqueue(db, session, 'interviewer', input.requestId, { reason: 'debrief-start', evidenceDigest: digest(buildEvidence(session)) }, now);
        return { session: sessionView(session), job: publicJob(job) };
      } else if (input.action === 'submit') {
        assertActive(session);
        if (!session.codeFrozenSnapshotId || session.stageId !== 'debrief') throw new DomainError('conflict', 'Finish coding and enter debrief before final submission.');
        if (session.jobs.some(j => ['queued', 'running'].includes(j.state))) throw new DomainError('conflict', 'Wait for pending questions/tests, or cancel them, before final submission.');
        appendEvent(session, 'session.submitted', { snapshotId: session.codeFrozenSnapshotId }, input.requestId, now, 'learner');
        session.frozenEvidence = freezeEvidence(session, now); session.lifecycle = 'reviewing';
        const job = this.enqueue(db, session, 'coach', input.requestId, { evidenceDigest: session.frozenEvidence.digest, watermark: session.frozenEvidence.watermark, generationId: randomUUID() }, now);
        return { session: sessionView(session), job: publicJob(job) };
      } else throw new DomainError('invalid', 'Unknown session command.');
      return { session: sessionView(session) };
    });
  }
  async commitTurn(ownerId: string, id: string, input: Mutation & { text: string; source?: 'typed' | 'transcribed' | 'corrected'; replyTo?: string }): Promise<SessionMutationResult> {
    const text = boundedText(input.text, 'Answer');
    return this.mutate(ownerId, input.requestId, 'turn', { text, source: input.source ?? 'typed', replyTo: input.replyTo ?? null }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertActive(session);
      if (session.stageId !== 'debrief' || !session.codeFrozenSnapshotId || session.frozenEvidence) throw new DomainError('conflict', 'Answers are recorded during the frozen-code debrief.');
      if (input.source && !['typed', 'transcribed', 'corrected'].includes(input.source)) throw new DomainError('invalid', 'Only finalized learner answers can be committed.');
      const question = session.turns.at(-1);
      if (!question || question.role !== 'interviewer' || (input.replyTo && input.replyTo !== question.id)) throw new DomainError('conflict', 'Wait for the interviewer’s current question before answering.');
      const turn = { id: randomUUID(), role: 'learner' as const, text, source: input.source ?? 'typed' as const, createdAt: now, replyTo: question.id, evidenceIds: [] };
      session.turns.push(turn); appendEvent(session, 'learner.answer-committed', { turnId: turn.id, replyTo: question.id }, input.requestId, now, 'learner');
      const job = this.enqueue(db, session, 'interviewer', input.requestId, { replyTo: turn.id, evidenceDigest: digest(buildEvidence(session)) }, now);
      return { session: sessionView(session), job: publicJob(job) };
    });
  }
  async requestRun(ownerId: string, id: string, input: Mutation): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'run', {}, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertActive(session);
      if (session.frozenEvidence) throw new DomainError('conflict', 'Final evidence is frozen.');
      const scenario = this.scenario(session), job = this.enqueue(db, session, 'run', input.requestId, { testSuiteDigest: digest(scenario.tests), runtime: scenario.runtime }, now);
      appendEvent(session, 'test.requested', { jobId: job.id, snapshotId: job.snapshotId }, input.requestId, now, 'learner');
      return { session: sessionView(session), job: publicJob(job) };
    });
  }
  async requestAssistant(ownerId: string, id: string, input: Mutation & { mode: 'ask' | 'plan' | 'edit'; message?: string; prompt?: string }): Promise<SessionMutationResult> {
    const prompt = boundedText(input.message ?? input.prompt, 'Assistant message', 3000);
    return this.mutate(ownerId, input.requestId, 'assistant', { mode: input.mode, prompt }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertCoding(session);
      if (!session.configuration.aiHelp) throw new DomainError('conflict', 'Coding assistance is disabled for this attempt.');
      if (!['ask', 'plan', 'edit'].includes(input.mode)) throw new DomainError('invalid', 'Choose ask, plan or edit.');
      const job = this.enqueue(db, session, 'assistant', input.requestId, { mode: input.mode, prompt }, now);
      session.assistantMessages.push({ id: randomUUID(), role: 'learner', text: prompt, createdAt: now, mode: input.mode });
      appendEvent(session, 'assistant.requested', { jobId: job.id, mode: input.mode }, input.requestId, now, 'learner');
      return { session: sessionView(session), job: publicJob(job) };
    });
  }
  async decideEdit(ownerId: string, id: string, input: Mutation & { proposalId: string; decision?: 'accept' | 'reject'; accept?: boolean }): Promise<SessionMutationResult> {
    const accept = input.decision ? input.decision === 'accept' : input.accept === true;
    return this.mutate(ownerId, input.requestId, 'edit-decision', { proposalId: input.proposalId, accept }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertCoding(session);
      const proposal = session.editProposals.find(p => p.id === input.proposalId && p.status === 'pending');
      if (!proposal) throw new DomainError('not_found', 'Pending edit proposal not found.');
      if (accept) {
        if (selectedSnapshot(session).sha256 !== proposal.baseSha256) throw new DomainError('conflict', 'Files changed after this proposal. Reject it and ask for a fresh edit.');
        session.files = validateFiles({ ...session.files, ...proposal.files }, this.scenario(session)); createSnapshot(session, session.files, now);
      }
      proposal.status = accept ? 'accepted' : 'rejected'; proposal.decidedAt = now;
      appendEvent(session, 'assistant.edit-decided', { proposalId: proposal.id, decision: proposal.status }, input.requestId, now, 'learner');
      return { session: sessionView(session) };
    });
  }
  async revealHint(ownerId: string, id: string, input: Mutation): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'hint', {}, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision); assertCoding(session);
      if (session.mode !== 'practice') throw new DomainError('conflict', 'Authored hints are disabled in simulation.');
      const hints = this.scenario(session).hints;
      if (!hints.length) throw new DomainError('not_found', 'No authored hints are available.');
      const hint = hints[Math.min(session.hintsOpened, hints.length - 1)]; session.hintsOpened += 1;
      appendEvent(session, 'hint.opened', { index: session.hintsOpened - 1, hint }, input.requestId, now, 'learner');
      return { session: sessionView(session), hint };
    });
  }
  async completeDrill(ownerId: string, id: string, input: Mutation & { drillId: string }): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'drill', { drillId: input.drillId }, id, (db, now) => {
      const session = ownedSession(db.sessions, ownerId, id); assertRevision(session, input.expectedRevision);
      if (!this.scenario(session).drills.some(d => d.id === input.drillId)) throw new DomainError('invalid', 'Unknown practice drill.');
      if (!session.completedDrillIds.includes(input.drillId)) session.completedDrillIds.push(input.drillId);
      appendEvent(session, 'drill.completed', { drillId: input.drillId, provenance: 'learner-self-report' }, input.requestId, now, 'learner');
      return { session: sessionView(session) };
    });
  }
  async getJob(ownerId: string, jobId: string) {
    const job = Object.values((await this.store.read()).sessions).filter(s => s.ownerId === ownerId).flatMap(s => s.jobs).find(j => j.id === jobId);
    if (!job) throw new DomainError('not_found', 'Job not found.'); return publicJob(job);
  }
  async claimJob(workerId: string, kinds?: JobKind[]): Promise<JobClaim | null> {
    if (!workerId || workerId.length > 100) throw new DomainError('invalid', 'A worker identifier is required.');
    return this.store.transaction(db => {
      const now = this.at();
      for (const session of Object.values(db.sessions)) for (const job of session.jobs) {
        if (kinds && !kinds.includes(job.kind)) continue;
        const expired = job.state === 'running' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now;
        if (job.state !== 'queued' && !expired) continue;
        if (expired) this.settle(db, session, job, now); // Prior inference may have been billed even if its response was lost.
        if (job.cancellationRequested || job.attempt >= 3) {
          if (!expired) this.settle(db, session, job, now, 0, true);
          job.state = job.cancellationRequested ? 'cancelled' : 'failed'; job.safeError = 'Operation stopped after cancellation or repeated interruption.'; job.updatedAt = now;
          appendEvent(session, 'operation.failed', { jobId: job.id, error: job.safeError }, job.requestId, now); continue;
        }
        if (expired) {
          try {
            if (job.kind !== 'run' && session.usage.aiCalls >= this.limits.maxAiCalls) throw new DomainError('quota', 'AI call limit reached.');
            this.reserve(db, session, job, job.reservedUsd, now);
            if (job.kind !== 'run') session.usage.aiCalls += 1;
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'quota') throw error;
            job.state = 'failed'; job.safeError = 'Budget cannot cover a retry after interruption.'; job.updatedAt = now;
            appendEvent(session, 'operation.failed', { jobId: job.id, error: job.safeError }, job.requestId, now); continue;
          }
        }
        job.state = 'running'; job.attempt += 1; job.fencingToken += 1; job.claimToken = randomUUID(); job.workerId = workerId; job.updatedAt = now; job.leaseExpiresAt = new Date(this.now().getTime() + this.limits.leaseMs).toISOString();
        return { job: structuredClone(job), workerId, claimToken: job.claimToken, fencingToken: job.fencingToken };
      }
      return null;
    });
  }
  private locateClaim(db: PracticeDatabase, claim: JobClaim, now: string) {
    const session = db.sessions[claim.job.sessionId], job = session?.jobs.find(j => j.id === claim.job.id);
    if (!session || !job || job.state !== 'running' || job.claimToken !== claim.claimToken || job.fencingToken !== claim.fencingToken || job.workerId !== claim.workerId || !job.leaseExpiresAt || job.leaseExpiresAt <= now || job.cancellationRequested) return null;
    return { session, job };
  }
  async heartbeatJob(claim: JobClaim) {
    return this.store.transaction(db => {
      const now = this.at(), found = this.locateClaim(db, claim, now); if (!found) return false;
      found.job.leaseExpiresAt = new Date(this.now().getTime() + this.limits.leaseMs).toISOString(); found.job.updatedAt = now; return true;
    });
  }
  async completeJob(claim: JobClaim, result: JobResult): Promise<boolean> {
    return this.store.transaction(db => {
      const now = this.at(), found = this.locateClaim(db, claim, now); if (!found) return false;
      const { session, job } = found;
      if (job.kind !== result.kind) throw new DomainError('invalid', 'Worker result does not match the admitted job.');
      const scenario = this.scenario(session), snapshot = session.snapshots.find(s => s.id === job.snapshotId);
      if (!snapshot) throw new DomainError('unavailable', 'Admitted snapshot not found.');
      if (result.kind === 'run') {
        const run = result.run;
        if (!['completed', 'infrastructure_error', 'timeout'].includes(run.status) || !Number.isFinite(run.durationMs) || run.durationMs < 0 || typeof run.command !== 'string' || run.command.length > 1000 || typeof run.stdout !== 'string' || typeof run.stderr !== 'string' || run.stdout.length + run.stderr.length > 128_000 || !Array.isArray(run.tests) || run.tests.length > 100 || new Set(run.tests.map(t => t.id)).size !== run.tests.length || run.tests.some(t => !scenario.tests.some(test => test.id === t.id) || !['passed', 'failed', 'error', 'skipped'].includes(t.status) || typeof t.title !== 'string' || (t.detail?.length ?? 0) > 5000)) throw new DomainError('invalid', 'Runner returned invalid or unknown test observations.');
        if (run.status !== 'completed' && run.tests.length && run.tests.every(t => t.status === 'passed')) throw new DomainError('invalid', 'An incomplete run cannot claim every reported check passed. Retain completed observations alongside explicit missing checks.');
        const record = { ...structuredClone(run), id: randomUUID(), jobId: job.id, snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, testSuiteDigest: String(job.input.testSuiteDigest), createdAt: now };
        session.runs.push(record); appendEvent(session, 'test.completed', { runId: record.id, jobId: job.id, snapshotId: snapshot.id, status: run.status }, job.requestId, now, 'runner');
      } else if (result.kind === 'interviewer') {
        if (session.frozenEvidence || session.stageId !== 'debrief') return false;
        const proposal = validateInterviewProposal(result.proposal, scenario, session);
        if (proposal.action === 'ask_probe') {
          const turn = { id: randomUUID(), role: 'interviewer' as const, text: proposal.question!, source: result.model === 'authored' ? 'authored' as const : 'model' as const, competencyId: proposal.competencyId, evidenceIds: proposal.evidenceIds, createdAt: now };
          session.turns.push(turn); appendEvent(session, 'interviewer.question', { turnId: turn.id, competencyId: proposal.competencyId ?? '', model: result.model }, job.requestId, now, result.model === 'authored' ? 'server' : 'model');
        } else appendEvent(session, 'stage.changed', { stageId: 'debrief', readyToSubmit: true }, job.requestId, now);
      } else if (result.kind === 'assistant') {
        const message = boundedText(result.message, 'Assistant response', 16000);
        session.assistantMessages.push({ id: randomUUID(), role: 'assistant', text: message, createdAt: now, model: result.model });
        if (result.files && Object.keys(result.files).length) {
          if (job.input.mode !== 'edit') throw new DomainError('invalid', 'Only an edit request can propose file changes.');
          if (Object.keys(result.files).some(path => !Object.hasOwn(snapshot.files, path))) throw new DomainError('invalid', 'Assistant proposed a file outside this scenario.');
          validateFiles({ ...snapshot.files, ...result.files }, scenario);
          const proposal = { id: randomUUID(), jobId: job.id, baseSnapshotId: snapshot.id, baseSha256: snapshot.sha256, files: structuredClone(result.files), status: 'pending' as const, createdAt: now };
          session.editProposals.push(proposal);
          appendEvent(session, 'assistant.edit-proposed', { jobId: job.id, proposalId: proposal.id, baseSnapshotId: snapshot.id, baseSha256: snapshot.sha256, paths: Object.keys(proposal.files).sort() }, job.requestId, now, 'model');
        }
        appendEvent(session, 'assistant.responded', { jobId: job.id, model: result.model }, job.requestId, now, 'model');
      } else {
        if (!session.frozenEvidence || session.frozenEvidence.digest !== job.input.evidenceDigest) throw new DomainError('conflict', 'Coaching input changed after admission.');
        const output = validateReport(result.report, scenario, session.frozenEvidence);
        session.reports.push({ ...output, id: randomUUID(), generationId: String(job.input.generationId), createdAt: now, model: result.model, promptVersion: result.promptVersion, rubricVersion: scenario.version, evidenceDigest: session.frozenEvidence.digest, evidence: structuredClone(session.frozenEvidence.items) });
        session.lifecycle = 'completed'; appendEvent(session, 'coaching.ready', { reportId: session.reports.at(-1)!.id, jobId: job.id }, job.requestId, now, 'model');
      }
      if (result.inference) job.inference = structuredClone(result.inference);
      this.settle(db, session, job, now, result.actualUsd ?? (result.kind === 'run' ? 0 : undefined));
      job.state = 'completed'; job.updatedAt = now; job.leaseExpiresAt = null; return true;
    });
  }
  async failJob(claim: JobClaim, error: string, actualUsd?: number, inference?: InferenceRecord) {
    return this.store.transaction(db => {
      const now = this.at(), found = this.locateClaim(db, claim, now); if (!found) return false;
      const { session, job } = found;
      // Caller supplies a safe category/message, never a provider body or secret.
      job.safeError = boundedText(error, 'Safe failure description', 500); job.state = 'failed'; job.updatedAt = now; job.leaseExpiresAt = null;
      if (inference) job.inference = structuredClone(inference);
      this.settle(db, session, job, now, actualUsd);
      appendEvent(session, 'operation.failed', { jobId: job.id, kind: job.kind, error: job.safeError }, job.requestId, now);
      return true;
    });
  }
  async cancelJob(ownerId: string, jobId: string, input: { requestId: string }, supportGuard?: TrustedSupportGuard) {
    return this.mutate(ownerId, input.requestId, 'cancel-job', { jobId }, undefined, (db, now) => {
      supportGuard?.(db, now);
      const session = Object.values(db.sessions).find(s => s.ownerId === ownerId && s.jobs.some(j => j.id === jobId));
      const job = session?.jobs.find(j => j.id === jobId);
      if (!session || !job) throw new DomainError('not_found', 'Job not found.');
      if (['queued', 'running'].includes(job.state)) {
        this.settle(db, session, job, now, undefined, job.state === 'queued'); job.cancellationRequested = true; job.state = 'cancelled'; job.fencingToken += 1; job.leaseExpiresAt = null; job.updatedAt = now;
        appendEvent(session, 'job.cancelled', { jobId }, input.requestId, now, 'learner');
      }
      return publicJob(job);
    });
  }
  async retryReport(ownerId: string, id: string, input: { requestId: string }, supportGuard?: TrustedSupportGuard): Promise<SessionMutationResult> {
    return this.mutate(ownerId, input.requestId, 'retry-report', {}, id, (db, now) => {
      supportGuard?.(db, now);
      const session = ownedSession(db.sessions, ownerId, id);
      if (!session.frozenEvidence) throw new DomainError('conflict', 'Final submit must freeze the evidence before requesting a report.');
      if (session.reports.length) return { session: sessionView(session) };
      const job = session.jobs.find(j => j.kind === 'coach');
      if (!job) throw new DomainError('not_found', 'Coaching operation not found.');
      if (['queued', 'running'].includes(job.state)) return { session: sessionView(session), job: publicJob(job) };
      if (job.attempt >= 3 || session.usage.aiCalls >= this.limits.maxAiCalls) throw new DomainError('quota', 'Coaching retry limit reached. The frozen attempt is still available.');
      this.reserve(db, session, job, job.reservedUsd, now); session.usage.aiCalls += 1;
      job.state = 'queued'; job.cancellationRequested = false; job.claimToken = null; job.workerId = null; job.leaseExpiresAt = null; job.safeError = undefined; job.updatedAt = now;
      appendEvent(session, 'stage.changed', { stageId: 'debrief', coachingRetry: true }, input.requestId, now);
      return { session: sessionView(session), job: publicJob(job) };
    });
  }
  private removeSession(db: PracticeDatabase, ownerId: string, id: string, now: string) {
    ownedSession(db.sessions, ownerId, id);
    // The filesystem adapter embeds artifacts in one store. Its atomic rewrite erases them; inventory is empty.
    db.deletions.push({ id: randomUUID(), ownerId, sessionId: id, createdAt: now, state: 'completed', objectKeys: [], completedAt: now });
    delete db.sessions[id];
    if (db.reviews) {
      for (const field of ['cases','drafts','decisions','publications'] as const) for (const [key, record] of Object.entries(db.reviews[field])) if (record.sessionId === id && record.ownerId === ownerId) delete db.reviews[field][key];
      db.reviews.audits = db.reviews.audits.filter(record => record.sessionId !== id || record.ownerId !== ownerId);
    }
    for (const [key, request] of Object.entries(db.requests)) {
      const result = request.result as { session?: { id?: string }; sessionId?: string } | null;
      if (request.ownerId === ownerId && (request.sessionId === id || result?.session?.id === id || result?.sessionId === id)) delete db.requests[key];
    }
    // Content-free usage postings stay until the quota window ends; deleting practice content must not reset spend caps.
  }
  async deleteSession(ownerId: string, id: string, input: { requestId: string }) {
    return this.mutate(ownerId, input.requestId, 'delete-session', { id }, undefined, (db, now) => { this.removeSession(db, ownerId, id, now); return { deleted: true as const }; });
  }
  async deleteAccount(ownerId: string, input: { requestId: string }) {
    return this.mutate(ownerId, input.requestId, 'delete-account', {}, undefined, (db, now) => {
      for (const session of Object.values(db.sessions).filter(s => s.ownerId === ownerId)) this.removeSession(db, ownerId, session.id, now);
      for (const [key, request] of Object.entries(db.requests)) if (request.ownerId === ownerId) delete db.requests[key];
      // This operation erases Lab content, while preserving the shared account.
      // Content-free quota postings must survive so deletion cannot reset provider-spend caps.
      return { deleted: true as const };
    });
  }
}
