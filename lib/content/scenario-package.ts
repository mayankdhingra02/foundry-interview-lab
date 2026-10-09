import 'server-only';

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Scenario } from '../interview-practice/types';
import { validateCurriculum, type ScenarioCurriculum } from '../interview-practice/curriculum';
export type CurriculumPackage = Scenario & { familyId?: string; curriculum?: ScenarioCurriculum };

const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,80}$/);
const text = z.string().trim().min(1).max(20_000);
const manifestSchema = z.object({
  id: identifier,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  familyId: identifier.optional(),
  curriculum: z.object({
    tier: z.enum(['Junior', 'Mid-level', 'Senior']), calibration: z.literal('unreviewed'),
    constraints: z.array(text).min(2).max(12),
    prerequisites: z.array(z.object({
      id: identifier, title: text, description: text,
      lesson: z.object({ id: identifier, foundryPath: text }).optional(),
    })).min(1).max(8),
  }).optional(),
  title: text,
  summary: text,
  durationMinutes: z.number().int().min(10).max(120),
  level: text,
  tags: z.array(text).min(1),
  language: z.literal('python'),
  starterFiles: z.array(text).min(1),
  referenceFiles: z.array(text).min(1),
  stages: z.array(z.object({ id: identifier, title: text, brief: text, requirements: z.array(text).min(1) })).min(2),
  rubric: z.array(z.object({ id: identifier, name: text, description: text, anchors: z.object({ strong: text, developing: text, needsWork: text }) })).min(2),
  probes: z.array(z.object({ id: identifier, stageId: identifier, competencyId: identifier, question: text, hint: text.optional() })).min(1),
  hints: z.array(text).min(3),
  tests: z.array(z.object({ id: identifier, title: text, file: text, visible: z.boolean(), timeoutSeconds: z.number().int().min(1).max(60) })).min(2).max(8),
  drills: z.array(z.object({ id: identifier, title: text, competencyId: identifier, lesson: text, exercise: text })).min(1),
  rights: text,
  runtime: z.object({ image: z.literal('python:3.11-slim'), timeoutSeconds: z.number().int().min(1).max(60), memoryMb: z.number().int().min(64).max(512) }),
});

function readAsset(directory: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Scenario assets must use safe relative paths.');
  }
  const target = resolve(directory, relativePath);
  if (!target.startsWith(resolve(directory) + sep)) throw new Error('Scenario asset escapes its package.');
  const value = readFileSync(target, 'utf8');
  if (value.includes('\0') || Buffer.byteLength(value) > 64_000) throw new Error('Scenario assets must be bounded UTF-8 text.');
  return value;
}

function readFiles(directory: string, names: string[]): Record<string, string> {
  if (new Set(names).size !== names.length) throw new Error('Duplicate scenario file name.');
  return Object.fromEntries(names.map(name => [name, readAsset(directory, name)]));
}

function assertUnique(values: string[], kind: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate scenario ${kind}.`);
}

/** Load only caller-selected authored package paths, never learner input. */
export function loadScenarioPackage(directory: string, expectedId: string): CurriculumPackage {
  const manifest = manifestSchema.parse(JSON.parse(readAsset(directory, 'manifest.json')));
  if (manifest.id !== expectedId) throw new Error('Scenario ID must match its package directory.');
  const { starterFiles, referenceFiles, tests, ...metadata } = manifest;
  assertUnique(manifest.stages.map(stage => stage.id), 'stage ID');
  assertUnique(manifest.rubric.map(criterion => criterion.id), 'criterion ID');
  assertUnique(manifest.probes.map(probe => probe.id), 'probe ID');
  assertUnique(manifest.tests.map(test => test.id), 'test ID');
  assertUnique(manifest.drills.map(drill => drill.id), 'drill ID');
  const stageIds = new Set(manifest.stages.map(stage => stage.id));
  const criterionIds = new Set(manifest.rubric.map(criterion => criterion.id));
  if (manifest.probes.some(probe => !stageIds.has(probe.stageId) || !criterionIds.has(probe.competencyId))) {
    throw new Error('Scenario probes must reference existing stages and criteria.');
  }
  if (manifest.drills.some(drill => !criterionIds.has(drill.competencyId))) throw new Error('Scenario drills must reference existing criteria.');
  if (manifest.rubric.some(criterion => !manifest.drills.some(drill => drill.competencyId === criterion.id))) {
    throw new Error('Every criterion needs an authored next-practice drill.');
  }
  if (!tests.some(test => test.visible) || !tests.some(test => !test.visible)) throw new Error('Scenario needs public and protected checks.');
  const files = readFiles(join(directory, 'starter'), starterFiles);
  const references = readFiles(join(directory, 'reference'), referenceFiles);
  if (Object.keys(files).some(name => !(name in references))) throw new Error('Reference must preserve all starter file names.');
  const scenario = {
    ...metadata,
    files,
    referenceFiles: references,
    tests: tests.map(({ file, ...test }) => ({ ...test, source: readAsset(directory, file) })),
  } satisfies CurriculumPackage;
  validateCurriculum(scenario);
  return scenario;
}
