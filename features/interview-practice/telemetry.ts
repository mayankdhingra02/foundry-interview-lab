"use client";

import { useEffect, useMemo } from "react";
import { browserObservation, type BrowserObservation, type LatencyMetric } from "@/lib/interview-practice/telemetry";
import type { SessionView } from "@/lib/interview-practice/types";

type Outcome = "acknowledged" | "failed" | "cancelled";
type Span = { metric: LatencyMetric; startedAt: number; done: boolean };
type JobSpan = { span: Span; jobId: string; requestId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Optional diagnostics only: no content, durable queue, retries or UI errors. */
export class PracticeTelemetry {
  private enabled = false;
  private inflight = new Map<AbortController, ReturnType<typeof setTimeout>>();
  private jobs = new Map<string, JobSpan>();
  private opened = new Set<string>();
  private windowAt = 0;
  private count = 0;
  constructor(private readonly sessionId: string) {}
  configure(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) { this.jobs.clear(); this.inflight.forEach((timer, controller) => { clearTimeout(timer); controller.abort(); }); this.inflight.clear(); }
  }
  begin(metric: LatencyMetric): Span | null {
    return this.enabled ? { metric, startedAt: performance.now(), done: false } : null;
  }
  finish(span: Span | null, outcome: Outcome, jobId?: string) {
    if (!span || span.done) return;
    span.done = true;
    const durationMs = performance.now() - span.startedAt;
    // A suspended/old tab is a missing sample, never a fabricated 1h sample.
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3_600_000) return;
    try { this.send({ event: "latency.measured", eventId: crypto.randomUUID(), metric: span.metric, durationMs, outcome, ...(jobId && uuid.test(jobId) ? { jobId } : {}) }); } catch { /* Diagnostics cannot fail learner work. */ }
  }
  trackJob(span: Span | null, jobId: string | undefined, requestId: string) {
    if (!span || !this.enabled || !jobId || !uuid.test(jobId) || this.jobs.size >= 20) return;
    this.jobs.set(jobId, { span, jobId, requestId });
  }
  /** Called after the session view is committed to the learner's DOM. */
  visible(session: SessionView) {
    if (!this.enabled) return;
    for (const [id, item] of this.jobs) {
      const job = session.jobs.find(job => job.id === id);
      const question = item.span.metric === "text.turn" ? session.events.find(event => event.type === "interviewer.question" && event.requestId === item.requestId && session.turns.some(turn => turn.role === "interviewer" && turn.id === event.payload.turnId)) : undefined;
      let outcome: Outcome | null = job?.state === "cancelled" ? "cancelled" : job?.state === "failed" ? "failed" : null;
      if (!outcome && item.span.metric === "run.result" && session.runs.some(run => run.jobId === id)) outcome = "acknowledged";
      if (!outcome && item.span.metric === "report.ready" && session.lifecycle === "completed" && session.events.some(event => event.type === "coaching.ready" && event.payload.jobId === id && session.reports.at(-1)?.id === event.payload.reportId)) outcome = "acknowledged";
      if (!outcome && question?.type === "interviewer.question" && document.getElementById(`turn-${question.payload.turnId}`)) outcome = "acknowledged";
      // An interviewer can finish without asking another question. That is not
      // a question-visible sample. The server can separately time that job.
      if (outcome) { this.jobs.delete(id); this.finish(item.span, outcome, id); }
      else if ((job?.state === "completed" && !question) || performance.now() - item.span.startedAt > 3_600_000) this.jobs.delete(id);
    }
  }
  feedbackOpened(reportId: string) {
    if (!this.enabled || !uuid.test(reportId) || this.opened.has(reportId) || this.opened.size >= 100) return;
    this.opened.add(reportId);
    try { this.send({ event: "feedback.opened", eventId: crypto.randomUUID(), reportId }); } catch { /* Diagnostics cannot fail report access. */ }
  }
  private send(observation: BrowserObservation) {
    if (!this.enabled || this.inflight.size >= 4 || !uuid.test(this.sessionId)) return;
    const parsed = browserObservation.safeParse(observation);
    if (!parsed.success) return;
    const now = performance.now();
    if (now - this.windowAt >= 60_000) { this.windowAt = now; this.count = 0; }
    if (this.count >= 30) return;
    const body = JSON.stringify(parsed.data);
    if (body.length > 1_024) return;
    this.count++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    this.inflight.set(controller, timer);
    void fetch(`/api/interview-practice/sessions/${this.sessionId}/observations`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body, signal: controller.signal })
      .catch(() => {})
      .finally(() => { clearTimeout(timer); this.inflight.delete(controller); });
  }
}

export function usePracticeTelemetry(sessionId: string, enabled = false) {
  const telemetry = useMemo(() => new PracticeTelemetry(sessionId), [sessionId]);
  useEffect(() => { telemetry.configure(enabled); return () => telemetry.configure(false); }, [enabled, telemetry]);
  return telemetry;
}
