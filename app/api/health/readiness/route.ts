import { readiness } from '@/lib/server/operations';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  const state = await readiness();
  return Response.json(state, { status: state.status === 'ready' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
