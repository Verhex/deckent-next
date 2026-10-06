import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import DurationSequencer from './scripts/ci-sequencer.mjs';
import { canonicalTemporaryEnvironment } from './tests/fixtures/canonical-temp.js';

import { fileURLToPath } from 'node:url';

const pkgs = Object.keys(JSON.parse(readFileSync(new URL('./arch.json', import.meta.url), 'utf8')).packages);
const alias = Object.fromEntries(pkgs.map(p => [`#${p}`, fileURLToPath(new URL(`./src/${p}`, import.meta.url))]));
// Give the config, fixture workers and their children the same canonical temporary parent.
// Keep strict product symlink/realpath checks; do not resolve user-supplied product roots.
const temporaryEnv = canonicalTemporaryEnvironment();
Object.assign(process.env, temporaryEnv);
// Tests never write into the owner's global state root (~/.deckent: the bundled bubblewrap's verified copy under bin/, secret-store files,
// the personal MCP registry, global config; BWRAP-SELECT): every worker gets one temporary root for this run, removed by the teardown.
// A test that needs its own root still sets DECKENT_GLOBAL_HOME for its child process or passes an explicit environment.
const globalHome = process.env['DECKENT_TEST_GLOBAL_HOME'] ??= mkdtempSync(join(tmpdir(), 'deckent-test-global-'));

// Fixture repositories run `git commit`; Git may then start (observed with Git 2.55 on CI) detached background maintenance that writes into .git while the
// test's afterEach removes the directory (ENOTEMPTY). Every test process gets gc/maintenance off through Git's own environment config (GIT_CONFIG_COUNT,
// Git >= 2.31; appended after any config the developer already exports). Product git children never see it: they use plumbing only and build an explicit
// environment (tracked-files, local-git) or drop every GIT_* variable (git-workspace broker); the tests that assert those child environments are unchanged.
// Per-test bound: 30 s by default. Hosted macOS (3 vCPU) and Windows (4 vCPU) runners finish the heavy migration/process tests in 30–54 s
// (main run 37285853079), so CI sets DECKENT_TEST_TIMEOUT_MS for those cells; a hang still fails at that bound. Invalid values are refused.
const testTimeoutRaw = process.env['DECKENT_TEST_TIMEOUT_MS'];
const testTimeout = testTimeoutRaw === undefined || testTimeoutRaw === '' ? 30_000 : Number(testTimeoutRaw);
if (!Number.isSafeInteger(testTimeout) || testTimeout < 1_000 || testTimeout > 600_000) throw new Error(`DECKENT_TEST_TIMEOUT_MS must be an integer 1000..600000, got ${testTimeoutRaw}`);

const gitQuiet = { 'gc.auto': '0', 'gc.autoDetach': 'false', 'maintenance.auto': 'false' };
const gitBase = Number(process.env['GIT_CONFIG_COUNT'] ?? 0) || 0;
const gitConfigEnv: Record<string, string> = { GIT_CONFIG_COUNT: String(gitBase + Object.keys(gitQuiet).length) };
Object.entries(gitQuiet).forEach(([key, value], index) => { gitConfigEnv[`GIT_CONFIG_KEY_${gitBase + index}`] = key; gitConfigEnv[`GIT_CONFIG_VALUE_${gitBase + index}`] = value; });

export default defineConfig({
  resolve: { alias },
  test: {
    reporters: ['default', './scripts/verification-reporter.mjs'],
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'apps'],
    pool: 'forks',
    sequence: { sequencer: DurationSequencer },
    // Full suite: 4 workers (owner 2026-09-27; measured 10.9 GB peak, 297 s verify). Lanes' targeted runs set VITEST_MAX_FORKS=2.
    maxWorkers: Number(process.env.VITEST_MAX_FORKS ?? 4),
    testTimeout,
    env: { DECKENT_GLOBAL_HOME: globalHome, ...gitConfigEnv, ...temporaryEnv },
    globalSetup: ['./tests/fixtures/global-home-teardown.ts'],
  },
});
