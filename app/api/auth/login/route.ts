import { z } from 'zod';
import { supabase } from '@/lib/server/auth';
import { applicationOrigin } from '@/lib/server/config';
import { handle, HttpError, privateJson, readJson } from '@/lib/server/http';
export async function POST(request: Request) {
  return handle(request, async () => {
    const input = z.object({ email: z.string().email().max(254) }).safeParse(await readJson(request, 2000));
    if (!input.success) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
    const client = await supabase();
    const { error } = await client.auth.signInWithOtp({ email: input.data.email, options: { emailRedirectTo: `${applicationOrigin()}/auth/callback` } });
    if (error) throw new HttpError(503, 'sign_in_unavailable', 'A sign-in link could not be sent. Try again later.');
    return privateJson({ message: 'Check your email for the sign-in link.' });
  });
}
