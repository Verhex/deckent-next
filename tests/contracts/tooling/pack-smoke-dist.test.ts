import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { buildDist } from '../../../scripts/build-dist.mjs';

// PACK-SMOKE (2026-09-30): the published package is checked in every verify, not only before a release. The release-only placement let two
// regressions rot for a batch (the terminal check still expected `deckent>` after the workline composer; a new `path` declaration leak kept
// build-dist unpublishable). This runs build-dist on the freshly built dist into a temporary directory and pack-smoke's fast checks on the
// staged package (--root: no npm install). The customer install path (npm --offline of the tarball, runtime service, MCP client, consumer
// type-check) stays in `npm run smoke:dist <tarball>` before a release. Linux only: the terminal checks drive a pseudo-TTY through util-linux
// `script`; bubblewrap staging depends on the host (build-bwrap output), so only its gaps are tolerated here.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FAST_CHECKS = ['version', 'mcp', 'native', 'lazy', 'imports', 'terminal'];
const outs: string[] = [];
afterAll(async () => { await Promise.all(outs.map(out => rm(out, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/script'))('published package gate (build-dist + pack-smoke fast checks)', () => {
  it('has no publish blocker beyond host bubblewrap staging, no stale locked license text, and passes the fast surface checks', async () => {
    expect(existsSync(join(ROOT, 'dist/build-identity.json')), 'dist missing: run `npm run build` first').toBe(true);
    const out = await mkdtemp(join(tmpdir(), 'deckent-pack-gate-')); outs.push(out);
    const summary = await buildDist({ root: ROOT, out }) as { stage: string; publishable: { blockers: string[] }; licenseTexts: { unused: string[] } };
    expect(summary.publishable.blockers.filter(blocker => !blocker.startsWith('bubblewrap: '))).toEqual([]);
    expect(summary.licenseTexts.unused).toEqual([]);

    const smoke = spawnSync(process.execPath, [join(ROOT, 'scripts/pack-smoke.mjs'), '--root', summary.stage, '--only', FAST_CHECKS.join(',')],
      { cwd: ROOT, encoding: 'utf8', timeout: 150_000 });
    const report = JSON.parse(smoke.stdout) as { ok: boolean; checks: Record<string, { ok: boolean }> };
    // The whole report on failure: which terminal case, which words were missing or unexpected.
    expect(Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.ok ? true : check])))
      .toEqual(Object.fromEntries(FAST_CHECKS.map(name => [name, true])));
    expect(smoke.status).toBe(0);
  }, 200_000);
});
