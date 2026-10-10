import { join, resolve } from 'node:path';
import { createPrivateJson, loadPrivateCorpus, preparePrivateDirectory, readPrivateJson } from '../evals/private-corpus';
import { createPrivateRolePlan, recordPrivateRoleRun, type PrivateRoleRun } from '../evals/private-role-runner';
import { privateReviewPackets, privateRoleAnnotationTemplate, scorePrivateRoleReview } from '../evals/private-role-review';
import type { EvaluationRole } from '../evals/role-runner';

async function main() {
  const flags = new Map<string, string | true>(), args = process.argv.slice(2);
  const switches = new Set(['--help', '--record', '--acknowledge-paid-api', '--packets', '--template', '--require-complete']);
  const values = new Set(['--corpus', '--captures', '--compare-corpus', '--roles', '--max-usd', '--operator', '--holdout-unlock', '--run', '--reviews', '--output']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]; if ((!switches.has(flag) && !values.has(flag)) || flags.has(flag)) throw new Error('Invalid private evaluation options.');
    if (switches.has(flag)) flags.set(flag, true);
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('Missing private evaluation option.'); flags.set(flag, value); }
  }
  if (!args.length || flags.has('--help')) {
    console.log('Default: no action. Zero-call plan: --corpus PRIVATE_JSON [--captures PRIVATE_JSON,...] [--compare-corpus PRIVATE_JSON,...] [--roles ROLE,...].\nExplicit paid record: --corpus PRIVATE_JSON --record --acknowledge-paid-api --operator OPAQUE_ID --max-usd NUMBER --output NEW_PRIVATE_DIRECTORY and FOUNDRY_PRIVATE_MODEL_RECORD=1. Holdout additionally requires --holdout-unlock PRIVATE_CUSTODIAN_JSON.\nOffline blind packets: --corpus PRIVATE_JSON --run PRIVATE_RUN --packets --output NEW_PRIVATE_JSON.\nBlank independent-review template: --corpus PRIVATE_JSON --run PRIVATE_RUN --template --output NEW_PRIVATE_JSON.\nOffline scoring: --corpus PRIVATE_JSON --run PRIVATE_RUN --reviews PRIVATE_REVIEWS [--output NEW_PRIVATE_JSON] [--require-complete]. Supply the same --captures and holdout unlock where required. No code-execution option, recording resume, or release approval.'); return;
  }
  const string = (name: string) => flags.get(name) as string | undefined;
  if (!string('--corpus')) throw new Error('A private corpus is required.');
  const list = (name: string) => { const paths = string(name)?.split(','); if (paths && (paths.length > 10 || paths.some(path => !path.trim()) || new Set(paths.map(path => resolve(path))).size !== paths.length)) throw new Error('Private artifact paths must be distinct and bounded.'); return paths; };
  const loaded = await loadPrivateCorpus(string('--corpus')!, { purpose: 'evaluation-export', capturePaths: list('--captures'), comparisonPaths: list('--compare-corpus') });
  const holdoutUnlock = string('--holdout-unlock') ? await readPrivateJson(string('--holdout-unlock')!) : undefined;
  const context = { corpus: loaded.corpus, captures: loaded.captures, holdoutUnlock }, isOffline = Boolean(string('--run'));
  if (isOffline) {
    if (['--record', '--acknowledge-paid-api', '--max-usd', '--operator', '--roles'].some(flag => flags.has(flag)) || [flags.has('--packets'), flags.has('--template'), flags.has('--reviews')].filter(Boolean).length !== 1 || ((flags.has('--packets') || flags.has('--template')) && (!string('--output') || flags.has('--require-complete')))) throw new Error('Select one offline mode; private packets/templates require a private output.');
    const run = await readPrivateJson(string('--run')!);
    const result = flags.has('--packets') ? privateReviewPackets(run, context) : flags.has('--template') ? privateRoleAnnotationTemplate(run, context) : scorePrivateRoleReview(run, await readPrivateJson(string('--reviews')!), context);
    if (string('--output')) { await createPrivateJson(string('--output')!, result); console.log('Private offline evaluation artifact saved. Qualification remains unestablished.'); }
    else console.log(JSON.stringify(result, null, 2));
    if ('status' in result && (result.status === 'blocked' || (flags.has('--require-complete') && result.status !== 'reviewed'))) process.exitCode = 1;
    return;
  }
  if (['--packets', '--template', '--reviews', '--require-complete'].some(flag => flags.has(flag))) throw new Error('Offline review needs a recorded run.');
  const roles = string('--roles')?.split(',') as EvaluationRole[] | undefined;
  if (!flags.has('--record')) {
    if (['--acknowledge-paid-api', '--max-usd', '--operator', '--holdout-unlock'].some(flag => flags.has(flag))) throw new Error('Paid or custodian acknowledgment needs explicit recording.');
    const plan = createPrivateRolePlan(context, roles), summary = { mode: 'plan-only', providerCalls: 0, provider: plan.policy.provider, model: plan.policy.model, corpus: plan.corpus.corpus, corpusDigest: plan.corpusDigest, planDigest: plan.planDigest, roles: [...new Set(plan.planned.map(row => row.role))], plannedCalls: plan.planned.length, estimatedUpperUsd: plan.estimatedUpperUsd, quality: 'pending-independent-human-review', qualification: 'not-established' };
    if (string('--output')) { await createPrivateJson(string('--output')!, summary); console.log('Private zero-call plan saved.'); } else console.log(JSON.stringify(summary, null, 2)); return;
  }
  if (process.env.FOUNDRY_PRIVATE_MODEL_RECORD !== '1' || !flags.has('--acknowledge-paid-api') || !string('--output') || !string('--operator') || !string('--max-usd')) throw new Error('Explicit private paid gates are missing.');
  const directory = resolve(string('--output')!), controller = new AbortController(), abort = () => controller.abort(); let prepared = false, checkpoint = 0;
  const persist = async (run: PrivateRoleRun) => { if (!prepared) { await preparePrivateDirectory(directory, true); prepared = true; } await createPrivateJson(join(directory, `checkpoint-${String(checkpoint++).padStart(3, '0')}.json`), run); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const run = await recordPrivateRoleRun(context, { enabled: true, acknowledgePaidApi: true, operatorId: string('--operator')!, maxUsd: Number(string('--max-usd')), roles, holdoutUnlock, signal: controller.signal, persist });
    await createPrivateJson(join(directory, 'run.json'), run);
    console.log(JSON.stringify({ provider: run.policy.provider, model: run.policy.model, state: run.state, attempted: run.entries.length, validated: run.entries.filter(entry => entry.state === 'validated').length, stopReason: run.stopReason, quality: 'pending-independent-human-review', qualification: 'not-established' }));
    if (run.state !== 'completed' || run.entries.some(entry => entry.state !== 'validated')) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
try { await main(); }
catch { console.error('Private model evaluation rejected. Check explicit gates, private paths, split custody, context bindings, recorded accounting and independent reviews. No imported content is printed.'); process.exitCode = 1; }
