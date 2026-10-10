import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('.github/scripts/provision-images.sh');
const source = `public.ecr.aws/docker/library/python:3.11-slim@sha256:${'a'.repeat(64)}`;
function fixture(options: { fail?: number; cached?: boolean; github?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-ci-provision-contract-')), count = join(root, 'count'), waits = join(root, 'waits');
  writeFileSync(count, '0'); writeFileSync(waits, '');
  writeFileSync(join(root, 'docker'), `#!/bin/bash
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$3" == --format ]]; then echo '["reviewed"]'; exit 0; fi
  [[ "$FIXTURE_CACHED" == true ]]; exit $?
fi
if [[ "$1" == pull ]]; then
  count="$(< "$FIXTURE_COUNT")"; count=$((count + 1)); echo "$count" > "$FIXTURE_COUNT"
  [[ "$count" -gt "$FIXTURE_FAILS" ]]; exit $?
fi
if [[ "$1" == image && "$2" == tag ]]; then exit 0; fi
exit 99
`, { mode: 0o700 });
  writeFileSync(join(root, 'sleep'), '#!/bin/bash\necho "$1" >> "$FIXTURE_WAITS"\n', { mode: 0o700 });
  const run = (image = source, target = 'python:3.11-slim') => execFileSync('/bin/bash', ['-c', 'source "$1"; provision_reviewed_image "$2" "$3"', '_', script, image, target], { encoding: 'utf8', env: { ...process.env, PATH: root, CI: 'true', GITHUB_ACTIONS: options.github === false ? 'false' : 'true', FIXTURE_COUNT: count, FIXTURE_WAITS: waits, FIXTURE_FAILS: String(options.fail ?? 0), FIXTURE_CACHED: String(options.cached ?? false) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { run, attempts: () => Number(readFileSync(count, 'utf8')), waits: () => readFileSync(waits, 'utf8'), close: () => rmSync(root, { recursive: true, force: true }) };
}
describe('bounded CI image provisioning contract (fake Docker only)', () => {
  it('recovers transient throttling with the same pinned image and bounded backoff', () => {
    const f = fixture({ fail: 2 }); try { expect(f.run()).toContain('reviewed'); expect(f.attempts()).toBe(3); expect(f.waits()).toBe('10\n20\n'); } finally { f.close(); }
  });
  it('fails after three unsuccessful pulls and never retries a fourth time', () => {
    const f = fixture({ fail: 10 }); try { expect(() => f.run()).toThrow(); expect(f.attempts()).toBe(3); expect(f.waits()).toBe('10\n20\n'); } finally { f.close(); }
  });
  it('uses an already cached exact image without pulling or waiting', () => {
    const f = fixture({ cached: true }); try { expect(f.run()).toContain('reviewed'); expect(f.attempts()).toBe(0); expect(f.waits()).toBe(''); } finally { f.close(); }
  });
  it('rejects nonqualification hosts, mutable sources and unsupported aliases before any pull', () => {
    const outside = fixture({ github: false }); try { expect(() => outside.run()).toThrow(); expect(outside.attempts()).toBe(0); } finally { outside.close(); }
    const f = fixture(); try {
      for (const [image, target] of [['python:latest', 'python:3.11-slim'], [source.replace('public.ecr.aws', 'arbitrary.invalid'), 'python:3.11-slim'], [source, 'other:tag']]) expect(() => f.run(image, target)).toThrow();
      expect(f.attempts()).toBe(0);
    } finally { f.close(); }
  });
});
