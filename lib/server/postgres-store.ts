import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, digest, DomainError, requestKey } from '../interview-practice/domain';
import type { EvidenceManifest, PracticeDatabase, ReviewDatabase, Session } from '../interview-practice/types';
import { emptyDatabase, validateStoredEvents, type PracticeStore } from './store';

type EntityRow = { key: string; columns: Record<string, unknown>; value: unknown };
type TableSpec = { table: string; keys: string[]; rows: EntityRow[] };
type RawRow = Record<string, unknown> & { runtime_payload: Record<string, unknown> };
export type PostgresStoreOptions = { advisoryLockKey?: number; statementTimeoutMs?: number; lockTimeoutMs?: number; maxStateBytes?: number; maxEntityRows?: number };
const tables = ['ai_practice_sessions', 'ai_practice_snapshots', 'ai_practice_events', 'ai_practice_jobs', 'ai_practice_reports', 'ai_practice_requests', 'ai_practice_usage_ledger', 'ai_practice_deletions', 'ai_practice_turns', 'ai_practice_runs', 'ai_practice_assistant_messages', 'ai_practice_edit_proposals', 'ai_practice_evidence_manifests'] as const;
const reviewTables = ['ai_practice_review_cases','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits'] as const;
const json = (value: unknown) => JSON.stringify(value);
const persistedCanonical = (value: unknown) => canonical(JSON.parse(json(value)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new DomainError('unavailable', 'PostgreSQL practice storage is unavailable. Retry the same request key; private data was not logged.');
function rows(table: string, values: EntityRow[], keys = ['id']): TableSpec { return { table, keys, rows: values }; }
function entity(key: string, value: unknown, columns: Record<string, unknown>): EntityRow { return { key, value, columns: { ...columns, runtime_payload: json(value) } }; }
function reviewSpecifications(database: PracticeDatabase): TableSpec[] {
  const review = database.reviews ?? { cases: {}, drafts: {}, decisions: {}, publications: {}, audits: [] };
  const ownerColumns = (record: { ownerId: string; sessionId: string; caseId?: string }) => ({ user_id: record.ownerId, session_id: record.sessionId, ...(record.caseId ? { case_id: record.caseId } : {}) });
  return [
    rows('ai_practice_review_cases', Object.values(review.cases).map(record => entity(record.id, record, { id: record.id, ...ownerColumns(record), report_id: record.reportId, category: record.category, status: record.status, revision: record.revision, inspection_consent: record.inspectionConsent, support_actions_consent: record.supportActionsConsent, consent_expires_at: record.consentExpiresAt, created_at: record.createdAt, updated_at: record.updatedAt }))),
    rows('ai_practice_correction_drafts', Object.values(review.drafts).map(record => entity(record.id, record, { id: record.id, ...ownerColumns(record), source_report_id: record.sourceReportId, report_id: record.reportId, generation_id: record.generationId, evidence_digest: record.evidenceDigest, evidence_watermark: record.evidenceWatermark, created_by: record.createdBy, created_at: record.createdAt }))),
    rows('ai_practice_correction_decisions', Object.values(review.decisions).map(record => entity(record.id, record, { id: record.id, ...ownerColumns(record), draft_id: record.draftId, reviewer_id: record.reviewerId, decision: record.decision, created_at: record.createdAt }))),
    rows('ai_practice_correction_publications', Object.values(review.publications).map(record => entity(record.id, record, { id: record.id, ...ownerColumns(record), draft_id: record.draftId, report_id: record.reportId, generation_id: record.generationId, published_by: record.publishedBy, created_at: record.createdAt }))),
    rows('ai_practice_review_audits', review.audits.map(record => entity(record.id, record, { id: record.id, user_id: record.ownerId ?? null, session_id: record.sessionId ?? null, case_id: record.caseId ?? null, actor_id: record.actorId, action: record.action, created_at: record.createdAt }))),
  ];
}
function sessionMetadata(session: Session) {
  const { files: _files, snapshots: _snapshots, events: _events, jobs: _jobs, reports: _reports, turns: _turns, runs: _runs, assistantMessages: _messages, editProposals: _edits, frozenEvidence: _manifest, ...metadata } = session;
  void _files; void _snapshots; void _events; void _jobs; void _reports; void _turns; void _runs; void _messages; void _edits; void _manifest;
  return metadata;
}
function specifications(database: PracticeDatabase): TableSpec[] {
  const sessions = Object.values(database.sessions);
  const ownerColumns = (session: Session) => ({ session_id: session.id, user_id: session.ownerId });
  return [
    rows('ai_practice_sessions', sessions.map(s => entity(s.id, sessionMetadata(s), {
      id: s.id, user_id: s.ownerId, scenario_id: s.scenarioId, scenario_version: s.scenarioVersion, scenario_sha256: s.scenarioDigest,
      mode: s.mode, lifecycle: s.lifecycle, stage_id: s.stageId, configuration: json(s.configuration), prompt_exposure: s.promptExposure,
      revision: s.revision, code_frozen_snapshot_id: s.codeFrozenSnapshotId, final_evidence_digest: s.frozenEvidence?.digest ?? null,
      final_event_watermark: s.frozenEvidence?.watermark ?? null, consent_version: 'practice-v1', created_at: s.createdAt, updated_at: s.updatedAt,
    }))),
    rows('ai_practice_snapshots', sessions.flatMap(s => s.snapshots.map(snapshot => entity(snapshot.id, snapshot, {
      id: snapshot.id, ...ownerColumns(s), sequence: snapshot.sequence, files: json(snapshot.files), storage_key: null,
      content_sha256: snapshot.sha256, byte_count: Object.values(snapshot.files).reduce((sum, text) => sum + Buffer.byteLength(text), 0), created_at: snapshot.createdAt,
    })))),
    rows('ai_practice_events', sessions.flatMap(s => s.events.map(event => entity(event.id, event, {
      id: event.id, ...ownerColumns(s), sequence: event.sequence, schema_version: event.schemaVersion, event_type: event.type,
      source: event.source, request_id: event.requestId, payload: json(event.payload), occurred_at: event.occurredAt, recorded_at: event.recordedAt,
    })))),
    rows('ai_practice_jobs', sessions.flatMap(s => s.jobs.map((job, i) => entity(job.id, job, {
      id: job.id, ...ownerColumns(s), kind: job.kind, state: job.state, request_id: job.requestId, input_snapshot_id: job.snapshotId,
      input_fingerprint: job.fingerprint, input: json(job.input), attempt: job.attempt, reservation_sequence: job.reservationSequence,
      fencing_token: job.fencingToken, claim_token: job.claimToken, worker_id: job.workerId, lease_expires_at: job.leaseExpiresAt,
      cancellation_requested: job.cancellationRequested, safe_error: job.safeError ?? null, reserved_usd: job.reservedUsd,
      actual_usd: job.actualUsd ?? null, created_at: job.createdAt, updated_at: job.updatedAt, runtime_sequence: i + 1,
    })))),
    rows('ai_practice_reports', sessions.flatMap(s => s.reports.map((report, i) => entity(report.id, report, {
      id: report.id, ...ownerColumns(s), generation_id: report.generationId, frozen_snapshot_id: s.codeFrozenSnapshotId,
      evidence_digest: report.evidenceDigest, evidence_manifest: json(s.frozenEvidence), rubric_version: report.rubricVersion,
      prompt_version: report.promptVersion, model: report.model, report: json({ overview: report.overview, rubric: report.rubric, nextPractice: report.nextPractice }), created_at: report.createdAt, runtime_sequence: i + 1,
    })))),
    rows('ai_practice_turns', sessions.flatMap(s => s.turns.map((turn, i) => entity(turn.id, turn, { id: turn.id, ...ownerColumns(s), role: turn.role, sequence: i + 1 })))),
    rows('ai_practice_runs', sessions.flatMap(s => s.runs.map((run, i) => entity(run.id, run, { id: run.id, ...ownerColumns(s), job_id: run.jobId, snapshot_id: run.snapshotId, sequence: i + 1 })))),
    rows('ai_practice_assistant_messages', sessions.flatMap(s => s.assistantMessages.map((message, i) => entity(message.id, message, { id: message.id, ...ownerColumns(s), role: message.role, sequence: i + 1 })))),
    rows('ai_practice_edit_proposals', sessions.flatMap(s => s.editProposals.map((proposal, i) => entity(proposal.id, proposal, { id: proposal.id, ...ownerColumns(s), job_id: proposal.jobId, snapshot_id: proposal.baseSnapshotId, status: proposal.status, sequence: i + 1 })))),
    rows('ai_practice_evidence_manifests', sessions.filter(s => s.frozenEvidence).map(s => entity(s.id, s.frozenEvidence, { ...ownerColumns(s), digest: s.frozenEvidence!.digest, event_watermark: s.frozenEvidence!.watermark })), ['session_id']),
    rows('ai_practice_requests', Object.values(database.requests).map(record => {
      const result = record.result as { session?: { id?: string }; sessionId?: string } | null;
      const sessionId = record.sessionId ?? result?.session?.id ?? result?.sessionId ?? null;
      return entity(requestKey(record.ownerId, record.requestId), record, { user_id: record.ownerId, request_id: record.requestId, session_id: sessionId && database.sessions[sessionId] ? sessionId : null, operation: 'practice-runtime', fingerprint: record.fingerprint, result: json(record.result), created_at: record.createdAt, expires_at: new Date(new Date(record.createdAt).getTime() + 30 * 86_400_000).toISOString() });
    }), ['user_id', 'request_id']),
    rows('ai_practice_usage_ledger', database.ledger.map(record => entity(record.id, record, {
      id: record.id, user_id: record.ownerId, opaque_session_id: record.sessionId, operation_id: record.operationId,
      kind: record.kind, amount_usd: record.amountUsd, created_at: record.createdAt,
      expires_at: new Date(new Date(record.createdAt).getTime() + 62 * 86_400_000).toISOString(),
    }))),
    rows('ai_practice_deletions', database.deletions.map(record => entity(record.id, record, {
      id: record.id, opaque_owner_id: record.ownerId, opaque_session_id: record.sessionId, inventory: json(record.objectKeys),
      state: record.state, attempt: 0, created_at: record.createdAt, completed_at: record.completedAt ?? null,
      expires_at: new Date(new Date(record.createdAt).getTime() + 30 * 86_400_000).toISOString(),
    }))),
    ...reviewSpecifications(database),
  ];
}

/** Trusted-server adapter. Every entity is a distinct SQL row; there is no serialized whole-database row. */
export class PostgresPracticeStore implements PracticeStore {
  private readonly transactionContext = new AsyncLocalStorage<PoolClient>();
  private readonly options: Required<PostgresStoreOptions>;
  readonly pool: Pool;
  private readonly ownsPool: boolean;
  constructor(pool: Pool | string, options: PostgresStoreOptions = {}) {
    this.ownsPool = typeof pool === 'string';
    this.pool = typeof pool === 'string' ? new Pool({ connectionString: pool, max: 5, connectionTimeoutMillis: 5000 }) : pool;
    this.options = { advisoryLockKey: 843_239_117, statementTimeoutMs: 15_000, lockTimeoutMs: 5_000, maxStateBytes: 64 * 1024 * 1024, maxEntityRows: 100_000, ...options };
    for (const value of Object.values(this.options)) if (!Number.isSafeInteger(value) || value <= 0) throw new DomainError('invalid', 'PostgreSQL store limits must be positive integers.');
  }
  private async setup(client: PoolClient) {
    await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $1, true)", [String(this.options.statementTimeoutMs), String(this.options.lockTimeoutMs)]);
  }
  private async load(client: PoolClient): Promise<PracticeDatabase> {
    const db = emptyDatabase(), records = new Map<string, RawRow[]>();
    let totalBytes = 0;
    // Additive rollout: baseline practice remains readable before the optional review migration.
    const reviewReady = Boolean((await client.query("select to_regclass('public.ai_practice_review_cases') as table_name")).rows[0].table_name);
    for (const table of [...tables, ...(reviewReady ? reviewTables : [])]) {
      const size = await client.query<{ bytes: string; count: string }>(`select coalesce(sum(octet_length(runtime_payload::text)),0)::text as bytes, count(*)::text as count from public.${table}`);
      totalBytes += Number(size.rows[0].bytes);
      if (totalBytes > this.options.maxStateBytes || Number(size.rows[0].count) > this.options.maxEntityRows) throw new DomainError('unavailable', 'The initial persistence adapter capacity was reached. Data was not truncated; qualify a scoped adapter before expanding capacity.');
      const result = await client.query<RawRow>(`select * from public.${table}`);
      for (const row of result.rows) if (!row.runtime_payload || typeof row.runtime_payload !== 'object' || Array.isArray(row.runtime_payload) || !Object.keys(row.runtime_payload).length) throw unavailable();
      records.set(table, result.rows);
    }
    for (const row of records.get('ai_practice_sessions')!) {
      const metadata = row.runtime_payload;
      if (metadata.id !== row.id || metadata.ownerId !== row.user_id || metadata.scenarioId !== row.scenario_id || metadata.scenarioVersion !== row.scenario_version || metadata.revision !== Number(row.revision) || metadata.lifecycle !== row.lifecycle) throw unavailable();
      db.sessions[String(row.id)] = { ...metadata, files: {}, snapshots: [], events: [], jobs: [], reports: [], turns: [], runs: [], assistantMessages: [], editProposals: [], frozenEvidence: null } as unknown as Session;
    }
    const children = [
      ['ai_practice_snapshots', 'snapshots'], ['ai_practice_events', 'events'], ['ai_practice_jobs', 'jobs'],
      ['ai_practice_reports', 'reports'], ['ai_practice_turns', 'turns'], ['ai_practice_runs', 'runs'],
      ['ai_practice_assistant_messages', 'assistantMessages'], ['ai_practice_edit_proposals', 'editProposals'],
    ] as const;
    for (const [table, field] of children) {
      const childRows = records.get(table)!;
      childRows.sort((a, b) => Number(a.sequence ?? a.runtime_sequence ?? 0) - Number(b.sequence ?? b.runtime_sequence ?? 0) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id)));
      for (const row of childRows) {
        const session = db.sessions[String(row.session_id)], payload = row.runtime_payload;
        if (!session || session.ownerId !== row.user_id || payload.id !== row.id) throw unavailable();
        if (field === 'jobs' && (payload.ownerId !== row.user_id || payload.sessionId !== row.session_id || payload.state !== row.state || payload.fencingToken !== Number(row.fencing_token) || payload.claimToken !== row.claim_token)) throw unavailable();
        if (field === 'events' && (payload.sessionId !== row.session_id || payload.sequence !== Number(row.sequence) || payload.type !== row.event_type || payload.source !== row.source || payload.requestId !== row.request_id || payload.schemaVersion !== Number(row.schema_version) || persistedCanonical(payload.payload) !== persistedCanonical(row.payload))) throw unavailable();
        if (field === 'snapshots' && (payload.sha256 !== row.content_sha256 || digest(payload.files) !== row.content_sha256)) throw unavailable();
        (session[field] as unknown[]).push(payload);
      }
    }
    for (const row of records.get('ai_practice_evidence_manifests')!) {
      const session = db.sessions[String(row.session_id)], manifest = row.runtime_payload as unknown as EvidenceManifest;
      if (!session || session.ownerId !== row.user_id || manifest.digest !== row.digest || digest(manifest.items) !== row.digest) throw unavailable();
      session.frozenEvidence = manifest;
    }
    for (const session of Object.values(db.sessions)) {
      const latest = session.snapshots.at(-1);
      if (!latest || (session.codeFrozenSnapshotId && !session.snapshots.some(s => s.id === session.codeFrozenSnapshotId))) throw unavailable();
      session.files = structuredClone(latest.files);
    }
    for (const row of records.get('ai_practice_requests')!) {
      const record = row.runtime_payload as unknown as PracticeDatabase['requests'][string];
      if (record.ownerId !== row.user_id || record.requestId !== row.request_id || record.fingerprint !== row.fingerprint) throw unavailable();
      db.requests[requestKey(record.ownerId, record.requestId)] = record;
    }
    for (const row of records.get('ai_practice_usage_ledger')!) {
      const record = row.runtime_payload as unknown as PracticeDatabase['ledger'][number];
      if (record.ownerId !== row.user_id || record.id !== row.id || record.operationId !== row.operation_id) throw unavailable();
      db.ledger.push(record);
    }
    for (const row of records.get('ai_practice_deletions')!) {
      const record = row.runtime_payload as unknown as PracticeDatabase['deletions'][number];
      if (record.id !== row.id || record.ownerId !== row.opaque_owner_id) throw unavailable(); db.deletions.push(record);
    }
    if (reviewReady) {
      const reviews: ReviewDatabase = { cases: {}, drafts: {}, decisions: {}, publications: {}, audits: [] }; db.reviews = reviews;
      const fields = ['cases','drafts','decisions','publications','audits'] as const;
      reviewTables.forEach((table, index) => {
        const field = fields[index];
        for (const row of records.get(table)!) {
          const value = row.runtime_payload;
          if (value.id !== row.id || (value.ownerId ?? null) !== row.user_id || (value.sessionId ?? null) !== row.session_id || (value.caseId ?? null) !== (row.case_id ?? null)) throw unavailable();
          if (row.session_id && (!db.sessions[String(row.session_id)] || db.sessions[String(row.session_id)].ownerId !== row.user_id)) throw unavailable();
          if (field === 'cases' && (value.status !== row.status || value.revision !== Number(row.revision) || value.reportId !== row.report_id || value.inspectionConsent !== row.inspection_consent || value.supportActionsConsent !== row.support_actions_consent)) throw unavailable();
          if (field === 'drafts' && (value.evidenceDigest !== row.evidence_digest || value.sourceReportId !== row.source_report_id || value.reportId !== row.report_id || value.generationId !== row.generation_id)) throw unavailable();
          if (field === 'audits') reviews.audits.push(value as unknown as ReviewDatabase['audits'][number]);
          else (reviews[field] as Record<string, unknown>)[String(row.id)] = value;
        }
      });
      reviews.audits.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }
    validateStoredEvents(db);
    return db;
  }
  private async upsert(client: PoolClient, spec: TableSpec, row: EntityRow) {
    const columns = Object.keys(row.columns), values = Object.values(row.columns);
    const updates = columns.filter(c => !spec.keys.includes(c)).map(c => `${c}=excluded.${c}`).join(',');
    await client.query(`insert into public.${spec.table} (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')}) on conflict (${spec.keys.join(',')}) do update set ${updates} where ${spec.table}.runtime_payload is distinct from excluded.runtime_payload`, values);
  }
  private async sync(client: PoolClient, next: TableSpec, previous: TableSpec) {
    const old = new Map(previous.rows.map(row => [row.key, row])), current = new Set(next.rows.map(row => row.key));
    for (const row of previous.rows) if (!current.has(row.key)) {
      await client.query(`delete from public.${next.table} where ${next.keys.map((key, i) => `${key}=$${i + 1}`).join(' and ')}`, next.keys.map(key => row.columns[key]));
    }
    for (const row of next.rows) if (!old.has(row.key) || persistedCanonical(old.get(row.key)!.value) !== persistedCanonical(row.value)) await this.upsert(client, next, row);
  }
  private validateImmutable(before: PracticeDatabase, after: PracticeDatabase) {
    for (const session of Object.values(after.sessions)) {
      if (!uuid.test(session.id) || !uuid.test(session.ownerId)) throw new DomainError('invalid', 'PostgreSQL sessions require verified UUID account identities.');
      const old = before.sessions[session.id]; if (!old) continue;
      if (old.ownerId !== session.ownerId || old.scenarioDigest !== session.scenarioDigest) throw new DomainError('conflict', 'Session ownership and scenario identity cannot change.');
      for (const field of ['snapshots', 'events', 'reports', 'turns', 'runs'] as const) {
        const entries = new Map(session[field].map(item => [item.id, item] as const));
        for (const previous of old[field]) if (!entries.has(previous.id) || canonical(entries.get(previous.id)) !== canonical(previous)) throw new DomainError('conflict', 'Acknowledged practice evidence cannot be rewritten.');
      }
      if (old.frozenEvidence && canonical(old.frozenEvidence) !== canonical(session.frozenEvidence)) throw new DomainError('conflict', 'Final evidence is immutable.');
    }
    for (const field of ['drafts','decisions','publications'] as const) for (const previous of Object.values(before.reviews?.[field] ?? {})) {
      if (!after.sessions[previous.sessionId]) continue;
      const current = after.reviews?.[field][previous.id];
      if (!current || persistedCanonical(current) !== persistedCanonical(previous)) throw new DomainError('conflict', 'Acknowledged staff review records are immutable.');
    }
    for (const previous of before.reviews?.audits ?? []) {
      if (previous.sessionId && !after.sessions[previous.sessionId]) continue;
      const current = after.reviews?.audits.find(item => item.id === previous.id);
      if (!current || persistedCanonical(current) !== persistedCanonical(previous)) throw new DomainError('conflict', 'Support audit records are immutable.');
    }
    for (const previous of Object.values(before.reviews?.cases ?? {})) {
      if (!after.sessions[previous.sessionId]) continue;
      const current = after.reviews?.cases[previous.id];
      if (!current || current.ownerId !== previous.ownerId || current.sessionId !== previous.sessionId || current.reportId !== previous.reportId) throw new DomainError('conflict', 'Support ownership and source identity cannot change.');
    }
  }
  private async persist(client: PoolClient, before: PracticeDatabase, after: PracticeDatabase) {
    if (after.schemaVersion !== 1 || Buffer.byteLength(json(after)) > this.options.maxStateBytes) throw new DomainError('unavailable', 'Initial persistence adapter capacity exceeded; changes were rolled back.');
    validateStoredEvents(after);
    this.validateImmutable(before, after);
    const previous = specifications(before), next = specifications(after);
    // Durable deletion metadata survives auth/session cascades and is committed atomically with removal.
    const deletion = next.find(s => s.table === 'ai_practice_deletions')!;
    await this.sync(client, deletion, previous.find(s => s.table === deletion.table)!);
    for (const old of Object.values(before.sessions)) if (!after.sessions[old.id]) await client.query('delete from public.ai_practice_sessions where id=$1 and user_id=$2', [old.id, old.ownerId]);
    for (const session of Object.values(after.sessions)) {
      const manifestHash = digest(session.scenario);
      await client.query('insert into public.practice_scenario_versions(scenario_id,version,manifest,manifest_sha256,published) values ($1,$2,$3,$4,true) on conflict (scenario_id,version) do nothing', [session.scenarioId, session.scenarioVersion, json(session.scenario), manifestHash]);
      const recorded = await client.query<{ manifest_sha256: string }>('select manifest_sha256 from public.practice_scenario_versions where scenario_id=$1 and version=$2', [session.scenarioId, session.scenarioVersion]);
      if (recorded.rows[0]?.manifest_sha256 !== manifestHash) throw new DomainError('conflict', 'Published scenario version is immutable.');
    }
    for (const spec of next) {
      if (spec.table === 'ai_practice_deletions') continue;
      // Session deletion already cascades private children. The generic diff may harmlessly delete absent rows.
      await this.sync(client, spec, previous.find(s => s.table === spec.table)!);
    }
  }
  async read(): Promise<PracticeDatabase> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect(); await client.query('begin isolation level repeatable read read only'); await this.setup(client);
      const result = await this.load(client); await client.query('commit'); return structuredClone(result);
    } catch (error) {
      await client?.query('rollback').catch(() => undefined);
      if (error instanceof DomainError) throw error; throw unavailable();
    } finally { client?.release(); }
  }
  async transaction<T>(operation: (database: PracticeDatabase) => T | Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect(); await client.query('begin'); await this.setup(client);
      await client.query('select pg_advisory_xact_lock($1)', [this.options.advisoryLockKey]);
      const before = await this.load(client), database = structuredClone(before), result = await this.transactionContext.run(client, () => operation(database));
      await this.persist(client, before, database); await client.query('commit'); return structuredClone(result);
    } catch (error) {
      await client?.query('rollback').catch(() => undefined);
      if (error instanceof DomainError) throw error; throw unavailable();
    } finally { client?.release(); }
  }
  /** Trusted extensions can join the current transaction; never retain this client beyond the callback. */
  currentTransactionClient(): PoolClient | undefined { return this.transactionContext.getStore(); }
  async close() { if (this.ownsPool) await this.pool.end(); }
}
