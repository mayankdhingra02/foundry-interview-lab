import { requireActor } from '@/lib/server/auth';
import { getService } from '@/lib/server/application';
import { handle, privateJson } from '@/lib/server/http';
import { exportPracticeSession } from '@/lib/server/export';
import { getBillingService } from '@/lib/billing/application';
import { getReviewService } from '@/lib/server/review-service';
export async function GET(request: Request) {
  return handle(request, async () => {
    const actor = await requireActor(request), service = await getService();
    const sessions = (await service.exportAccount(actor.id)).map(exportPracticeSession);
    const billing = await getBillingService()?.exportAccount(actor.id) ?? null;
    const reviews = await (await getReviewService()).exportOwner(actor.id);
    return privateJson({ exportedAt: new Date().toISOString(), sessions, billing, reviews }, 200, { 'Content-Disposition': 'attachment; filename="foundry-practice-export.json"' });
  });
}
