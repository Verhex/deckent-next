// Fail before tests if the actual built CLI would fall back to Landlock/host execution.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { BUNDLED_DIR, bundleProblems } from './build-bwrap.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellSandboxCapabilities } from '../dist/adapters/core/shell-sandbox-bwrap/index.js';

const cli = fileURLToPath(new URL('../dist/composition/core/cli/internal/entry.js', import.meta.url));

/** Exercise normal first-install readiness without writing authority/config into the checkout. */
export function inspectCiShellRealmProject(env = process.env, execute = execFileSync) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-ci-realm-'));
  const project = join(root, 'project'), home = join(root, 'home');
  try {
    mkdirSync(project); mkdirSync(home, { mode: 0o700 });
    const options = { cwd: project, env: { ...env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache') },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 };
    const installed = execute(process.execPath, [cli, 'init', 'policy', '--scope', 'ci-shell-realm', '--apply', '--json'], options);
    process.stdout.write(installed);
    // Nonzero doctor exits remain failures, including damaged config, ledger, policy or bundle.
    const report = JSON.parse(execute(process.execPath, [cli, 'doctor', '--json'], options));
    if (report.startability?.status !== 'ready' || report.startability.checks?.length !== 0) {
      throw new Error('CI_INSTALLATION_NOT_STARTABLE');
    }
    return report;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function proveCiShellRealm() {
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
  const { shellRealm, startability } = inspectCiShellRealmProject();
  process.stdout.write(`${JSON.stringify({ node: process.version, startability, shellRealm, bwrap: lock.outputs }, null, 2)}\n`);
  if (shellRealm?.selected !== 'bubblewrap' || shellRealm.bubblewrap?.status !== 'available') {
    throw new Error('CI_BUBBLEWRAP_REQUIRED: doctor did not select usable bubblewrap');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await proveCiShellRealm();
