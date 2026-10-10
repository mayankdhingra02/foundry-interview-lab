import { billingAction } from '@/lib/billing/routes';
export const runtime = 'nodejs';
export function POST(request: Request) { return billingAction(request, 'portal'); }
