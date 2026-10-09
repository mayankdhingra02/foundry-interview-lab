import 'server-only';
import { randomUUID } from 'node:crypto';
import { appendEvent, assertRequestId, boundedText, digest, DomainError, ownedSession, requestKey } from '../interview-practice/domain';
import { validateReport } from '../interview-practice/evidence';
import type { CoachOutput, CorrectionDraft, PracticeDatabase, ReviewCase, ReviewDatabase, Scenario, Session } from '../interview-practice/types';
import type { Actor } from './auth';
import { HttpError } from './http';
import { SessionService, sessionView, type TrustedSupportGuard } from './session-service';
import type { PracticeStore } from './store';
import { admissionLimits, admissionLimitsFromEnvironment, assertMutationAdmission, assertMutationGrowth, captureMutationGrowth, mutationAdmissionMetadata, type AdmissionLimits, type MutationLane } from '../interview-practice/admission';
import { assertRequestNotErased } from './deleted-requests';

export type ReviewActor = Pick<Actor, 'id' | 'local'>;
export type CreateReviewInput = { requestId: string; category: 'feedback' | 'technical'; reportId?: string; message: string; criterionIds?: string[]; inspectionConsent: boolean; supportActionsConsent: boolean };
export type ReviewConsentInput = { requestId: string; expectedRevision: number; inspectionConsent: boolean; supportActionsConsent: boolean };
export type ReviewOptions = { adminUserIds?: string[]; now?: () => Date; allowLocalAdmins?: boolean; practice?: SessionService; admissionLimits?: Partial<AdmissionLimits> };
export const emptyReviewDatabase = (): ReviewDatabase => ({ cases: {}, drafts: {}, decisions: {}, publications: {}, audits: [] });
export function reviewAdminAllowed(actor: ReviewActor, ids = (process.env.ADMIN_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean), allowLocal = process.env.NODE_ENV !== 'production') { return ids.includes(actor.id) && (!actor.local || allowLocal); }
const data = (db: PracticeDatabase) => db.reviews ??= emptyReviewDatabase();
const ownerView = (item: ReviewCase) => { const { ownerId: _owner, ...view } = structuredClone(item); void _owner; return view; };
const activeConsent = (item: ReviewCase, now: string, actions = false) => Boolean((actions ? item.supportActionsConsent : item.inspectionConsent) && item.consentExpiresAt && item.consentExpiresAt > now);
const summary = (item: ReviewCase, now: string) => ({ id: item.id, sessionId: item.sessionId, reportId: item.reportId, category: item.category, status: item.status, revision: item.revision, inspectionConsent: activeConsent(item, now), supportActionsConsent: activeConsent(item, now, true), consentExpiresAt: item.consentExpiresAt, createdAt: item.createdAt, updatedAt: item.updatedAt });

