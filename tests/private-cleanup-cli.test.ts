import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = []; afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
const script = 'scripts/private-file-cleanup.ts';
function run(args: string[], dataPath: string) {
  return spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', script, ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PRACTICE_DATA_PATH: dataPath, FEATURE_AI_INTERVIEWER: 'false', FEATURE_AI_CODING_ASSISTANT: 'false', FEATURE_EXECUTION: 'false', FEATURE_VOICE: 'false', FEATURE_BILLING: 'false' } });
}
describe('manual cleanup command isolation', () => {
  it('default dry-run does not create a missing file store or require any paid-feature credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-cleanup-cli-')); temporary.push(directory);
    const path = join(directory, 'never-created', 'practice.json'), result = run([], path);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry_run', attemptedRecords: 0, pendingRecords: 0 });
    expect(result.stderr).toBe(''); await expect(access(join(directory, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects apply without both explicit acknowledgment and disabled-by-default cleanup gate before store creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-cleanup-cli-')); temporary.push(directory);
    const path = join(directory, 'never-created', 'practice.json');
    for (const args of [['--apply'], ['--apply', '--acknowledge-private-file-deletion'], ['--max-objects', '21'], ['--unknown-option']]) {
      const result = run(args, path); expect(result.status).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ event: 'private_file_cleanup.failed', category: 'storage_policy_or_options_unavailable' });
    }
    await expect(access(join(directory, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
