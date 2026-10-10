import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getScenario, listScenarios } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import { executeScenario } from '../lib/runtime/runner';
import { annotationSchema, annotationTemplate, calculateReleaseGate, candidateSetSchema, loadRecipes, loadRuntimeCapture, materializeAttempt, runDeterministicBenchmark } from '../evals/benchmark';
import type { RuntimeCapture } from '../evals/benchmark';

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} needs a file path.`); return args[index + 1]; };
const writeJson = async (path: string, body: unknown) => { const absolute = resolve(path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, JSON.stringify(body, null, 2) + '\n'); };

if (args.includes('--capture-docker')) {
  if (process.env.FOUNDRY_DOCKER_INTEGRATION !== '1') throw new Error('Docker capture requires explicit FOUNDRY_DOCKER_INTEGRATION=1. No learner code is executed on the host.');
  const capture: RuntimeCapture = { version: 1, provenance: 'actual-isolated-docker', captures: [] };
  for (const scenario of listScenarios()) for (const variant of ['reference', 'starter'] as const) {
    const files = variant === 'reference' ? scenario.referenceFiles : scenario.files;
    const run = await executeScenario(scenario, files, { includeProtected: true });
    if (run.status !== 'completed') throw new Error(`Capture failed for ${scenario.id}/${variant}: ${run.stderr}`);
    capture.captures.push({ scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), variant, snapshotSha256: digest(files), testSuiteDigest: digest(scenario.tests), recordedAt: new Date().toISOString(), run });
  }
  await writeJson('evals/fixtures/runtime-observations.json', capture);
}
const recipes = await loadRecipes(), capture = await loadRuntimeCapture();
const attempts = recipes.cases.map(recipe => materializeAttempt(recipe, capture));
const candidatePath = value('--candidates'), annotationPath = value('--annotations');
const candidates = candidatePath ? candidateSetSchema.parse(JSON.parse(await readFile(resolve(candidatePath), 'utf8'))) : null;
const annotations = annotationPath ? annotationSchema.parse(JSON.parse(await readFile(resolve(annotationPath), 'utf8'))) : null;
const templatePath = value('--annotation-template');
if (templatePath) await writeJson(templatePath, annotationTemplate(recipes.version, attempts, candidates?.candidates));
const exportPath = value('--export-attempts');
if (exportPath) await writeJson(exportPath, { benchmarkVersion: recipes.version, provenance: recipes.provenance, attempts: attempts.map(attempt => ({ caseId: attempt.recipe.id, reviewFocus: attempt.recipe.reviewFocus, scenario: { id: attempt.scenario.id, version: attempt.scenario.version, rubric: attempt.scenario.rubric, probes: attempt.scenario.probes, drills: attempt.scenario.drills }, session: attempt.session })) });
const regressions = await runDeterministicBenchmark(attempts);
const release = calculateReleaseGate(recipes.version, attempts, regressions, candidates, annotations);
const result = { generatedAt: new Date().toISOString(), provenance: recipes.provenance, scenarios: listScenarios().map(scenario => ({ id: scenario.id, version: scenario.version, digest: digest(getScenario(scenario.id)!) })), regressions, release };
const outputPath = value('--output');
if (outputPath) await writeJson(outputPath, result);
console.log(JSON.stringify(result, null, 2));
if (release.status === 'blocked' || (args.includes('--require-release') && release.status !== 'passed')) process.exitCode = 1;
