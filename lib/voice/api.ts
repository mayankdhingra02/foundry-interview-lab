import 'server-only';
import { getService } from '../server/application';
import { HttpError, privateJson, readJson, sameOrigin } from '../server/http';
import { MAX_MULTIPART_BYTES, voiceConfig } from './config';
import { boundedBytes, VoiceService } from './provider';

/** Called after requireActor by the authenticated practice route dispatcher. */
export async function handleVoiceRequest(request: Request, ownerId: string, sessionId: string, operation: 'transcribe' | 'speak'): Promise<Response> {
  sameOrigin(request);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST for voice requests.');
  const config = voiceConfig();
  if (!config) throw new HttpError(503, 'voice_unavailable', 'Voice is not configured and qualified. Continue with text.');
  const voice = new VoiceService((await getService()).store, config);
  await voice.checkOwner(ownerId, sessionId);
  if (operation === 'transcribe') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'invalid_content_type', 'Send the microphone recording as multipart form data.');
    const bytes = await boundedBytes(new Response(request.body, { headers: request.headers }), MAX_MULTIPART_BYTES);
    let form: FormData;
    try { form = await new Response(bytes as BodyInit, { headers: { 'Content-Type': contentType } }).formData(); } catch { throw new HttpError(400, 'invalid_audio_form', 'The audio form is invalid.'); }
    if ([...form.keys()].some(key => !['audio', 'consent', 'requestId'].includes(key)) || ['audio', 'consent', 'requestId'].some(key => form.getAll(key).length !== 1)) throw new HttpError(400, 'invalid_audio_form', 'Send one recording with consent and a request key.');
    const audio = form.get('audio'); const requestId = form.get('requestId');
    if (!(audio instanceof Blob) || audio.type !== 'audio/wav' || typeof requestId !== 'string') throw new HttpError(400, 'invalid_audio_form', 'Send a PCM WAV microphone recording.');
    const text = await voice.transcribe(ownerId, sessionId, requestId, new Uint8Array(await audio.arrayBuffer()), form.get('consent') === 'true', request.signal);
    return privateJson({ text, source: 'transcribed' });
  }
  const input = await readJson(request, 12_000);
  if (typeof input.turnId !== 'string' || input.turnId.length > 100 || typeof input.requestId !== 'string' || (input.text !== undefined && typeof input.text !== 'string')) throw new HttpError(400, 'invalid_voice_request', 'Select a recorded interviewer question and supply a request key.');
  const audio = await voice.speak(ownerId, sessionId, input.requestId, input.turnId, input.consent === true, input.text as string | undefined, request.signal);
  return new Response(audio as BodyInit, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
