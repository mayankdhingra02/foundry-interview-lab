import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orphanCandidates } from '../../lib/server/operations';
import type { ContainerMetadata } from '../../lib/server/operations';

const exec = promisify(execFile);
const apply = process.argv.includes('--apply');
if (apply && process.env.FOUNDRY_ORPHAN_RECONCILE !== '1') throw new Error('Destructive reconciliation requires FOUNDRY_ORPHAN_RECONCILE=1 and --apply. Only old Foundry execution containers are eligible.');
const docker = (args: string[]) => exec('docker', args, { timeout: 5000, maxBuffer: 32_000 });
const inspect = async (id: string): Promise<ContainerMetadata> => {
  const row = JSON.parse((await docker(['inspect', '--format', '{{json .}}', id])).stdout) as { Id: string; Name: string; Created: string; Config?: { Labels?: Record<string, string> } };
  return { id: row.Id, name: row.Name, createdAt: row.Created, labels: row.Config?.Labels ?? {} };
};
const ids = (await docker(['ps', '-aq', '--filter', 'label=foundry.interview-execution=true'])).stdout.trim().split(/\s+/).filter(Boolean);
if (ids.length > 200 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Foundry reconciliation inventory exceeded its admitted bound. No deletion was attempted.');
const inventory: ContainerMetadata[] = []; let inspectionFailures = 0;
for (const id of ids) { try { inventory.push(await inspect(id)); } catch { inspectionFailures += 1; } }
const candidates = orphanCandidates(inventory).slice(0, 50);
let removed = 0, removalFailures = 0;
if (apply) for (const candidate of candidates) {
  try { if (orphanCandidates([await inspect(candidate.id)]).length === 1) { await docker(['rm', '--force', candidate.id]); removed += 1; } }
  catch { removalFailures += 1; }
}
console.log(JSON.stringify({ event: 'runner.orphans.reconciled', mode: apply ? 'apply' : 'dry_run', inspected: inventory.length, eligibleOlderThanTenMinutes: candidates.length, removed, inspectionFailures, removalFailures, batchLimit: 50 }));
if (inspectionFailures || removalFailures) process.exitCode = 1;
