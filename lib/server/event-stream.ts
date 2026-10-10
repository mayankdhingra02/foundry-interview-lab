import { setTimeout as delay } from 'node:timers/promises';
import type { SessionService } from './session-service';

/** Finite owner-scoped streams reconnect using committed sequence IDs. Never stream provisional model text. */
export async function streamEvents(request: Request, service: SessionService, ownerId: string, sessionId: string, after: number) {
  let pending = await service.events(ownerId, sessionId, after);
  const encoder = new TextEncoder(), abort = new AbortController();
  let closed = false;
  const onAbort = () => abort.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const until = Date.now() + 20_000;
      try {
        while (!abort.signal.aborted && Date.now() < until) {
          const batch = pending.slice(0, 100);
          if (!batch.length) controller.enqueue(encoder.encode(': keepalive\n\n'));
          for (const event of batch) {
            if (abort.signal.aborted) break;
            controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            after = event.sequence;
          }
          await delay(1000, undefined, { signal: abort.signal });
          // Rechecks ownership/existence, so deletion closes a running connection.
          pending = await service.events(ownerId, sessionId, after);
        }
      } catch {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode('event: reconnect\ndata: {"reason":"state_unavailable"}\n\n'));
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; abort.abort(); request.signal.removeEventListener('abort', onAbort); }
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' } });
}
