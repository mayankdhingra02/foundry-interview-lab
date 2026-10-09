import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { authMode } from './config';
import { HttpError } from './http';

export type Actor = { id: string; email?: string; local: boolean };
const COOKIE = 'foundry_local_actor';

function secret() {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < 32) throw new HttpError(503, 'identity_unconfigured', 'Set a random SESSION_SECRET of at least 32 characters.');
  return key;
}
function sign(value: string) { return createHmac('sha256', secret()).update(value).digest('base64url'); }

export function localIdentityCookie() {
  if (authMode() !== 'local') throw new HttpError(403, 'local_identity_disabled', 'Local identity is disabled.');
  const actor = { id: randomUUID(), local: true };
  const body = Buffer.from(JSON.stringify({ id: actor.id, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  return { actor, cookie: `${COOKIE}=${body}.${sign(body)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` };
}

export async function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new HttpError(503, 'identity_unconfigured', 'Accounts are not configured.');
  const jar = await cookies();
  return createServerClient(url, key, { cookies: {
    getAll: () => jar.getAll(),
    setAll: (values) => { for (const { name, value, options } of values) jar.set(name, value, options); }
  } });
}

export async function getActor(request: Request): Promise<Actor | null> {
  const mode = authMode();
  if (mode === 'unconfigured') throw new HttpError(503, 'identity_unconfigured', 'Hosted accounts are not configured. Local identity is available only in development.');
  if (mode === 'supabase') {
    const client = await supabase();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email, local: false };
  }
  const value = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return null;
  const [body, signature] = value.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body)); const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { id: string; exp: number };
    if (!/^[\da-f-]{36}$/.test(payload.id) || payload.exp < Date.now()) return null;
    return { id: payload.id, local: true };
  } catch { return null; }
}

export async function requireActor(request: Request) {
  const actor = await getActor(request);
  if (!actor) throw new HttpError(401, 'authentication_required', 'Sign in to access your practice history.');
  return actor;
}

export function clearLocalCookie() { return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }
