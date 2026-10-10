import { telemetryApi } from '@/lib/server/telemetry-api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return telemetryApi(request, (await context.params).id);
}
