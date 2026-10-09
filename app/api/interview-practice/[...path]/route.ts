import { practiceApi } from '@/lib/server/practice-api';
type Context = { params: Promise<{ path: string[] }> };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, context: Context) { return practiceApi(request, (await context.params).path); }
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
