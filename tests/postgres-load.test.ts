import { completeFixtureJob } from './inference-fixtures';
import { fixtureRuntimeId } from './runtime-fixtures';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresPracticeStore, type PostgresStoreOptions } from '../lib/server/postgres-store';
import type { PracticeDatabase } from '../lib/interview-practice/types';
import { author, correction, harness, openCase, owner, requestId, reviewer, scenario } from './review-fixtures';

const baselineTables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'];
const reviewTables = ['ai_practice_review_cases','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits'];
type Row = Record<string, unknown> & { runtime_payload: unknown };
type Preflight = { table_name: string; bytes: string; count: string };
type Tagged = { table_name: string; entity: Row };
type MetricRow = { table_name: string; count: string; full_bytes: string; projected_bytes: string };
type TransportOptions = { reviewReady?: boolean; limits?: PostgresStoreOptions; sizes?: (rows: Preflight[], call: number) => Preflight[]; entities?: (rows: Tagged[]) => Tagged[]; metrics?: (rows: MetricRow[]) => MetricRow[] };
const project = (entity: Row, columns: string[]) => Object.fromEntries(columns.map(column => [column, entity[column]])) as Row;

// A fake transport tests roundtrip count and fail-closed control flow, not SQL execution or latency.
function transport(records: Record<string, Row[]> = {}, options: TransportOptions = {}) {
  const present = [...baselineTables, ...(options.reviewReady ? reviewTables : [])];
  let preflightCalls = 0;
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters;
    if (sql.includes('to_regclass')) return { rows: [{ table_name: options.reviewReady ? 'ai_practice_review_cases' : null }] };
    if (sql.includes('as bytes')) {
      const sizes = present.map(table => ({ table_name: table, bytes: String((records[table] ?? []).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.runtime_payload)), 0)), count: String((records[table] ?? []).length) }));
      return { rows: options.sizes?.(sizes, ++preflightCalls) ?? sizes };
    }
    if (sql.includes('to_jsonb(entity)')) {
      // Emulate only this fixed projection syntax, so omitted identity/state or
      // ordering fields actually disappear from the fixture transport.
      const projections = new Map([...sql.matchAll(/select '([a-z_]+)'::text as table_name, to_jsonb\(entity\) as entity from \(select ([a-z0-9_,]+) from public\.\1\) as entity/g)].map(match => [match[1], match[2].split(',')]));
      expect(projections.size).toBe(present.length);
      const rows = present.flatMap(table_name => (records[table_name] ?? []).map(entity => ({ table_name, entity: project(structuredClone(entity), projections.get(table_name)!) })));
      return { rows: options.entities?.(rows) ?? rows };
    }
    if (sql.includes('as projected_bytes')) {
      const projections = new Map([...sql.matchAll(/from public\.([a-z_]+) as transport_source cross join lateral \(select ([a-z0-9_.,]+)\) as projected/g)].map(match => [match[1], match[2].split(',').map(column => column.replace('transport_source.', ''))]));
      expect(projections.size).toBe(present.length);
      const metrics = present.map(table_name => { const rows = records[table_name] ?? []; return { table_name, count: String(rows.length), full_bytes: String(rows.reduce((sum,row) => sum + Buffer.byteLength(JSON.stringify(row)),0)), projected_bytes: String(rows.reduce((sum,row) => sum + Buffer.byteLength(JSON.stringify(project(row,projections.get(table_name)!))),0)) }; });
      return { rows: options.metrics?.(metrics) ?? metrics };
    }
    return { rows: [] };
  });
  const release = vi.fn(), pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { store: new PostgresPracticeStore(pool, options.limits), query, release };
}
async function fixture(reviews = false, rich = false) {
  const context = harness(), created = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
  if (rich) {
    const mutation = async () => ({ requestId: requestId(), expectedRevision: (await context.practice.getSession(owner,created.id)).revision });
    await context.practice.requestAssistant(owner,created.id,{ ...await mutation(),mode: 'edit',message: 'Synthetic proposed edit.' });
    const edit = (await context.practice.claimJob('fixture-worker'))!;
    await completeFixtureJob(context.practice, edit,{ kind: 'assistant',model: 'synthetic-fixture',message: 'Synthetic edit.',files: { 'main.py': 'SYNTHETIC-FIXTURE-CODE' },actualUsd: 0 });
    const proposal = (await context.practice.getSession(owner,created.id)).editProposals[0];
    await context.practice.decideEdit(owner,created.id,{ ...await mutation(),proposalId: proposal.id,decision: 'accept' });
    for (let index = 0; index < 2; index++) {
      await context.practice.requestRun(owner,created.id,await mutation()); const run = (await context.practice.claimJob('fixture-worker'))!;
      await completeFixtureJob(context.practice, run,{ kind: 'run',run: { runtimeDigest: fixtureRuntimeId, status: 'completed',command: 'Synthetic fixture',stdout: '',stderr: '',exitCode: 1,durationMs: 1,tests: [{ id: 'smoke',title: 'Smoke',status: 'failed' }] } });
    }
    await context.practice.command(owner,created.id,{ ...await mutation(),action: 'finish' }); const question = (await context.practice.claimJob('fixture-worker'))!;
    await completeFixtureJob(context.practice, question,{ kind: 'interviewer',model: 'authored',actualUsd: 0,proposal: { action: 'ask_probe',question: 'What did you check?',competencyId: 'correctness',evidenceIds: [],probeId: 'p1' } });
    await context.practice.commitTurn(owner,created.id,{ ...await mutation(),text: 'The synthetic check failed.' }); const end = (await context.practice.claimJob('fixture-worker'))!;
    await completeFixtureJob(context.practice, end,{ kind: 'interviewer',model: 'authored',actualUsd: 0,proposal: { action: 'end_debrief',evidenceIds: [] } });
    await context.practice.command(owner,created.id,{ ...await mutation(),action: 'submit' }); const coach = (await context.practice.claimJob('fixture-worker'))!;
    await completeFixtureJob(context.practice, coach,{ kind: 'coach',model: 'synthetic-fixture',promptVersion: 'fixture-v1',actualUsd: 0,report: await correction(context,created.id) });
    const item = await openCase(context,created.id), report = (await context.practice.getSession(owner,created.id)).reports[0];
    const draft = await context.reviews.createDraft(author,item.id,{ requestId: requestId(),sourceReportId: report.id,reason: 'Synthetic reviewed correction.',report: await correction(context,created.id) });
    await context.reviews.reviewDraft(reviewer,draft.id,{ requestId: requestId(),decision: 'approve',note: 'Synthetic review.' });
    await context.reviews.publishDraft(reviewer,draft.id,{ requestId: requestId() });
    await context.store.transaction(db => { db.deletions.push({ id: requestId(),ownerId: owner,sessionId: requestId(),createdAt: created.createdAt,state: 'completed',objectKeys: [],completedAt: created.createdAt }); });
  } else if (reviews) await openCase(context, created.id);
  const db = await context.store.read(), session = db.sessions[created.id];
  const { files: _files, snapshots: _snapshots, events: _events, jobs: _jobs, reports: _reports, turns: _turns, runs: _runs, assistantMessages: _messages, editProposals: _edits, frozenEvidence: _frozen, ...metadata } = session;
  void _files; void _snapshots; void _events; void _jobs; void _reports; void _turns; void _runs; void _messages; void _edits; void _frozen;
  const records: Record<string, Row[]> = {
    ai_practice_sessions: [{ id: session.id, user_id: owner, scenario_id: session.scenarioId, scenario_version: session.scenarioVersion, revision: session.revision, lifecycle: session.lifecycle, configuration: session.configuration, runtime_payload: metadata }],
    ai_practice_snapshots: session.snapshots.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, content_sha256: item.sha256, created_at: item.createdAt, files: item.files, runtime_payload: item })),
    ai_practice_events: session.events.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, event_type: item.type, source: item.source, request_id: item.requestId, schema_version: item.schemaVersion, payload: item.payload, runtime_payload: item })),
    ai_practice_jobs: session.jobs.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,state: item.state,fencing_token: item.fencingToken,claim_token: item.claimToken,runtime_sequence: index + 1,created_at: item.createdAt,input: item.input,runtime_payload: item })),
    ai_practice_reports: session.reports.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,runtime_sequence: index + 1,created_at: item.createdAt,report: item,evidence_manifest: session.frozenEvidence,runtime_payload: item })),
    ai_practice_turns: session.turns.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,sequence: index + 1,runtime_payload: item })),
    ai_practice_runs: session.runs.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,sequence: index + 1,runtime_payload: item })),
    ai_practice_assistant_messages: session.assistantMessages.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,sequence: index + 1,runtime_payload: item })),
    ai_practice_edit_proposals: session.editProposals.map((item,index) => ({ id: item.id,session_id: session.id,user_id: owner,sequence: index + 1,runtime_payload: item })),
    ai_practice_evidence_manifests: session.frozenEvidence ? [{ session_id: session.id,user_id: owner,digest: session.frozenEvidence.digest,runtime_payload: session.frozenEvidence }] : [],
    ai_practice_requests: Object.values(db.requests).map(item => ({ user_id: item.ownerId, request_id: item.requestId, fingerprint: item.fingerprint, result: item.result, runtime_payload: item })),
    ai_practice_usage_ledger: db.ledger.map(item => ({ id: item.id, user_id: item.ownerId, opaque_session_id: item.sessionId, operation_id: item.operationId, kind: item.kind, amount_usd: item.amountUsd, created_at: item.createdAt, runtime_payload: item })),
    ai_practice_review_cases: Object.values(db.reviews?.cases ?? {}).map(item => ({ id: item.id, user_id: item.ownerId, session_id: item.sessionId, report_id: item.reportId, status: item.status, revision: item.revision, inspection_consent: item.inspectionConsent, support_actions_consent: item.supportActionsConsent, runtime_payload: item })),
    ai_practice_deletions: db.deletions.map(item => ({ id: item.id, opaque_owner_id: item.ownerId, opaque_session_id: item.sessionId, created_at: item.createdAt, inventory: item.objectKeys, state: item.state, attempt: item.cleanup?.attempt ?? 0, claim_token: item.cleanup?.claimToken ?? null, lease_expires_at: item.cleanup?.leaseExpiresAt ?? null, completed_at: item.completedAt ?? null, runtime_payload: item })),
    ai_practice_correction_drafts: Object.values(db.reviews?.drafts ?? {}).map(item => ({ id: item.id,user_id: item.ownerId,session_id: item.sessionId,case_id: item.caseId,evidence_digest: item.evidenceDigest,source_report_id: item.sourceReportId,report_id: item.reportId,generation_id: item.generationId,runtime_payload: item })),
    ai_practice_correction_decisions: Object.values(db.reviews?.decisions ?? {}).map(item => ({ id: item.id,user_id: item.ownerId,session_id: item.sessionId,case_id: item.caseId,runtime_payload: item })),
    ai_practice_correction_publications: Object.values(db.reviews?.publications ?? {}).map(item => ({ id: item.id,user_id: item.ownerId,session_id: item.sessionId,case_id: item.caseId,runtime_payload: item })),
    ai_practice_review_audits: (db.reviews?.audits ?? []).map(item => ({ id: item.id, user_id: item.ownerId ?? null, session_id: item.sessionId ?? null, case_id: item.caseId ?? null, runtime_payload: item })),
  };
  return { records, db, session };
}
describe('batched PostgreSQL load transport and capacity preflight', () => {
  it('loads all baseline entities in three load requests and preserves the normalized representation', async () => {
    const { records, db } = await fixture(), { store, query, release } = transport(records);
    const result = await store.read(); expect(result).toEqual(db);
    expect(query).toHaveBeenCalledTimes(6); // BEGIN, setup, discovery, preflight, tagged rows, COMMIT.
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql[0]).toBe('begin isolation level repeatable read read only'); expect(sql.at(-1)).toBe('commit');
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(1); expect(sql.filter(text => text.includes('to_jsonb(entity)'))).toHaveLength(1);
    for (const table of baselineTables) { expect(sql[3]).toContain(`from public.${table}`); expect(sql[4]).toContain(`from public.${table}`); }
    expect(sql[3]).not.toContain('PRIVATE-'); expect(sql[4]).not.toContain('PRIVATE-'); expect(release).toHaveBeenCalledOnce();
  });
  it('adds the review tables to the same two batches without extra table roundtrips', async () => {
    const { records, db } = await fixture(true), { store, query } = transport(records, { reviewReady: true });
    expect(await store.read()).toEqual(db); expect(query).toHaveBeenCalledTimes(6);
    const statements = query.mock.calls.map(call => call[0]);
    for (const table of reviewTables) { expect(statements[3]).toContain(`from public.${table}`); expect(statements[4]).toContain(`from public.${table}`); }
  });
  it('rejects total payload overflow before requesting any private entity rows', async () => {
    const { store, query, release } = transport({}, { limits: { maxStateBytes: 20 }, sizes: rows => rows.map((row,index) => ({ ...row, bytes: index < 2 ? '11' : '0' })) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false); expect(query.mock.calls.at(-1)?.[0]).toBe('rollback'); expect(release).toHaveBeenCalledOnce();
  });
  it('enforces per-table row caps independently of total bytes', async () => {
    const { store, query } = transport({}, { limits: { maxEntityRows: 1 }, sizes: rows => rows.map((row,index) => ({ ...row, count: index === 5 ? '2' : '0' })) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' }); expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false);
  });
  it.each(['missing','duplicate','unknown','invalid-count'] as const)('fails closed on %s preflight metadata', async kind => {
    const { store, query } = transport({}, { sizes: rows => kind === 'missing' ? rows.slice(1) : kind === 'duplicate' ? [...rows,rows[0]] : rows.map((row,index) => index ? row : { ...row, ...(kind === 'unknown' ? { table_name: 'caller_selected_table' } : { count: 'NaN' }) }) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' }); expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false);
  });
  it('rejects a row transfer inconsistent with preflight rather than returning truncated data', async () => {
    const { records } = await fixture(), { store } = transport(records, { entities: rows => rows.filter(row => row.table_name !== 'ai_practice_events') });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects unrecognized tags and malformed typed row payloads', async () => {
    const { records } = await fixture();
    for (const entities of [(rows: Tagged[]) => [{ ...rows[0], table_name: 'other_table' },...rows.slice(1)], (rows: Tagged[]) => [{ ...rows[0], entity: { runtime_payload: null } },...rows.slice(1)]]) {
      await expect(transport(records, { entities }).store.read()).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('retains event identity and snapshot-hash validation after batching', async () => {
    const { records } = await fixture(), corrupted = structuredClone(records);
    corrupted.ai_practice_events[0].event_type = 'session.paused'; await expect(transport(corrupted).store.read()).rejects.toMatchObject({ code: 'unavailable' });
    const changedSnapshot = structuredClone(records); changedSnapshot.ai_practice_snapshots[0].content_sha256 = '0'.repeat(64);
    await expect(transport(changedSnapshot).store.read()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('keeps the transaction advisory lock ahead of preflight and does not narrow write locking', async () => {
    const { store, query } = transport(); expect(await store.transaction((db: PracticeDatabase) => db.schemaVersion)).toBe(1);
    const sql = query.mock.calls.map(call => call[0]); expect(sql[0]).toBe('begin');
    expect(sql.findIndex(text => text.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex(text => text.includes('as bytes')));
    expect(query.mock.calls.find(call => call[0].includes('pg_advisory_xact_lock'))?.[1]).toEqual([843_239_117]); expect(sql.at(-1)).toBe('commit');
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(2); // Load and pre-COMMIT use exactly the same metric.
  });
  it('rejects projected per-table growth before sending any entity write', async () => {
    const { store, query } = transport({}, { limits: { maxEntityRows: 1 } });
    await expect(store.transaction(db => { db.ledger = [0,1].map(index => ({ id: `row-${index}`, ownerId: owner, sessionId: 'session', operationId: `op-${index}`, kind: 'admission', amountUsd: 0, createdAt: '2026-10-09T12:00:00.000Z' })); })).rejects.toMatchObject({ code: 'unavailable' });
    const sql = query.mock.calls.map(call => call[0]); expect(sql.some(text => /^(insert|delete|update) /i.test(text))).toBe(false);
    expect(sql.at(-1)).toBe('rollback');
  });
  it.each(['bytes','count'] as const)('rolls back when the exact persisted %s metric crosses the cap', async metric => {
    const { store, query, release } = transport({}, { limits: { maxStateBytes: 1000, maxEntityRows: 1 }, sizes: (rows, call) => call === 1 ? rows : rows.map((row,index) => index ? row : { ...row, [metric]: metric === 'bytes' ? '1001' : '2' }) });
    await expect(store.transaction(db => db.schemaVersion)).rejects.toMatchObject({ code: 'unavailable' });
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(2);
    expect(sql.filter(text => text.includes('as bytes'))[0]).toBe(sql.filter(text => text.includes('as bytes'))[1]);
    expect(sql).not.toContain('commit'); expect(sql.at(-1)).toBe('rollback'); expect(release).toHaveBeenCalledOnce();
  });
  it('rechecks all optional review tables in one pre-COMMIT request', async () => {
    const { store, query } = transport({}, { reviewReady: true }); await store.transaction(db => db.schemaVersion);
    const batches = query.mock.calls.map(call => call[0]).filter(text => text.includes('as bytes'));
    expect(batches).toHaveLength(2); expect(batches[1]).toBe(batches[0]);
    expect(query.mock.calls.filter(call => call[0].includes('to_regclass'))).toHaveLength(1);
    for (const table of reviewTables) expect(batches[1]).toContain(`from public.${table}`);
  });
  it('reconstructs all 18 normalized entity kinds and ordered evidence from only the projected columns', async () => {
    const { records, db } = await fixture(true,true);
    for (const table of [...baselineTables,...reviewTables]) expect(records[table]?.length,table).toBeGreaterThan(0);
    for (const table of ['ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals']) records[table].reverse();
    db.reviews!.audits.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const { store,query } = transport(records,{ reviewReady: true });
    expect(await store.read()).toEqual(db);
    const statement = query.mock.calls.find(call => call[0].includes('to_jsonb(entity)'))![0];
    expect(statement).not.toMatch(/select \*/); expect(statement).not.toContain('configuration'); expect(statement).not.toContain('evidence_manifest,');
    expect(statement).not.toContain('files,'); expect(statement).not.toContain('result,'); expect(statement).not.toContain('input,'); expect(statement).not.toContain('report,');
  });
  it('retains every existing relational identity/state validation after reducing transferred columns', async () => {
    const { records } = await fixture(true,true);
    const mismatches: Array<[string,string,unknown]> = [
      ['ai_practice_sessions','id','wrong'],['ai_practice_sessions','user_id','wrong'],['ai_practice_sessions','scenario_id','wrong'],['ai_practice_sessions','scenario_version','wrong'],['ai_practice_sessions','revision',-1],['ai_practice_sessions','lifecycle','paused'],
      ['ai_practice_snapshots','content_sha256','wrong'],
      ['ai_practice_events','sequence',-1],['ai_practice_events','event_type','wrong'],['ai_practice_events','source','wrong'],['ai_practice_events','request_id','wrong'],['ai_practice_events','schema_version',2],['ai_practice_events','payload',{}],
      ['ai_practice_jobs','state','wrong'],['ai_practice_jobs','fencing_token',-1],['ai_practice_jobs','claim_token','wrong'],
      ['ai_practice_evidence_manifests','session_id','wrong'],['ai_practice_evidence_manifests','user_id','wrong'],['ai_practice_evidence_manifests','digest','wrong'],
      ['ai_practice_requests','user_id','wrong'],['ai_practice_requests','request_id','wrong'],['ai_practice_requests','fingerprint','wrong'],
      ['ai_practice_usage_ledger','id','wrong'],['ai_practice_usage_ledger','user_id','wrong'],['ai_practice_usage_ledger','operation_id','wrong'],
      ['ai_practice_usage_ledger','opaque_session_id','wrong'],['ai_practice_usage_ledger','kind','wrong'],['ai_practice_usage_ledger','amount_usd',.5],['ai_practice_usage_ledger','created_at','invalid'],
      ['ai_practice_deletions','id','wrong'],['ai_practice_deletions','opaque_owner_id','wrong'],['ai_practice_deletions','opaque_session_id','wrong'],['ai_practice_deletions','created_at','invalid'],
      ['ai_practice_deletions','inventory',['wrong']],['ai_practice_deletions','state','pending'],['ai_practice_deletions','attempt',1],['ai_practice_deletions','claim_token','wrong'],['ai_practice_deletions','lease_expires_at','2026-12-01T00:00:00Z'],['ai_practice_deletions','completed_at',null],
      ['ai_practice_review_cases','status','wrong'],['ai_practice_review_cases','revision',-1],['ai_practice_review_cases','report_id','wrong'],['ai_practice_review_cases','inspection_consent',false],['ai_practice_review_cases','support_actions_consent',false],
      ['ai_practice_correction_drafts','evidence_digest','wrong'],['ai_practice_correction_drafts','source_report_id','wrong'],['ai_practice_correction_drafts','report_id','wrong'],['ai_practice_correction_drafts','generation_id','wrong'],
    ];
    for (const table of ['ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals',...reviewTables]) {
      for (const column of ['id','user_id','session_id']) mismatches.push([table,column,'wrong']);
      if (table !== 'ai_practice_review_cases' && reviewTables.includes(table)) mismatches.push([table,'case_id','wrong']);
    }
    for (const [table,column,value] of mismatches) {
      const corrupted = structuredClone(records); corrupted[table][0][column] = value;
      await expect(transport(corrupted,{ reviewReady: true }).store.read(),`${table}.${column}`).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('measures only counts for full and projected JSON on the same synthetic corpus', async () => {
    const { records } = await fixture(true,true), { store,query } = transport(records,{ reviewReady: true });
    const result = await store.measureLoadTransport();
    expect(result.entityRows).toBe(Object.values(records).reduce((sum,rows) => sum + rows.length,0));
    expect(result.fullRowJsonBytes).toBe(Object.values(records).flat().reduce((sum,row) => sum + Buffer.byteLength(JSON.stringify(row)),0));
    expect(result.projectedRowJsonBytes).toBeLessThan(result.fullRowJsonBytes);
    expect(Object.keys(result).sort()).toEqual(['entityRows','fullRowJsonBytes','projectedRowJsonBytes']);
    expect(Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql).toHaveLength(6); expect(sql[0]).toBe('begin isolation level repeatable read read only'); expect(sql.at(-1)).toBe('commit');
    expect(sql.some(statement => /^(insert|update|delete) /i.test(statement))).toBe(false);
    expect(sql.some(statement => statement.includes('as entity from (select'))).toBe(false);
  });
  it.each(['missing','duplicate','unknown','count','negative','larger','invalid'] as const)('fails closed on %s count-only transport measurements', async kind => {
    const { store,query } = transport({}, { metrics: rows => kind === 'missing' ? rows.slice(1) : kind === 'duplicate' ? [...rows,rows[0]] : rows.map((row,index) => index ? row : { ...row,...(kind === 'unknown' ? { table_name: 'unknown' } : kind === 'count' ? { count: '1' } : kind === 'negative' ? { full_bytes: '-1' } : kind === 'larger' ? { projected_bytes: '1' } : { projected_bytes: 'NaN' }) }) });
    await expect(store.measureLoadTransport()).rejects.toMatchObject({ code: 'unavailable' }); expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });
});
