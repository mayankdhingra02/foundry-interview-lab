import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({ getService: vi.fn(), billing: vi.fn(), processJob: vi.fn(), startHeartbeat: vi.fn(), close: vi.fn(), stopHeartbeat: vi.fn(), delay: vi.fn(), events: [] as string[] }));
vi.mock('../lib/server/application', () => ({ getService: dependencies.getService }));
vi.mock('../lib/billing/application', () => ({ getBillingService: dependencies.billing }));
vi.mock('../lib/server/worker', () => ({ processOneJob: dependencies.processJob }));
vi.mock('../lib/server/operations', () => ({ startWorkerHeartbeat: dependencies.startHeartbeat }));
vi.mock('../lib/server/database-pool', () => ({ closePracticeDatabasePool: dependencies.close }));
vi.mock('node:timers/promises', () => ({ setTimeout: dependencies.delay }));

let signal: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); dependencies.events.length = 0; signal = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'once').mockImplementation((event, listener) => { if (event === 'SIGTERM') signal = listener as () => void; return process; });
  dependencies.getService.mockResolvedValue({ synthetic: true }); dependencies.billing.mockReturnValue(null);
  dependencies.startHeartbeat.mockResolvedValue(dependencies.stopHeartbeat);
  dependencies.stopHeartbeat.mockImplementation(async () => { dependencies.events.push('heartbeat-stopped'); });
  dependencies.close.mockImplementation(async () => { dependencies.events.push('pool-closed'); });
  dependencies.delay.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('worker owned practice pool shutdown (mocked work only)', () => {
  it('drains the current job, then the final heartbeat, before ending the pool', async () => {
    dependencies.processJob.mockImplementation(async () => {
      dependencies.events.push('job-started'); signal?.();
      await Promise.resolve(); dependencies.events.push('job-finished'); return true;
    });
    await import('../scripts/worker');
    expect(dependencies.events).toEqual(['job-started', 'job-finished', 'heartbeat-stopped', 'pool-closed']);
    expect(dependencies.processJob).toHaveBeenCalledOnce(); expect(dependencies.close).toHaveBeenCalledOnce();
    expect(dependencies.delay).not.toHaveBeenCalled();
  });

  it('closes after service startup fails without attempting a job or heartbeat', async () => {
    dependencies.getService.mockRejectedValue(new Error('synthetic startup failure'));
    await expect(import('../scripts/worker')).rejects.toThrow('synthetic startup failure');
    expect(dependencies.startHeartbeat).not.toHaveBeenCalled(); expect(dependencies.processJob).not.toHaveBeenCalled();
    expect(dependencies.events).toEqual(['pool-closed']); expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it('closes when heartbeat startup fails', async () => {
    dependencies.startHeartbeat.mockRejectedValue(new Error('synthetic heartbeat startup failure'));
    await expect(import('../scripts/worker')).rejects.toThrow('synthetic heartbeat startup failure');
    expect(dependencies.processJob).not.toHaveBeenCalled(); expect(dependencies.stopHeartbeat).not.toHaveBeenCalled();
    expect(dependencies.events).toEqual(['pool-closed']); expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it('closes even when the final heartbeat fails', async () => {
    dependencies.processJob.mockImplementation(async () => { signal?.(); return true; });
    dependencies.stopHeartbeat.mockImplementation(async () => { dependencies.events.push('heartbeat-failed'); throw new Error('synthetic stop failure'); });
    await expect(import('../scripts/worker')).rejects.toThrow('synthetic stop failure');
    expect(dependencies.events).toEqual(['heartbeat-failed', 'pool-closed']); expect(dependencies.close).toHaveBeenCalledOnce();
  });
});
