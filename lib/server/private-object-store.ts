import { digest } from '../interview-practice/domain';
import { ownsPrivateObjectKey, PRIVATE_CLEANUP_POLICY } from '../interview-practice/private-cleanup';

export interface PrivateObjectStore {
  readonly targetDigest: string;
  verifyPrivateBucket(signal?: AbortSignal): Promise<boolean>;
  remove(ownerId: string, key: string, signal?: AbortSignal): Promise<void>;
  absence(ownerId: string, key: string, signal?: AbortSignal): Promise<'absent' | 'present' | 'unknown'>;
}
const REQUEST_MS = 5000, MAX_RESPONSE_BYTES = 16_384;
export function privateStorageOrigin(value: string, allowLocal = false): string {
  const url = new URL(value);
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Boolean(url.port);
  const hosted = url.protocol === 'https:' && /^[a-z]{20}\.supabase\.co$/.test(url.hostname) && !url.port;
  if ((!local && !hosted) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('private_storage_target_invalid');
  return url.origin;
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** No bucket creation, listing, uploads, recursive/prefix deletion, redirects or content download. */
export class SupabasePrivateObjectStore implements PrivateObjectStore {
  readonly targetDigest: string;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { url: string; serviceRoleKey: string; allowLocal?: boolean; fetch?: typeof fetch }) {
    this.origin = privateStorageOrigin(options.url, options.allowLocal);
    if (!options.serviceRoleKey || options.serviceRoleKey.length > 8192 || /[\r\n]/.test(options.serviceRoleKey)) throw new Error('private_storage_credentials_unavailable');
    this.fetcher = options.fetch ?? fetch;
    this.targetDigest = digest({ provider: 'supabase-storage', origin: this.origin, bucket: PRIVATE_CLEANUP_POLICY.bucket, keyPolicy: PRIVATE_CLEANUP_POLICY.version });
  }
  private async request(path: string, signal?: AbortSignal, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
    const controller = new AbortController();
    let settleAbort!: (value: null) => void;
    const aborted = new Promise<null>(resolve => { settleAbort = resolve; });
    const abort = () => { controller.abort(); settleAbort(null); };
    const timer = setTimeout(abort, REQUEST_MS);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const perform = async (): Promise<{ status: number; json: Record<string, unknown> | null } | null> => { try {
      const response = await this.fetcher(`${this.origin}/storage/v1/${path}`, {
        method: body === undefined ? 'GET' : 'DELETE', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { apikey: this.options.serviceRoleKey, Authorization: `Bearer ${this.options.serviceRoleKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); return null; }
      const reader = response.body?.getReader(); if (!reader) return { status: response.status, json: null };
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; } chunks.push(value); }
      try { return { status: response.status, json: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; }
      catch { return { status: response.status, json: null }; }
    } catch { return null; } };
    try { return await Promise.race([perform(), aborted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async verifyPrivateBucket(signal?: AbortSignal): Promise<boolean> {
    const response = await this.request(`bucket/${PRIVATE_CLEANUP_POLICY.bucket}`, signal);
    return response?.status === 200 && response.json?.id === PRIVATE_CLEANUP_POLICY.bucket && response.json?.name === PRIVATE_CLEANUP_POLICY.bucket && response.json?.public === false;
  }
  async remove(ownerId: string, key: string, signal?: AbortSignal): Promise<void> {
    if (!ownsPrivateObjectKey(ownerId, key)) throw new Error('private_storage_key_not_owned');
    // The response is deliberately not an acknowledgment of absence.
    await this.request(`object/${PRIVATE_CLEANUP_POLICY.bucket}`, signal, { prefixes: [key] });
  }
  async absence(ownerId: string, key: string, signal?: AbortSignal): Promise<'absent' | 'present' | 'unknown'> {
    if (!ownsPrivateObjectKey(ownerId, key)) return 'unknown';
    const response = await this.request(`object/info/${PRIVATE_CLEANUP_POLICY.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, signal);
    if (!response) return 'unknown';
    if (response.status === 200 && response.json?.name === key) return 'present';
    // Generic 400/404, a missing bucket, denied access or malformed JSON is never absence proof.
    return [400, 404].includes(response.status) && response.json?.code === 'NoSuchKey' ? 'absent' : 'unknown';
  }
}
