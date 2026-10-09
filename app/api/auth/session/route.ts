import { getActor } from '@/lib/server/auth';
import { authMode } from '@/lib/server/config';
import { handle, privateJson } from '@/lib/server/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handle(request, async () => privateJson({ user: await getActor(request), authMode: authMode() }));
}
