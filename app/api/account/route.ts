import { clearLocalCookie, requireActor } from '@/lib/server/auth';
import { getService } from '@/lib/server/application';
import { handle, HttpError, privateJson, readJson } from '@/lib/server/http';
import { z } from 'zod';
export async function DELETE(request: Request) {
  return handle(request, async () => {
    const actor = await requireActor(request);
    const intendedOwner = request.headers.get('x-practice-owner');
    if (intendedOwner !== null && intendedOwner !== actor.id) throw new HttpError(409, 'owner_changed', 'Your account changed. Review the signed-in account before deleting practice data.');
    const service = await getService();
    const body = z.object({ requestId: z.string().min(8).max(128) }).safeParse(await readJson(request, 2000));
    if (!body.success) throw new HttpError(400, 'invalid_input', 'A deletion request key is required.');
    await service.deleteAccount(actor.id, body.data);
    return privateJson({ deleted: true, scope: 'interview-practice-data' }, 200, { 'Set-Cookie': clearLocalCookie() });
  });
}
