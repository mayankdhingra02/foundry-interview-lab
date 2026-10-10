import { capabilities } from '@/lib/server/config';
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ status: 'ok', service: 'foundry-interview-lab', capabilities: capabilities() }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
