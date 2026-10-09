import { afterEach, describe, expect, it, vi } from 'vitest';
import { PracticeTelemetry } from '../features/interview-practice/telemetry';

const id = 'b857af6f-3ea7-4b83-8f48-6da3cc11cc9d';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('optional browser measurement bounds', () => {
  it('makes no request when off and drops invalid, negative and over-one-hour intervals', () => {
    let clock = 100; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
    const telemetry = new PracticeTelemetry(id); telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged'); expect(fetch).not.toHaveBeenCalled(); telemetry.configure(true);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 3_600_001]) { clock = 100; const span = telemetry.begin('workspace.save'); clock = 100 + value; telemetry.finish(span, 'acknowledged'); }
    expect(fetch).not.toHaveBeenCalled(); telemetry.configure(false);
  });
  it('keeps schema-only observations, completes a span once and bounds simultaneous sends', () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    const telemetry = new PracticeTelemetry(id); telemetry.configure(true); const span = telemetry.begin('workspace.save'); telemetry.finish(span, 'acknowledged', 'not-a-job-uuid'); telemetry.finish(span, 'failed');
    expect(fetch).toHaveBeenCalledTimes(1); const init = fetch.mock.calls[0][1]; expect(JSON.parse(init.body)).toMatchObject({ event: 'latency.measured', metric: 'workspace.save', outcome: 'acknowledged' }); expect(JSON.parse(init.body)).not.toHaveProperty('jobId');
    for (let index = 0; index < 20; index++) telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged');
    expect(fetch).toHaveBeenCalledTimes(4); vi.advanceTimersByTime(5_000); for (const [, request] of fetch.mock.calls) expect(request.signal.aborted).toBe(true); telemetry.configure(false);
  });
  it('limits requests per minute and does not resend a failed observation', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock); const fetch = vi.fn().mockRejectedValue(new Error('fixture sink unavailable')); vi.stubGlobal('fetch', fetch);
    const telemetry = new PracticeTelemetry(id); telemetry.configure(true);
    for (let index = 0; index < 40; index++) { telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged'); await Promise.resolve(); await Promise.resolve(); }
    expect(fetch).toHaveBeenCalledTimes(30); clock = 60_001; telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged'); await Promise.resolve(); expect(fetch).toHaveBeenCalledTimes(31); telemetry.configure(false);
  });
  it('aborts outstanding observations when the capability becomes unavailable', () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch); const telemetry = new PracticeTelemetry(id); telemetry.configure(true); telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged'); telemetry.configure(false); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); telemetry.finish(telemetry.begin('workspace.save'), 'acknowledged'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