export class ReviewService {
  private readonly now: () => Date;
  private readonly adminIds: string[];
  private readonly allowLocal: boolean;
  private readonly limits: AdmissionLimits;
  constructor(readonly store: PracticeStore, private readonly resolveScenario: (id: string, version?: string) => Scenario | null, private readonly options: ReviewOptions = {}) {
    this.now = options.now ?? (() => new Date()); this.adminIds = options.adminUserIds ?? (process.env.ADMIN_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean); this.allowLocal = process.env.NODE_ENV !== 'production' && (options.allowLocalAdmins ?? true);
    this.limits = admissionLimits(options.admissionLimits ?? admissionLimitsFromEnvironment(process.env));
  }
  allowed(actor: ReviewActor) { return reviewAdminAllowed(actor, this.adminIds, this.allowLocal); }
  private admin(actor: ReviewActor) { if (!this.allowed(actor)) throw new HttpError(403, 'staff_access_denied', 'This Foundry account does not have internal review access.'); }
  private at() { return this.now().toISOString(); }
  private reviewCase(db: PracticeDatabase, id: string) {
    const item = data(db).cases[id];
    if (!item || !db.sessions[item.sessionId] || db.sessions[item.sessionId].ownerId !== item.ownerId) throw new DomainError('not_found', 'Support reference not found.');
    return item;
  }
  private consent(item: ReviewCase, now: string, actions = false) { if (!activeConsent(item, now, actions)) throw new HttpError(403, 'support_consent_required', actions ? 'Current learner permission for support actions is required.' : 'Current learner permission to inspect attempt contents is required.'); }
  private audit(db: PracticeDatabase, actorId: string, action: string, purpose: string, now: string, item?: ReviewCase, targetId?: string) {
    const audit = { id: randomUUID(), actorId, action, purpose, createdAt: now, ...(item ? { ownerId: item.ownerId, sessionId: item.sessionId, caseId: item.id } : {}), ...(targetId ? { targetId } : {}) };
    data(db).audits.push(audit); return audit.id;
  }
  private once(db: PracticeDatabase, ownerId: string, actorId: string, requestId: string, operation: string, payload: unknown, sessionId: string | undefined, apply: () => string, learnerLane?: MutationLane) {
    assertRequestId(requestId);
    const id = `review_${digest({ actorId, requestId })}`, key = requestKey(ownerId, id), fingerprint = digest({ operation, payload, sessionId: sessionId ?? null });
    const existing = db.requests[key];
    if (existing) { if (existing.fingerprint !== fingerprint) throw new DomainError('conflict', 'This review request key was used for different input.'); return String(existing.result); }
    assertRequestNotErased(db, ownerId, id, fingerprint);
    if (learnerLane && sessionId) ownedSession(db.sessions, ownerId, sessionId);
    if (learnerLane) assertMutationAdmission(db, ownerId, operation, learnerLane, this.at(), this.limits);
    const before = learnerLane ? captureMutationGrowth(db, ownerId) : undefined;
    const reference = apply();
    if (learnerLane && before) assertMutationGrowth(db, ownerId, before, learnerLane, this.limits);
    // Cache only references, never private inspection output or unpublished draft contents.
    db.requests[key] = { ownerId, requestId: id, fingerprint, result: reference, createdAt: this.at(), ...(sessionId ? { sessionId } : {}), ...mutationAdmissionMetadata(learnerLane ?? 'staff') }; return reference;
  }
  async createCase(ownerId: string, sessionId: string, input: CreateReviewInput) {
    const message = boundedText(input.message, 'Support message', 4000);
    return this.store.transaction(db => {
      const session = ownedSession(db.sessions, ownerId, sessionId), now = this.at(), reviews = data(db);
      if (!['feedback','technical'].includes(input.category) || typeof input.inspectionConsent !== 'boolean' || typeof input.supportActionsConsent !== 'boolean') throw new DomainError('invalid', 'Select a support category and explicit permission choices.');
      const report = session.reports.find(report => report.id === input.reportId);
      if ((input.category === 'feedback' || input.reportId) && !report) throw new DomainError('not_found', 'Published report not found.');
      const criterionIds = input.criterionIds ?? [];
      if (!Array.isArray(criterionIds) || criterionIds.length > 20 || new Set(criterionIds).size !== criterionIds.length || criterionIds.some(id => !session.scenario.rubric.some(row => row.id === id))) throw new DomainError('invalid', 'Choose known report criteria.');
      const id = this.once(db, ownerId, ownerId, input.requestId, 'create-review', input, sessionId, () => {
        const existing = Object.values(reviews.cases).find(item => item.ownerId === ownerId && item.sessionId === sessionId && item.category === input.category && item.reportId === (input.reportId ?? null) && item.status !== 'resolved');
        if (existing) throw new DomainError('conflict', `An open support reference already exists: ${existing.id}.`);
        if (Object.values(reviews.cases).filter(item => item.ownerId === ownerId && item.createdAt.slice(0, 10) === now.slice(0, 10)).length >= 10) throw new DomainError('quota', 'Daily support request limit reached.');
        const id = randomUUID(); reviews.cases[id] = { id, ownerId, sessionId, reportId: input.reportId ?? null, category: input.category, message, criterionIds, status: 'open', revision: 1, inspectionConsent: input.inspectionConsent, supportActionsConsent: input.supportActionsConsent, consentVersion: 'support-inspection-v1', consentExpiresAt: input.inspectionConsent || input.supportActionsConsent ? new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString() : null, createdAt: now, updatedAt: now };
        this.audit(db, ownerId, 'case.created', 'Learner requested support; no research permission granted.', now, reviews.cases[id]); return id;
      }, 'ordinary');
      return ownerView(reviews.cases[id]);
    });
  }
  async listOwnerCases(ownerId: string, sessionId?: string) {
    const db = await this.store.read(); if (sessionId) ownedSession(db.sessions, ownerId, sessionId);
    return Object.values(db.reviews?.cases ?? {}).filter(item => item.ownerId === ownerId && (!sessionId || item.sessionId === sessionId)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(ownerView);
  }
  async setConsent(ownerId: string, caseId: string, input: ReviewConsentInput) {
    return this.store.transaction(db => {
      const item = this.reviewCase(db, caseId), now = this.at(); if (item.ownerId !== ownerId) throw new DomainError('not_found', 'Support reference not found.');
      if (typeof input.inspectionConsent !== 'boolean' || typeof input.supportActionsConsent !== 'boolean') throw new DomainError('invalid', 'Choose explicit permission settings.');
      const onlyRevokes = !(!item.inspectionConsent && input.inspectionConsent) && !(!item.supportActionsConsent && input.supportActionsConsent)
        && (item.inspectionConsent && !input.inspectionConsent || item.supportActionsConsent && !input.supportActionsConsent);
      this.once(db, ownerId, ownerId, input.requestId, 'review-consent', input, item.sessionId, () => {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== item.revision) throw new DomainError('conflict', 'Support permissions changed. Refresh before updating them.');
        item.inspectionConsent = input.inspectionConsent; item.supportActionsConsent = input.supportActionsConsent; item.consentExpiresAt = input.inspectionConsent || input.supportActionsConsent ? new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString() : null; item.revision++; item.updatedAt = now;
        this.audit(db, ownerId, 'consent.changed', 'Learner updated support-only permission.', now, item); return item.id;
      }, onlyRevokes ? 'recovery' : 'ordinary'); return ownerView(item);
    });
  }
  async listCases(actor: ReviewActor) {
    this.admin(actor);
    return this.store.transaction(db => { const now = this.at(); this.audit(db, actor.id, 'support.queue-read', 'View content-free support queue.', now); return Object.values(data(db).cases).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(item => summary(item, now)); });
  }
  private operational(session: Session) {
    return { id: session.id, lifecycle: session.lifecycle, stageId: session.stageId, revision: session.revision, scenarioId: session.scenarioId, scenarioVersion: session.scenarioVersion, acknowledgedSnapshotAt: session.snapshots.at(-1)?.createdAt ?? null, updatedAt: session.updatedAt, usage: session.usage, reports: session.reports.map(report => ({ id: report.id, generationId: report.generationId, createdAt: report.createdAt, corrected: Boolean(report.correction) })), jobs: session.jobs.map(job => ({ id: job.id, kind: job.kind, state: job.state, attempt: job.attempt, updatedAt: job.updatedAt, failureCategory: job.state === 'failed' ? `${job.kind}_failed` : job.state === 'cancelled' ? 'cancelled' : null })), refundableEntitlement: 'requires-separate-reviewed-policy' };
  }
  async status(actor: ReviewActor, caseId: string) {
    this.admin(actor);
    return this.store.transaction(db => {
      const item = this.reviewCase(db, caseId), now = this.at(), reviews = data(db); this.audit(db, actor.id, 'support.status-read', 'View content-free operational status.', now, item);
      const drafts = Object.values(reviews.drafts).filter(draft => draft.caseId === caseId).map(draft => ({ id: draft.id, sourceReportId: draft.sourceReportId, createdAt: draft.createdAt, authoredByYou: draft.createdBy === actor.id, decision: Object.values(reviews.decisions).find(decision => decision.draftId === draft.id)?.decision ?? null, published: Object.values(reviews.publications).some(publication => publication.draftId === draft.id) }));
      return { case: summary(item, now), session: this.operational(db.sessions[item.sessionId]), drafts };
    });
  }
  async inspect(actor: ReviewActor, caseId: string, input: { requestId: string; purpose: string }) {
    this.admin(actor); const purpose = boundedText(input.purpose, 'Inspection purpose', 300);
    return this.store.transaction(db => {
      const item = this.reviewCase(db, caseId), now = this.at(), reviews = data(db); this.consent(item, now);
      this.once(db, item.ownerId, actor.id, input.requestId, 'inspect-review', { caseId, purpose }, item.sessionId, () => this.audit(db, actor.id, 'content.inspected', purpose, now, item));
      return { case: ownerView(item), session: sessionView(db.sessions[item.sessionId]), snapshots: structuredClone(db.sessions[item.sessionId].snapshots), drafts: Object.values(reviews.drafts).filter(draft => draft.caseId === caseId).map(draft => ({ ...structuredClone(draft), authoredByYou: draft.createdBy === actor.id })), decisions: Object.values(reviews.decisions).filter(decision => decision.caseId === caseId), researchReuseAuthorized: false as const };
    });
  }
  async previewScenario(actor: ReviewActor, scenarioId: string, input: { requestId: string; purpose: string; version?: string }) {
    this.admin(actor); const purpose = boundedText(input.purpose, 'Author preview purpose', 300), scenario = this.resolveScenario(scenarioId, input.version);
    if (!scenario) throw new DomainError('not_found', 'Scenario package not found.');
    return this.store.transaction(db => {
      this.once(db, actor.id, actor.id, input.requestId, 'author-preview', { scenarioId, version: scenario.version, purpose }, undefined, () => this.audit(db, actor.id, 'scenario.previewed', purpose, this.at(), undefined, `${scenarioId}:${scenario.version}`));
      return { scenario: structuredClone(scenario), scenarioDigest: digest(scenario), privateMaterial: true as const, executionQualifiedByThisPreview: false as const };
    });
  }
  private source(db: PracticeDatabase, item: ReviewCase, sourceReportId: string) {
    const session = db.sessions[item.sessionId], source = session.reports.find(report => report.id === sourceReportId), scenario = this.resolveScenario(session.scenarioId, session.scenarioVersion);
    if (!source || !session.frozenEvidence || !session.codeFrozenSnapshotId || session.lifecycle !== 'completed') throw new DomainError('conflict', 'A published report and immutable final evidence are required.');
    if (!scenario || digest(scenario) !== session.scenarioDigest || source.evidenceDigest !== session.frozenEvidence.digest || source.rubricVersion !== scenario.version) throw new DomainError('conflict', 'Original scenario, rubric and evidence versions must match.');
    return { session, source, scenario };
  }
  async createDraft(actor: ReviewActor, caseId: string, input: { requestId: string; sourceReportId: string; reason: string; report: CoachOutput }) {
    this.admin(actor); const reason = boundedText(input.reason, 'Visible correction reason', 1000);
    return this.store.transaction(db => {
      const item = this.reviewCase(db, caseId), now = this.at(), reviews = data(db); this.consent(item, now);
      const id = this.once(db, item.ownerId, actor.id, input.requestId, 'correction-draft', input, item.sessionId, () => {
        if (item.status === 'resolved' || (item.reportId && item.reportId !== input.sourceReportId)) throw new DomainError('conflict', 'Open a review of the report being corrected.');
        const { session, scenario } = this.source(db, item, input.sourceReportId);
        if (session.reports.at(-1)?.id !== input.sourceReportId) throw new DomainError('conflict', 'A newer published report exists. Review its generation first.');
        const report = validateReport(input.report, scenario, session.frozenEvidence!);
        const draft: CorrectionDraft = { id: randomUUID(), ownerId: item.ownerId, sessionId: item.sessionId, caseId, sourceReportId: input.sourceReportId, reportId: randomUUID(), generationId: randomUUID(), evidenceDigest: session.frozenEvidence!.digest, evidenceWatermark: session.frozenEvidence!.watermark, reason, report, createdBy: actor.id, createdAt: now };
        reviews.drafts[draft.id] = draft; item.status = 'triaged'; item.revision++; item.updatedAt = now; this.audit(db, actor.id, 'correction.drafted', 'Draft a separately reviewed correction from the same frozen evidence.', now, item, draft.id); return draft.id;
      }); return structuredClone(reviews.drafts[id]);
    });
  }
  async reviewDraft(actor: ReviewActor, draftId: string, input: { requestId: string; decision: 'approve' | 'reject'; note: string }) {
    this.admin(actor); const note = boundedText(input.note, 'Staff evidence review note', 2000);
    return this.store.transaction(db => {
      const reviews = data(db), draft = reviews.drafts[draftId]; if (!draft) throw new DomainError('not_found', 'Correction draft not found.');
      const item = this.reviewCase(db, draft.caseId), now = this.at(); this.consent(item, now);
      const id = this.once(db, item.ownerId, actor.id, input.requestId, 'correction-review', { draftId, ...input }, item.sessionId, () => {
        if (actor.id === draft.createdBy) throw new HttpError(403, 'independent_review_required', 'A different allowed staff member must review this draft.');
        if (item.status === 'resolved' || !['approve','reject'].includes(input.decision) || Object.values(reviews.decisions).some(decision => decision.draftId === draftId)) throw new DomainError('conflict', 'This draft cannot receive another review decision.');
        const { session, scenario } = this.source(db, item, draft.sourceReportId);
        if (draft.evidenceDigest !== session.frozenEvidence!.digest || draft.evidenceWatermark !== session.frozenEvidence!.watermark) throw new DomainError('conflict', 'Frozen evidence changed.');
        validateReport(draft.report, scenario, session.frozenEvidence!);
        const id = randomUUID(); reviews.decisions[id] = { id, ownerId: item.ownerId, sessionId: item.sessionId, caseId: item.id, draftId, reviewerId: actor.id, decision: input.decision, note, createdAt: now };
        this.audit(db, actor.id, input.decision === 'approve' ? 'correction.approved' : 'correction.rejected', 'Staff reviewed evidence and wording; schema checks alone do not prove substantive accuracy.', now, item, draftId); return id;
      }); return structuredClone(reviews.decisions[id]);
    });
  }
  async publishDraft(actor: ReviewActor, draftId: string, input: { requestId: string }) {
    this.admin(actor);
    return this.store.transaction(db => {
      const reviews = data(db), draft = reviews.drafts[draftId]; if (!draft) throw new DomainError('not_found', 'Correction draft not found.');
      const item = this.reviewCase(db, draft.caseId), now = this.at(); this.consent(item, now);
      const reportId = this.once(db, item.ownerId, actor.id, input.requestId, 'correction-publish', { draftId }, item.sessionId, () => {
        const decision = Object.values(reviews.decisions).find(decision => decision.draftId === draftId);
        if (!decision || decision.decision !== 'approve' || decision.reviewerId === draft.createdBy) throw new HttpError(403, 'review_approval_required', 'Independent staff approval is required before publishing.');
        if (Object.values(reviews.publications).some(publication => publication.draftId === draftId)) return draft.reportId;
        const { session, source, scenario } = this.source(db, item, draft.sourceReportId);
        if (item.status === 'resolved' || session.reports.at(-1)?.id !== source.id || draft.evidenceDigest !== session.frozenEvidence!.digest || draft.evidenceWatermark !== session.frozenEvidence!.watermark) throw new DomainError('conflict', 'A newer report or changed review state prevents publication.');
        const report = validateReport(draft.report, scenario, session.frozenEvidence!);
        session.reports.push({ ...report, id: draft.reportId, generationId: draft.generationId, createdAt: now, model: 'staff-reviewed', promptVersion: 'manual-correction-v1', rubricVersion: source.rubricVersion, evidenceDigest: draft.evidenceDigest, evidence: structuredClone(session.frozenEvidence!.items), correction: { sourceReportId: source.id, reason: draft.reason, publishedAt: now } });
        const id = randomUUID(); reviews.publications[id] = { id, ownerId: item.ownerId, sessionId: item.sessionId, caseId: item.id, draftId, reportId: draft.reportId, generationId: draft.generationId, publishedBy: actor.id, createdAt: now };
        appendEvent(session, 'coaching.corrected', { reportId: draft.reportId, sourceReportId: source.id, generationId: draft.generationId, reason: draft.reason }, input.requestId, now);
        item.status = 'resolved'; item.resolution = draft.reason; item.revision++; item.updatedAt = now; this.audit(db, actor.id, 'correction.published', 'Publish a new approved generation; preserve the original report.', now, item, draftId); return draft.reportId;
      }); return { case: ownerView(item), report: structuredClone(db.sessions[item.sessionId].reports.find(report => report.id === reportId)!) };
    });
  }
  async resolve(actor: ReviewActor, caseId: string, input: { requestId: string; resolution: string }) {
    this.admin(actor); const resolution = boundedText(input.resolution, 'Learner-visible resolution', 1500);
    return this.store.transaction(db => {
      const item = this.reviewCase(db, caseId), now = this.at(); this.consent(item, now);
      this.once(db, item.ownerId, actor.id, input.requestId, 'case-resolve', input, item.sessionId, () => { if (item.status === 'resolved') throw new DomainError('conflict', 'The support reference is already resolved.'); item.status = 'resolved'; item.resolution = resolution; item.revision++; item.updatedAt = now; this.audit(db, actor.id, 'case.resolved', 'Record a learner-visible support resolution without changing their evidence.', now, item); return item.id; }); return ownerView(item);
    });
  }
  async recover(actor: ReviewActor, caseId: string, input: { requestId: string; action: 'retry-report' | 'cancel-job'; jobId?: string }) {
    this.admin(actor); assertRequestId(input.requestId);
    if (!this.options.practice || this.options.practice.store !== this.store) throw new DomainError('unavailable', 'Support recovery requires the configured practice service.');
    const initial = this.reviewCase(await this.store.read(), caseId); this.consent(initial, this.at(), true);
    const guard: TrustedSupportGuard = (db, now) => {
      this.admin(actor); const item = this.reviewCase(db, caseId); this.consent(item, now, true);
      if (item.status === 'resolved') throw new DomainError('conflict', 'This support reference is resolved.');
      const session = db.sessions[item.sessionId], job = input.action === 'retry-report' ? session.jobs.find(job => job.kind === 'coach') : session.jobs.find(job => job.id === input.jobId);
      if (!job || (input.action === 'retry-report' ? !['failed','cancelled'].includes(job.state) || Boolean(session.reports.length) : !['queued','running'].includes(job.state))) throw new DomainError('conflict', 'Only a failed report retry or pending job cancellation is allowed.');
      this.audit(db, actor.id, `support.${input.action}`, 'Learner allowed bounded recovery; original job limits and frozen input remain authoritative.', now, item, job.id); item.status = 'triaged'; item.revision++; item.updatedAt = now;
    };
    const requestId = `support_${digest({ actorId: actor.id, caseId, requestId: input.requestId })}`;
    if (input.action === 'retry-report') { const result = await this.options.practice.retryReport(initial.ownerId, initial.sessionId, { requestId }, guard); return { caseId, operation: input.action, job: result.job ? { id: result.job.id, kind: result.job.kind, state: result.job.state, attempt: result.job.attempt } : null }; }
    if (input.action !== 'cancel-job' || !input.jobId) throw new DomainError('invalid', 'Choose an allowed support action and job.');
    const job = await this.options.practice.cancelJob(initial.ownerId, input.jobId, { requestId }, guard); return { caseId, operation: input.action, job: { id: job.id, kind: job.kind, state: job.state, attempt: job.attempt } };
  }
  async deletionStatus(actor: ReviewActor) {
    this.admin(actor);
    return this.store.transaction(db => { this.audit(db, actor.id, 'support.deletion-status-read', 'View content-free deletion operation status.', this.at()); return db.deletions.slice(-100).reverse().map(item => ({ supportReference: item.id, sessionId: item.sessionId, state: item.state, createdAt: item.createdAt, completedAt: item.completedAt ?? null, pendingObjects: item.objectKeys.length })); });
  }
  async exportOwner(ownerId: string, sessionId?: string) {
    const db = await this.store.read(), reviews = db.reviews ?? emptyReviewDatabase();
    if (sessionId) ownedSession(db.sessions, ownerId, sessionId);
    const owned = (item: { ownerId?: string; sessionId?: string }) => item.ownerId === ownerId && (!sessionId || item.sessionId === sessionId);
    return { cases: Object.values(reviews.cases).filter(owned).map(ownerView), drafts: Object.values(reviews.drafts).filter(owned).map(item => { const { ownerId: _owner, createdBy: _staff, ...view } = item; void _owner; void _staff; return { ...view, status: 'unpublished-unless-listed-in-publications' }; }), decisions: Object.values(reviews.decisions).filter(owned).map(item => { const { ownerId: _owner, reviewerId: _staff, ...view } = item; void _owner; void _staff; return view; }), publications: Object.values(reviews.publications).filter(owned).map(item => { const { ownerId: _owner, publishedBy: _staff, ...view } = item; void _owner; void _staff; return view; }), audit: reviews.audits.filter(owned).map(item => ({ id: item.id, action: item.action, createdAt: item.createdAt, caseId: item.caseId, sessionId: item.sessionId })) };
  }
}

export async function getReviewService() {
  const [{ getService }, { getScenario }] = await Promise.all([import('./application'), import('../content/scenarios')]);
  const practice = await getService(); return new ReviewService(practice.store, getScenario, { practice });
}
