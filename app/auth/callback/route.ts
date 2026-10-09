import { supabase } from '@/lib/server/auth';
import { applicationOrigin } from '@/lib/server/config';

const failurePath = '/settings?error=sign-in-failed';
function redirect(path: string, origin?: string) {
  return new Response(null, { status: 303, headers: {
    Location: origin ? `${origin}${path}` : path,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  } });
}

export async function GET(request: Request) {
  let origin: string | undefined;
  try {
    const configured = new URL(applicationOrigin());
    if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('Invalid application origin.');
    origin = configured.origin;
    const code = new URL(request.url).searchParams.get('code');
    if (!code) return redirect(failurePath, origin);
    const client = await supabase();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return redirect('/interview-practice', origin);
  } catch {
    // Never reflect provider/configuration errors or use the request's host as a fallback.
  }
  return redirect(failurePath, origin);
}
