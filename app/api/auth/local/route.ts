import { getActor, localIdentityCookie } from '@/lib/server/auth';
import { handle, privateJson } from '@/lib/server/http';
export async function POST(request: Request) {
  return handle(request, async () => {
    const existing = await getActor(request);
    if (existing) return privateJson({ user: existing });
    const { actor, cookie } = localIdentityCookie();
    return privateJson({ user: actor }, 200, { 'Set-Cookie': cookie });
  });
}
