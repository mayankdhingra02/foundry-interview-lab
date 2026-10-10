import { requireActor } from '@/lib/server/auth';
import { getService } from '@/lib/server/application';
import { handle, privateJson } from '@/lib/server/http';
import { exportPracticeSession } from '@/lib/server/export';
export async function GET(request: Request) {
  return handle(request, async () => {
    const actor = await requireActor(request), service = await getService();
    const sessions = (await service.exportAccount(actor.id)).map(exportPracticeSession);
    return privateJson({ exportedAt: new Date().toISOString(), sessions }, 200, { 'Content-Disposition': 'attachment; filename="foundry-practice-export.json"' });
  });
}
