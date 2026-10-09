import { describe, expect, it } from 'vitest';
import { sanitizeModelContext } from '../lib/ai/privacy';
describe('best-effort model input minimization', () => {
  it('removes recognizable API credentials, connection passwords and private-key blocks recursively', () => {
    const key = 'sk-proj-' + 'a'.repeat(30), privateKey = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----';
    const value = sanitizeModelContext({ files: { 'main.py': `KEY='${key}'` }, turns: [{ text: 'postgres://user:password@host/database' }], other: privateKey });
    expect(value.redactions).toBe(3); const text = JSON.stringify(value.value);
    expect(text).not.toContain(key); expect(text).not.toContain('password'); expect(text).not.toContain('SECRET');
  });
  it('preserves evidence IDs and ordinary code, and does not mutate the original artifact', () => {
    const original = { id: 'snapshot:123:quote.py', content: 'def add(a,b): return a+b\n' };
    expect(sanitizeModelContext(original)).toEqual({ value: original, redactions: 0 });
    const secret = { content: 'ghp_' + 'x'.repeat(30) }, copy = structuredClone(secret);
    sanitizeModelContext(secret); expect(secret).toEqual(copy);
  });
});
