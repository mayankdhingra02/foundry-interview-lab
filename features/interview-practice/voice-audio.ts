// Audio stays in browser memory. Use one server-verifiable PCM format so a
// forged recording duration cannot bypass speech admission limits.
export async function toPcmWav(recording: Blob): Promise<Blob> {
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.floor(Math.min(decoded.duration, 60) * 16_000);
    if (frames < 1_600) throw new Error('Record at least a short sentence, or type your answer.');
    const offline = new OfflineAudioContext(1, frames, 16_000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const bytes = new ArrayBuffer(44 + frames * 2); const view = new DataView(bytes);
    const ascii = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, frames * 2, true);
    samples.forEach((sample, index) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
    return new Blob([bytes], { type: 'audio/wav' });
  } finally { await decoder.close(); }
}
