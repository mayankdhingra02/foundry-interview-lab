import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const allowedEvaluationFiles = [
  'evals/benchmark.ts',
  'evals/fixtures/attempts.json',
  'evals/fixtures/baseline-summary.json',
  'evals/fixtures/human-review.template.json',
  'evals/fixtures/runtime-observations.json',
].sort();

/** The checked-in rules use this subset: root-relative globs, ancestor
 * exclusion and ordered ! exceptions. Reject new syntax rather than pretending
 * to implement all Docker patternmatcher behavior. Real image CI stays required.
 */
function contextIncludes(path: string): boolean {
  const rules = readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const ancestors = path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  let included = true;
  for (const rule of rules) {
    const excluded = !rule.startsWith('!'), pattern = (excluded ? rule : rule.slice(1)).replace(/^\/+|\/+$/g, '');
    if (!/^[a-zA-Z0-9_./*\-]+$/.test(pattern) || pattern.includes('**')) throw new Error('Extend the checked Docker rule subset before changing ignore syntax.');
    // Docker's * includes dotfiles; Node/git glob defaults differ here.
    const expression = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.]/g, '\\.')).join('[^/]*')}$`);
    if (ancestors.some(ancestor => expression.test(ancestor))) included = !excluded;
  }
  return included;
}

function filesWithin(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Evaluation fixtures must not be symbolic links.');
    return entry.isDirectory() ? filesWithin(path) : [path];
  });
}

function importClosure(entry: string): Set<string> {
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    if (path.endsWith('.json')) return;
    const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function walk(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Unresolved dynamic import in ${path}.`);
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const specifier of imports.filter(specifier => specifier.startsWith('.') || specifier.startsWith('@/'))) {
      const base = specifier.startsWith('@/') ? resolve(root, specifier.slice(2)) : resolve(root, dirname(path), specifier);
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (!target) throw new Error(`Missing relative import ${specifier} in ${path}.`);
      const next = relative(root, target).split('\\').join('/');
      if (next.startsWith('../')) throw new Error('Source import escaped the build context.');
      visit(next);
    }
  }
  visit(entry);
  return visited;
}

describe('deployment build-context boundary', () => {
  it('admits exactly the five fixed evaluation source dependencies, not the whole fixture directory', () => {
    expect(existsSync(join(root, 'Dockerfile.dockerignore'))).toBe(false);
    expect(filesWithin('evals').filter(contextIncludes).sort()).toEqual(allowedEvaluationFiles);
    for (const path of allowedEvaluationFiles) expect(contextIncludes(path), path).toBe(true);
    for (const path of [
      'evals/candidates.json', 'evals/private/candidates.json', 'evals/captures/raw.json', 'evals/work/notes.txt',
      'evals/fixtures/future-candidates.json', 'evals/fixtures/human-review.completed.json', 'evals/fixtures/new-captures.json',
      'evals/fixtures/private/reviewer-notes.json', 'evals/fixtures/work/raw-capture.json', 'evals/new-benchmark.ts',
      'evals/.private.json', 'evals/fixtures/.reviewer-notes.json', 'evals/.work/candidates.json',
      'scripts/evaluate.ts', 'scripts/benchmark-models.ts', 'evals/role-runner.ts', '.env.production', 'work/capture.json', 'data/practice.json', 'tests/evaluation-api.test.ts',
    ]) expect(contextIncludes(path), path).toBe(false);
  });

  it('includes the evaluation screen’s real transitive source imports in the builder', () => {
    const closure = importClosure('app/api/internal/[...path]/route.ts');
    expect(closure.has('lib/server/evaluation-library.ts')).toBe(true);
    expect([...closure].filter(path => path.startsWith('evals/')).sort()).toEqual(allowedEvaluationFiles);
    for (const path of closure) expect(contextIncludes(path), `Excluded dependency ${path}`).toBe(true);
    // Runtime-loaded original task packages are already copied separately.
    expect(filesWithin('content/scenarios').every(contextIncludes)).toBe(true);
  });

  it('keeps raw evaluation sources out of runtime copies and out of the tsx worker import graph', () => {
    const closure = importClosure('scripts/worker.ts');
    expect([...closure].some(path => path.startsWith('evals/'))).toBe(false);
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runtime = dockerfile.split('FROM ${NODE_IMAGE} AS application\n')[1]?.split('\nFROM ')[0];
    expect(runtime).toBeDefined();
    expect(runtime).toContain('/app/.next ./.next');
    expect(runtime).not.toMatch(/COPY[^\n]*\/app\/evals/);
    expect(runtime).not.toMatch(/COPY\s+--from=builder(?:\s+--\S+)*\s+\/app\s/);
    const sources = [...runtime!.matchAll(/^COPY\s+--from=builder(?:\s+--\S+)*\s+(.+)$/gm)].flatMap(match => match[1].split(/\s+/).slice(0, -1));
    for (const path of closure) expect(sources.some(source => source === `/app/${path}` || `/app/${path}`.startsWith(`${source}/`)), `Missing worker runtime dependency ${path}`).toBe(true);
  });

  it('does not treat the build-allowed blank review template as completed expert annotations', () => {
    const template = JSON.parse(readFileSync(join(root, 'evals/fixtures/human-review.template.json'), 'utf8')) as { provenance: string; cases: { reviews: unknown[]; adjudication: unknown }[] };
    expect(template.provenance).toBe('human-review-required');
    expect(template.cases.length).toBeGreaterThan(0);
    expect(template.cases.every(row => row.reviews.length === 0 && row.adjudication === null)).toBe(true);
  });
});
