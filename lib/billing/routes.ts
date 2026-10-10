import { z } from 'zod';
import { requireActor } from '../server/auth';
import { errorResponse, handle, HttpError, privateJson, readJson } from '../server/http';
import { getBillingService } from './application';

function requireBilling() {
  const service = getBillingService();
  if (!service) throw new HttpError(503, 'billing_unconfigured', 'Optional billing is not configured.');
  return service;
}
async function account(request: Request) {
  const actor = await requireActor(request);
  if (actor.local) throw new HttpError(403, 'verified_account_required', 'Billing requires your verified Foundry account.');
  return actor;
}
export function billingStatus(request: Request) {
  return handle(request, async () => {
    const actor = await account(request), service = getBillingService();
    return privateJson(service ? await service.status(actor.id) : { enabled: false });
  });
}
export function billingAction(request: Request, action: 'checkout' | 'portal') {
  return handle(request, async () => {
    const actor = await account(request), service = requireBilling();
    const body = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }).strict().safeParse(await readJson(request, 2000));
    if (!body.success) throw new HttpError(400, 'invalid_input', 'A billing request key is required.');
    // The signed-in owner, configured price and configured redirects are server-controlled.
    return privateJson(await service[action](actor.id, body.data.requestId));
  });
}
export async function billingWebhook(request: Request) {
  // Signature verification is the webhook authentication boundary; browser Origin checks do not apply.
  try {
    const service = requireBilling(), signature = request.headers.get('stripe-signature');
    if (!signature || signature.length > 2000) throw new HttpError(400, 'invalid_signature', 'A Stripe signature is required.');
    if (Number(request.headers.get('content-length') || 0) > 256_000) throw new HttpError(413, 'body_too_large', 'The webhook is too large.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'invalid_body', 'A webhook body is required.');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 256_000) { await reader.cancel(); throw new HttpError(413, 'body_too_large', 'The webhook is too large.'); }
      chunks.push(part.value);
    }
    return privateJson(await service.receiveWebhook(Buffer.concat(chunks), signature));
  } catch (error) { return errorResponse(error); }
}
