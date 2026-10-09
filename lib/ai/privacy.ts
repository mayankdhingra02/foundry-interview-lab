/** Narrow best-effort credential scrubber. It cannot recognize every secret or personal detail. */
export function sanitizeModelContext(value: unknown): { value: unknown; redactions: number } {
  let redactions = 0;
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
    /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s'"<>]+/gi
  ];
  function visit(item: unknown): unknown {
    if (typeof item === 'string') {
      for (const pattern of patterns) item = (item as string).replace(pattern, () => { redactions += 1; return '[credential redacted]'; });
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  }
  return { value: visit(value), redactions };
}
