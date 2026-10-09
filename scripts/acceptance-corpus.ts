import { join, resolve } from 'node:path';
import { capturePrivateCases, createPrivateJson, exportPrivateCorpusContexts, loadPrivateCorpus, preparePrivateDirectory, privateCorpusSummary, privateCorpusTemplate, type PrivateCaptureSet } from '../evals/private-corpus';

async function main() {
  const flags = new Map<string, string | true>(), args = process.argv.slice(2);
  const switches = new Set(['--help', '--template', '--export-contexts', '--capture-docker', '--acknowledge-isolated-host']);
  const values = new Set(['--corpus', '--captures', '--compare-corpus', '--output', '--split', '--id', '--version', '--custodian', '--cases', '--operator']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]; if ((!switches.has(flag) && !values.has(flag)) || flags.has(flag)) throw new Error('Invalid corpus option.');
    if (switches.has(flag)) flags.set(flag, true);
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('Missing corpus option.'); flags.set(flag, value); }
  }
  const string = (name: string) => flags.get(name) as string | undefined;
  if (!args.length || flags.has('--help')) {
    console.log('Default: no action. Validate: --corpus PRIVATE_JSON [--captures PRIVATE_JSON,...] [--compare-corpus PRIVATE_JSON,...].\nBlank template: --template --split development|acceptance|holdout --id OPAQUE_ID --version SEMVER --custodian OPAQUE_ID --output NEW_PRIVATE_JSON.\nPrivate faithful context export: --corpus PRIVATE_JSON --export-contexts --output NEW_PRIVATE_JSON. Existing model recorder/reviewer cannot import this private split format yet.\nExplicit isolated capture: --corpus PRIVATE_JSON --capture-docker --acknowledge-isolated-host --operator OPAQUE_ID --cases ID,... --output NEW_PRIVATE_DIRECTORY and FOUNDRY_ACCEPTANCE_CAPTURE=1. Never use a shared learner execution host. No provider calls are available.'); return;
  }
  const isTemplate = flags.has('--template'), isCapture = flags.has('--capture-docker'), isExport = flags.has('--export-contexts');
  if ([isTemplate, isCapture, isExport].filter(Boolean).length > 1) throw new Error('Select one corpus mode.');
  if (isTemplate) {
    if (flags.has('--corpus') || flags.has('--captures') || flags.has('--compare-corpus') || flags.has('--cases') || flags.has('--operator') || flags.has('--acknowledge-isolated-host') || !string('--output')) throw new Error('Invalid template options.');
    const split = string('--split'); if (split !== 'development' && split !== 'acceptance' && split !== 'holdout') throw new Error('Select a split.');
    const template = privateCorpusTemplate(split, string('--id')!, string('--version')!, string('--custodian')!);
    await createPrivateJson(string('--output')!, template); console.log('Empty private corpus template saved. Zero cases, captures, labels, and provider calls; qualification pending.'); return;
  }
  if (!string('--corpus') || ['--split', '--id', '--version', '--custodian'].some(flag => flags.has(flag)) || (!isCapture && ['--cases', '--operator', '--acknowledge-isolated-host'].some(flag => flags.has(flag)))) throw new Error('Invalid validation options.');
  const list = (name: string) => { const items = string(name)?.split(','); if (items && (items.some(item => !item.trim()) || new Set(items.map(item => resolve(item))).size !== items.length || items.length > 10)) throw new Error('Supply distinct bounded private paths.'); return items; };
  const loaded = await loadPrivateCorpus(string('--corpus')!, { purpose: isCapture ? 'capture' : isExport ? 'evaluation-export' : 'validation', capturePaths: list('--captures'), comparisonPaths: list('--compare-corpus') });
  if (isCapture) {
    if (!string('--output') || !string('--cases') || !string('--operator') || !flags.has('--acknowledge-isolated-host') || process.env.FOUNDRY_ACCEPTANCE_CAPTURE !== '1') throw new Error('Explicit capture gates are missing.');
    const directory = resolve(string('--output')!); await preparePrivateDirectory(directory, true);
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      let checkpoint = 0;
      const persist = async (value: PrivateCaptureSet) => { await createPrivateJson(join(directory, `checkpoint-${String(checkpoint++).padStart(3, '0')}.json`), value); };
      const result = await capturePrivateCases(loaded.corpus, string('--cases')!.split(','), { enabled: true, acknowledgeIsolatedHost: true, operatorId: string('--operator')!, signal: controller.signal, persist });
      await createPrivateJson(join(directory, 'captures.json'), result);
      console.log(JSON.stringify({ mode: 'isolated-capture', observations: result.captures.length, providerCalls: 0, qualification: 'pending-operator-verification-and-human-review', manifestChanged: false }));
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } else if (isExport) {
    if (!string('--output')) throw new Error('Context export requires a private output.');
    await createPrivateJson(string('--output')!, exportPrivateCorpusContexts(loaded.corpus, loaded.captures));
    console.log('Private context export saved. Existing development role workflow import is unsupported; qualification pending.');
  } else {
    const summary = privateCorpusSummary(loaded.corpus, loaded.attempts, true);
    if (string('--output')) { await createPrivateJson(string('--output')!, summary); console.log('Private count-only validation summary saved. Qualification pending.'); }
    else console.log(JSON.stringify(summary, null, 2));
  }
}
try { await main(); }
catch { console.error('Private corpus operation rejected. Check options, file privacy, pinned identities, split separation and observation provenance. No imported content is printed; no provider call is available.'); process.exitCode = 1; }
