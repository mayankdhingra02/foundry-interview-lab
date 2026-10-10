import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadRecipes, loadRuntimeCapture, materializeAttempt } from '../evals/benchmark';
import { roleAnnotationTemplate, scoreRoleReview } from '../evals/role-review';

async function main() {
  const args = process.argv.slice(2), flags = new Map<string, string | true>();
  const switches = new Set(['--template', '--require-complete', '--help']), values = new Set(['--run', '--reviews', '--output']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if ((!switches.has(flag) && !values.has(flag)) || flags.has(flag)) throw new Error('Unknown or duplicate role-review option.');
    if (switches.has(flag)) flags.set(flag, true);
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('A role-review path is missing.'); flags.set(flag, value); }
  }
  if (flags.has('--help')) {
    console.log('Offline blank role-specific template: --run PRIVATE_RUN --template --output NEW_PRIVATE_PATH\nOffline scoring: --run PRIVATE_RUN --reviews PRIVATE_REVIEWS [--output NEW_PRIVATE_PATH] [--require-complete]\nNo provider, runtime, billing, or release-approval action is available.'); return;
  }
  if (!flags.has('--run') || (flags.has('--template') === flags.has('--reviews')) || (flags.has('--template') && (!flags.has('--output') || flags.has('--require-complete')))) throw new Error('Select one offline template or scoring mode; templates need a new private output.');
  const input = async (flag: string) => {
    const path = resolve(flags.get(flag) as string), metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024) throw new Error('Role-review input must be a regular JSON file of at most 64 MiB.');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  };
  const recipes = await loadRecipes(), capture = await loadRuntimeCapture();
  const context = { benchmarkVersion: recipes.version, attempts: recipes.cases.map(recipe => materializeAttempt(recipe, capture)) }, run = await input('--run');
  const result = flags.has('--template') ? roleAnnotationTemplate(run, context) : scoreRoleReview(run, await input('--reviews'), context);
  if (flags.has('--output')) {
    const path = resolve(flags.get('--output') as string); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(result, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    console.log('Private offline role-review artifact saved.');
  } else console.log(JSON.stringify(result, null, 2));
  if ('status' in result && (result.status === 'blocked' || (flags.has('--require-complete') && result.status !== 'reviewed'))) process.exitCode = 1;
}

try { await main(); }
catch {
  console.error('Role-review import rejected. Check options, private file paths, schemas, candidate/context binding and review chronology. No provider or runtime call was made.');
  process.exitCode = 1;
}
