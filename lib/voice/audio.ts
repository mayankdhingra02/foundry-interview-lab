import { HttpError } from '../server/http';
import { MAX_CAPTURE_SECONDS, MAX_WAV_BYTES } from './config';

export function wavDuration(bytes: Uint8Array): number {
  const fail = () => { throw new HttpError(400, 'invalid_audio', 'Record up to 60 seconds of mono PCM audio using the microphone control.'); };
  if (bytes.length < 44 || bytes.length > MAX_WAV_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  // Accept one canonical format only. No metadata, embedded URLs, compressed
  // formats, extra chunks, or client-provided duration are trusted.
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || ascii(36, 4) !== 'data' ||
      view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16_000 ||
      view.getUint32(28, true) !== 32_000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) return fail();
  const seconds = (bytes.length - 44) / 32_000;
  if (seconds < 0.1 || seconds > MAX_CAPTURE_SECONDS) return fail();
  return seconds;
}

// Parse complete Layer III frames rather than infer playback duration from a
// claimed content-type or byte count. Reject trailing data and malformed audio.
export function mp3Duration(bytes: Uint8Array): number {
  const invalid = () => { throw new HttpError(503, 'invalid_speech_audio', 'Question audio was unavailable. Read the visible question and continue in text.'); };
  let offset = 0; let seconds = 0; let frames = 0;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if (bytes.length < 10 || bytes.subarray(6, 10).some(value => value > 127) || bytes[5] & 0x10) return invalid();
    offset = 10 + bytes[6] * 2 ** 21 + bytes[7] * 2 ** 14 + bytes[8] * 2 ** 7 + bytes[9];
  }
  while (offset < bytes.length) {
    if (offset + 128 === bytes.length && bytes[offset] === 84 && bytes[offset + 1] === 65 && bytes[offset + 2] === 71) { offset += 128; break; }
    if (offset + 4 > bytes.length) return invalid();
    const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2];
    const version = (b >> 3) & 3; const layer = (b >> 1) & 3; const rateIndex = (c >> 2) & 3; const bitrateIndex = c >> 4;
    if (a !== 255 || (b & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || rateIndex === 3 || !bitrateIndex || bitrateIndex === 15) return invalid();
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex] * 1000;
    const sampleRate = [44_100, 48_000, 32_000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((c >> 1) & 1);
    if (offset + frameLength > bytes.length || frameLength < 4) return invalid();
    seconds += (version === 3 ? 1152 : 576) / sampleRate; frames += 1; offset += frameLength;
  }
  if (!frames || !Number.isFinite(seconds)) return invalid();
  return seconds;
}
