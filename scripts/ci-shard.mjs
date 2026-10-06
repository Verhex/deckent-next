import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBuild } from './ci-build-artifact.mjs';
import { SHARDS } from './ci-test-plan.mjs';
const index = Number(process.argv[2]);
if (!Number.isSafeInteger(index) || index < 1 || index > SHARDS) throw new Error('Invalid shard');
const root = process.cwd();
const dir = join(root, '.pack/ci-evidence');
mkdirSync(dir, { recursive: true });
for (const file of ['files.json', 'assignment.json', 'receipt.json']) rmSync(join(dir, file), { force: true });
validateBuild(root);
const env = { ...process.env, DECKENT_CI_EVIDENCE_DIR: dir };
const execute = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
};
const exitCode = execute(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--shard', `${index}/${SHARDS}`]);
let nativeExit = null, hostExit = null, smokeExit = null;
if (index === 1) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  nativeExit = execute(npm, ['run', 'test:native']);
  hostExit = execute(npm, ['run', 'test:host']);
  smokeExit = execute(npm, ['run', 'smoke']);
}
// Missing reporter/assignment files are failures, never empty passing receipts.
const result = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8'));
const assignment = JSON.parse(readFileSync(join(dir, 'assignment.json'), 'utf8'));
const actual = result.files.map(row => row.file).sort();
if (JSON.stringify(actual) !== JSON.stringify(assignment.files)) throw new Error('Shard did not collect exactly its assigned files');
const receipt = { schemaVersion: 1, sha: process.env.GITHUB_SHA, node: process.versions.node.split('.')[0],
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  index, count: SHARDS, inventoryDigest: assignment.inventoryDigest, ...result, exitCode, nativeExit, hostExit, smokeExit };
writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt) + '\n');
process.exitCode = exitCode || nativeExit || hostExit || smokeExit || 0;
