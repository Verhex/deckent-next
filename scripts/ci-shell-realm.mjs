// Fail before tests if the actual built CLI would fall back to Landlock/host execution.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BUNDLED_DIR, bundleProblems } from './build-bwrap.mjs';
import { join } from 'node:path';
import { shellSandboxCapabilities } from '../dist/adapters/core/shell-sandbox-bwrap/index.js';

const stateDir = process.env.DECKENT_GLOBAL_HOME;
if (!stateDir) throw new Error('CI_GLOBAL_HOME_REQUIRED');
const lock = JSON.parse(readFileSync('packaging/bwrap/bwrap.lock.json', 'utf8'));
for (const tree of ['src', 'dist']) {
  const problems = bundleProblems(join(tree, BUNDLED_DIR), lock);
  if (problems.length) throw new Error(`CI_BWRAP_BUNDLE_INVALID: ${tree}: ${problems.join('; ')}`);
}
// Doctor is read-only: use the service's normal placement/probe path first on a fresh runner.
const capabilities = await shellSandboxCapabilities(stateDir);
process.stdout.write(`${JSON.stringify({ bubblewrapProbe: capabilities.bubblewrap })}\n`);
if (capabilities.bubblewrap.status !== 'available') throw new Error('CI_BUBBLEWRAP_REQUIRED: service probe failed');
const output = execFileSync(process.execPath, ['dist/composition/core/cli/internal/entry.js', 'doctor', '--json'],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 });
const { shellRealm } = JSON.parse(output);
process.stdout.write(`${JSON.stringify({ node: process.version, shellRealm, bwrap: lock.outputs }, null, 2)}\n`);
if (shellRealm?.selected !== 'bubblewrap' || shellRealm.bubblewrap?.status !== 'available') {
  throw new Error('CI_BUBBLEWRAP_REQUIRED: doctor did not select usable bubblewrap');
}
