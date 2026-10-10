import { supabase } from '@/lib/server/auth';
import { applicationOrigin } from '@/lib/server/config';
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code');
  if (code) {
    const client = await supabase();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return Response.redirect(`${applicationOrigin()}/interview-practice`, 303);
  }
  return Response.redirect(`${applicationOrigin()}/settings?error=sign-in-failed`, 303);
}
