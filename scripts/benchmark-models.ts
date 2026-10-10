import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRecipes, loadRuntimeCapture, materializeAttempt } from '../evals/benchmark';
import { compareRoleRuns, createRolePlan, EVALUATION_ROLES, recordRoleRun, roleReviewTemplate, type EvaluationRole, type RoleRun } from '../evals/role-runner';

const args = process.argv.slice(2);
const switches = new Set(['--record', '--acknowledge-paid-api', '--help']);
const values = new Set(['--roles', '--cases', '--max-usd', '--output', '--compare', '--review-template']);
const options = new Map<string, string | true>();
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if ((!switches.has(flag) && !values.has(flag)) || options.has(flag)) throw new Error('Unknown or duplicate benchmark option. Use --help.');
  if (switches.has(flag)) options.set(flag, true);
  else {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options.set(flag, value);
  }
}
if (options.has('--help')) {
  console.log('Default: print a zero-call plan. Optional --cases id,id --roles interviewer,coach,assistant-ask,assistant-plan,assistant-edit.\nPaid recording: --record --acknowledge-paid-api --max-usd NUMBER --output NEW_PRIVATE_PATH\nOffline comparison: --compare PATH,PATH [--output NEW_PRIVATE_PATH]\nBlank independent-review template: --review-template PATH [--output NEW_PRIVATE_PATH]\nThe recording journal is private, created exclusively, and cannot be resumed or overwritten.');
} else {
  const stringValue = (name: string) => options.get(name) as string | undefined;
  const outputPath = stringValue('--output');
  const createPrivateFile = async (path: string, body: unknown) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(body, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const printOrSave = async (body: unknown) => {
    if (outputPath) { await createPrivateFile(resolve(outputPath), body); console.log('Private evaluation artifact saved.'); }
    else console.log(JSON.stringify(body, null, 2));
  };
  if (options.has('--compare') || options.has('--review-template')) {
    if (options.has('--record') || options.has('--acknowledge-paid-api') || options.has('--max-usd') || options.has('--roles') || options.has('--cases') || (options.has('--compare') && options.has('--review-template'))) throw new Error('Offline inspection cannot be combined with recording or corpus selection.');
    const paths = (stringValue('--compare') ?? stringValue('--review-template')!).split(',');
    if (paths.some(path => !path.trim()) || paths.length > 20 || (options.has('--review-template') && paths.length !== 1)) throw new Error('Supply bounded distinct artifact paths.');
    const runs = await Promise.all(paths.map(async path => JSON.parse(await readFile(resolve(path), 'utf8')) as unknown));
    await printOrSave(options.has('--compare') ? compareRoleRuns(runs) : roleReviewTemplate(runs[0]));
  } else {
    const recipes = await loadRecipes(), capture = await loadRuntimeCapture();
    const caseIds = stringValue('--cases')?.split(','), roles = stringValue('--roles')?.split(',') as EvaluationRole[] | undefined;
    if (caseIds && (new Set(caseIds).size !== caseIds.length || caseIds.some(id => !recipes.cases.some(recipe => recipe.id === id)))) throw new Error('Select distinct known case IDs.');
    const attempts = recipes.cases.filter(recipe => !caseIds || caseIds.includes(recipe.id)).map(recipe => materializeAttempt(recipe, capture));
    const plan = createRolePlan(recipes.version, attempts, roles);
    if (!options.has('--record')) {
      if (options.has('--acknowledge-paid-api') || options.has('--max-usd')) throw new Error('Paid acknowledgement and spending cap require --record.');
      await printOrSave({ mode: 'plan-only', providerCalls: 0, corpus: 'development-regression', benchmarkVersion: recipes.version, benchmarkDigest: plan.benchmarkDigest, provider: plan.policy.provider, model: plan.policy.model, roles: roles ?? EVALUATION_ROLES, plannedCalls: plan.planned.length, estimatedUpperUsd: plan.estimatedUpperUsd, quality: 'pending-independent-human-review' });
    } else {
      if (!outputPath || options.get('--acknowledge-paid-api') !== true || !stringValue('--max-usd')) throw new Error('Recording needs --acknowledge-paid-api, --max-usd and a new private --output path.');
      const absolute = resolve(outputPath);
      let created = false;
      const persist = async (run: RoleRun) => {
        if (!created) { await createPrivateFile(absolute, run); created = true; return; }
        const temporary = `${absolute}.${randomUUID()}.tmp`;
        await createPrivateFile(temporary, run);
        await rename(temporary, absolute);
        const directory = await open(dirname(absolute), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      };
      const run = await recordRoleRun(recipes.version, attempts, { acknowledgePaidApi: true, maxUsd: Number(stringValue('--max-usd')), roles, persist });
      console.log(JSON.stringify({ runId: run.runId, provider: run.policy.provider, model: run.policy.model, state: run.state, attempted: run.entries.length, validated: run.entries.filter(row => row.state === 'validated').length, stopReason: run.stopReason, quality: 'pending-independent-human-review' }, null, 2));
      if (run.state !== 'completed' || run.entries.some(row => row.state !== 'validated')) process.exitCode = 1;
    }
  }
}
