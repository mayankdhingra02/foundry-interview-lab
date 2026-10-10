import { clearLocalCookie, supabase } from '@/lib/server/auth';
import { authMode } from '@/lib/server/config';
import { handle, privateJson } from '@/lib/server/http';
export async function POST(request: Request) {
  return handle(request, async () => {
    if (authMode() === 'supabase') {
      const client = await supabase(); const { error } = await client.auth.signOut();
      if (error) throw error;
    }
    return privateJson({ signedOut: true }, 200, { 'Set-Cookie': clearLocalCookie() });
  });
}
