"use client";

import { ApiError } from "./client";
import type { SessionView } from "@/lib/interview-practice/types";

export const pendingStoragePrefix = "foundry-practice-pending:";
export type PendingRequest = { payload: string; uncertain: boolean; createdAt: string; title?: string; scenarioVersion?: string };
export type PendingIntent = { path: string; body: Record<string, unknown>; operationRequestId?: string };
const paths = new Set(["commands", "hints", "runs", "assistant", "turns", "edit-decisions", "drills", "reports", "interaction", "cancel-job"]);
const maxEntries = 20;
const maxStorageCharacters = 160_000;
const replayWindowMs = 30 * 24 * 60 * 60 * 1000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

export function isDeletedRequest(error: unknown): boolean {
  return error instanceof ApiError && error.status === 410 && object(error.detail) && object(error.detail.error) && error.detail.error.code === "request_deleted";
}
export function pendingReplayExpired(pending: Pick<PendingRequest, "createdAt">, now = Date.now()): boolean {
  const created = Date.parse(pending.createdAt);
  return !Number.isFinite(created) || created > now || now - created >= replayWindowMs;
}

function storageKey(ownerId: string, scope: string) {
  if (!text(ownerId, 200) || !text(scope, 200)) throw new Error("Sign in again before recovering a pending request.");
  return `${pendingStoragePrefix}${encodeURIComponent(ownerId)}:${encodeURIComponent(scope)}`;
}
export function pendingIntent(value: string): PendingIntent | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!object(parsed) || !paths.has(String(parsed.path)) || !object(parsed.body) || (parsed.operationRequestId !== undefined && !text(parsed.operationRequestId, 128))) return null;
    return parsed as PendingIntent;
  } catch { return null; }
}
function validEntry(intent: string, value: unknown, scope: string): value is PendingRequest {
  if (!object(value) || !text(value.payload, 20_000) || typeof value.createdAt !== "string" || value.createdAt.length > 40 || (value.title !== undefined && !text(value.title, 200)) || (value.scenarioVersion !== undefined && !text(value.scenarioVersion, 30))) return false;
  try {
    const wire: unknown = JSON.parse(String(value.payload));
    if (!object(wire) || !text(wire.requestId, 128) || String(wire.requestId).length < 8) return false;
    if (scope === "creation") {
      const allowed = new Set(["scenarioId", "mode", "role", "level", "skills", "targetMinutes", "aiHelp", "voice", "requestId"]);
      return intent === "create" && Object.keys(wire).every(key => allowed.has(key)) && text(wire.scenarioId, 100) && ["practice", "simulation"].includes(String(wire.mode)) && text(wire.role, 120) && text(wire.level, 100) && Array.isArray(wire.skills) && wire.skills.length <= 20 && wire.skills.every(skill => text(skill, 100)) && Number.isInteger(wire.targetMinutes) && Number(wire.targetMinutes) >= 5 && Number(wire.targetMinutes) <= 180 && typeof wire.aiHelp === "boolean" && typeof wire.voice === "boolean";
    }
    const semantic = pendingIntent(intent);
    if (!semantic || !Number.isInteger(wire.expectedRevision) || Number(wire.expectedRevision) < 0) return false;
    const { requestId, expectedRevision: _revision, ...body } = wire; void _revision;
    return JSON.stringify(body) === JSON.stringify(semantic.body) && (semantic.operationRequestId === undefined || semantic.operationRequestId === requestId);
  } catch { return false; }
}
export function readPendingRequests(ownerId: string, scope: string): Map<string, PendingRequest> {
  const key = storageKey(ownerId, scope);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return new Map();
    if (raw.length > maxStorageCharacters) { sessionStorage.removeItem(key); return new Map(); }
    const source: unknown = JSON.parse(raw);
    const parsed: unknown = Array.isArray(source) ? source.map(row => Array.isArray(row) && object(row[1]) ? [row[0], { ...row[1], createdAt: typeof row[1].createdAt === "string" && row[1].createdAt.length <= 40 ? row[1].createdAt : "" }] : row) : source;
    if (!Array.isArray(parsed) || parsed.length > maxEntries || parsed.some(row => !Array.isArray(row) || row.length !== 2 || !text(row[0], 12_000) || !validEntry(row[0], row[1], scope))) { sessionStorage.removeItem(key); return new Map(); }
    // Browser storage is untrusted. It supplies an explicit retry candidate,
    // never account authorization or an automatically dispatched request.
    return new Map(parsed.map(([intent, entry]) => [intent, { ...entry, uncertain: true }]));
  } catch { throw new Error("Browser recovery storage is unavailable. Allow session storage before retrying an action; your saved attempt is preserved."); }
}
export function writePendingRequests(ownerId: string, scope: string, requests: Map<string, PendingRequest>) {
  const key = storageKey(ownerId, scope);
  const rows = [...requests].map(([intent, entry]) => [intent, { ...entry, uncertain: true }]);
  const serialized = JSON.stringify(rows);
  if (rows.length > maxEntries || serialized.length > maxStorageCharacters) throw new Error("Too many interrupted actions are waiting. Recover a pending action before starting another.");
  if (rows.some(([intent, entry]) => !validEntry(String(intent), entry, scope))) throw new Error("The pending action could not be validated for safe recovery. Review the saved attempt before retrying.");
  try {
    if (!rows.length) { sessionStorage.removeItem(key); return; }
    let total = serialized.length; let scopes = rows.length ? 1 : 0;
    for (let index = 0; index < sessionStorage.length; index++) { const other = sessionStorage.key(index); if (other?.startsWith(pendingStoragePrefix) && other !== key) { total += sessionStorage.getItem(other)?.length ?? 0; scopes++; } }
    if (total > 500_000 || scopes > 32) throw new Error("Recovery storage is full.");
    sessionStorage.setItem(key, serialized);
  }
  catch { throw new Error("Browser recovery storage is unavailable. Allow session storage before retrying an action; your saved attempt is preserved."); }
}
export function clearSessionPracticeRecovery(ownerId: string, sessionId: string): boolean {
  let complete = true;
  try { sessionStorage.removeItem(storageKey(ownerId, `session:${sessionId}`)); } catch { complete = false; }
  try { localStorage.removeItem(`foundry-practice-draft:${sessionId}`); } catch { complete = false; }
  return complete;
}
export function reconcilePendingCreation(ownerId: string, sessions: Pick<SessionView, "events">[]): boolean {
  const pending = readPendingRequests(ownerId, "creation").get("create");
  if (!pending) return false;
  const requestId = JSON.parse(pending.payload).requestId;
  if (!sessions.some(session => session.events.some(event => event.type === "session.started" && event.requestId === requestId))) return false;
  // Only an authenticated owned-session response supplies this correlation.
  // Matching a title, timestamp, or configuration would not prove admission.
  writePendingRequests(ownerId, "creation", new Map());
  return true;
}
export function clearBrowserPracticeRecovery(): boolean {
  let complete = true;
  try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith(pendingStoragePrefix)) sessionStorage.removeItem(key); } } catch { complete = false; }
  try { for (let index = localStorage.length - 1; index >= 0; index--) { const key = localStorage.key(index); if (key?.startsWith("foundry-practice-draft:")) localStorage.removeItem(key); } } catch { complete = false; }
  return complete;
}
