import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { measureInstalledPackage } from '#adapters/core/installation-artifacts/index.js';
import { BEUSER_REALM_RECIPE, createBeuserArrange, verifyBeuserDistribution } from '#adapters/core/beuser-realm/index.js';
import { isSourceCheckout, packageRemovalCommand, sha256 } from '#platform/index.js';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { buildDist, packDist } from '../../../scripts/build-dist.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { normalizeZodImports } from '../../../scripts/dist-zod.mjs';

// PACK-SMOKE (2026-09-30): the published package is checked in every verify, not only before a release. The release-only placement let two
// regressions rot for a batch (the terminal check still expected `deckent>` after the workline composer; a new `path` declaration leak kept
// build-dist unpublishable). This runs build-dist on the freshly built dist into a temporary directory and pack-smoke's fast checks on the
// staged package plus a global offline tarball install for provenance/uninstall. The broader customer install path (runtime service, MCP client,
// consumer type-check) stays in `npm run smoke:dist <tarball>` before a release. Linux only: the terminal checks drive a pseudo-TTY through util-linux
// `script`; bubblewrap staging depends on the host (build-bwrap output), so only its gaps are tolerated here.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FAST_CHECKS = ['version', 'mcp', 'native', 'lazy', 'imports', 'bootstrap', 'terminal', 'extensions'];
// PACKAGED-WORKER-BOOTSTRAP (dogfood D3-1, 2026-10-01): the docker supervisor mounts this one file alone as /run/deckent-bootstrap.mjs; the
// split bundle gave it `import "../../../../vendor/chunk-*.js"` and every native worker died with ERR_MODULE_NOT_FOUND.
const BOOTSTRAP = 'dist/adapters/core/native-connection/internal/worker.js';
const SPECIFIERS = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const outs: string[] = [];
afterAll(async () => { await Promise.all(outs.map(out => rm(out, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/script'))('published package gate (build-dist + pack-smoke fast checks)', () => {
  it('has no publish blocker beyond host bubblewrap staging, no stale locked license text, and passes the fast surface checks', async () => {
    const imports = [
      ["import { z } from 'zod'; export const s = z.string();", "import * as z from 'zod'; export const s = z.string();"],
      ['import {z as schema} from "zod"; export const s = schema.string();', 'import * as schema from "zod"; export const s = schema.string();'],
      ["import { z, ZodError } from 'zod';", "import { z, ZodError } from 'zod';"],
      ["import z, { z as other } from 'zod';", "import z, { z as other } from 'zod';"],
      ["import 'zod';", "import 'zod';"], ["import * as z from 'zod';", "import * as z from 'zod';"],
      ["import { z } from 'other';", "import { z } from 'other';"],
      ["// import { z } from 'zod';\nconst text = `\nimport { z } from 'zod';\n`;", "// import { z } from 'zod';\nconst text = `\nimport { z } from 'zod';\n`;"],
      ["import { z } from 'zod'; export { z };", "import { z } from 'zod'; export { z };"],
      ["import { z } from 'zod'; export const root = z.default;", "import { z } from 'zod'; export const root = z.default;"],
      ["import { z } from 'zod'; export const root = z.z;", "import { z } from 'zod'; export const root = z.z;"],
    ];
    for (const [input, output] of imports) {
      expect(normalizeZodImports(input)).toBe(output);
      expect(normalizeZodImports(output)).toBe(output);
    }
    expect(existsSync(join(ROOT, 'dist/build-identity.json')), 'dist missing: run `npm run build` first').toBe(true);
    const out = await mkdtemp(join(tmpdir(), 'deckent-pack-gate-')); outs.push(out);
    const summary = await buildDist({ root: ROOT, out }) as { stage: string; publishable: { blockers: string[] }; licenseTexts: { unused: string[] } };
    expect(summary.publishable.blockers.filter(blocker => !blocker.startsWith('bubblewrap: '))).toEqual([]);
    expect(summary.licenseTexts.unused).toEqual([]);
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> };
    const unusedLocales = Object.values(meta.outputs).flatMap(output => Object.entries(output.inputs))
      .filter(([path, input]) => /node_modules\/zod\/v4\/locales\/(?!en\.js$)/u.test(path) && input.bytesInOutput > 0);
    expect(unusedLocales, 'unused Zod locales must be removed from the actual bundle').toEqual([]);
    const limits = { maxFiles: 20000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxDepth: 32 };
    const measured = await measureInstalledPackage(summary.stage, limits);
    expect(measured.declaredMissing).toEqual([]);
    const distribution = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    expect(await verifyBeuserDistribution(summary.stage, distribution, limits, sha256(JSON.stringify(distribution)))).toBe(true);
    const specifiers = [...readFileSync(join(summary.stage, BOOTSTRAP), 'utf8').matchAll(SPECIFIERS)].map(match => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(spec => !spec.startsWith('node:')), 'the mounted bootstrap must stay standalone').toEqual([]);

    // R1: the real global tarball install must locate itself without the bundled-away source module existing.
    const { tarball, sha256: tarballSha256 } = packDist(summary, out) as { tarball: string; sha256: string }, prefix = join(out, 'global prefix');
    const env = { PATH: process.env['PATH'], HOME: join(out, 'home'), DECKENT_GLOBAL_HOME: join(out, 'global-home'), LANG: 'C.UTF-8' };
    const installed = spawnSync('npm', ['install', '-g', tarball, '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(out, 'empty-cache')],
      { env, encoding: 'utf8', timeout: 60_000 });
    expect(installed.status, installed.stderr).toBe(0);
    const root = join(prefix, 'lib/node_modules/deckent'), platform = pathToFileURL(join(root, 'dist/platform/index.js')).href;
    const probe = (code: string, args: readonly string[] = []) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code, ...args], { env, encoding: 'utf8', timeout: 20_000 });
      expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout) as unknown;
    };
    const command = `npm uninstall -g --prefix ${JSON.stringify(prefix)} deckent`;
    expect(existsSync(join(root, 'dist/platform/core/host/internal/package-method.js'))).toBe(false);
    expect(probe(`const p = await import(${JSON.stringify(platform)}); console.log(JSON.stringify({ command: p.packageRemovalCommand(), source: p.isSourceCheckout() }));`))
      .toEqual({ command, source: false });
    expect(probe(`const p = await import(${JSON.stringify(platform)}); console.log(JSON.stringify(p.packageRemovalCommand(${JSON.stringify(join(prefix, 'bin/deckent'))})));`)).toBe(command);
    expect(probe(`const p = await import(${JSON.stringify(platform)}); console.log(JSON.stringify(p.packageRemovalCommand(undefined, ${JSON.stringify(join(prefix, 'bin/node'))})));`)).toBe('npm uninstall -g deckent');
    expect(packageRemovalCommand()).toBeNull(); expect(isSourceCheckout()).toBe(true);
    expect(probe(`const p = await import(${JSON.stringify(pathToFileURL(join(summary.stage, 'dist/platform/index.js')).href)}); console.log(JSON.stringify({ command: p.packageRemovalCommand(), source: p.isSourceCheckout() }));`))
      .toEqual({ command: null, source: false });

    const project = join(out, 'uninstall-project'), data = join(project, '.deckent');
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'config.json'), JSON.stringify({ terminal: { scopeId: 'smoke' } }), { mode: 0o600 });
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'smoke', restrictions: [], grants: [{ id: 'preview', effect: 'allow',
      actions: ['inspect'], scopes: 'all', principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'installation', ids: 'all' } }] }), { mode: 0o600 });
    probe(`const { FileInstallationIdentityStore } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/adapters/core/installation-files/index.js')).href)});
const { resolveProductLayout } = await import(${JSON.stringify(platform)});
await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: ${JSON.stringify(project)} })).loadOrCreate(); console.log('null');`);
    const preview = spawnSync(join(prefix, 'bin/deckent'), ['uninstall', '--dry-run', '--lang', 'en'], { cwd: project, env, encoding: 'utf8', timeout: 20_000 });
    expect(preview.status, preview.stderr).toBe(0); expect(preview.stdout).toContain(command);

    // Transport/admission fixtures only; execute the real BeUser reader against the globally installed candidate bytes.
    type ArrangeInput = Parameters<typeof createBeuserArrange>[0];
    const arrange = createBeuserArrange({ realm: { observe: async () => ({ state: 'admitted' }) } as unknown as ArrangeInput['realm'],
      custody: { load: async () => ({ handle: { containerId: 'fixture' } }) } as unknown as ArrangeInput['custody'],
      options: { uid: 1000, gid: 1000 } as ArrangeInput['options'], language: 'en', command: async args => {
        const script = args[args.indexOf('--eval') + 1]!.replace(JSON.stringify(BEUSER_REALM_RECIPE.packageTarget), JSON.stringify(root));
        return JSON.stringify(probe(script, [args.at(-1)!]));
      } });
    expect(await arrange.observe({} as Parameters<typeof arrange.observe>[0], { kind: 'install-method', expected: 'unproven' })).toBe('package-manager');
    console.info(JSON.stringify({ provenance: 'npm-global', command, source: 'source', staged: 'unknown', beuser: 'package-manager', tarballSha256, uninstallPreview: preview.stdout }));

    const smoke = spawnSync(process.execPath, [join(ROOT, 'scripts/pack-smoke.mjs'), '--root', summary.stage, '--only', FAST_CHECKS.join(',')],
      { cwd: ROOT, encoding: 'utf8', timeout: 150_000 });
    expect(smoke.stdout.trim().startsWith('{'), `pack-smoke printed no report (status ${smoke.status}): ${smoke.stderr.slice(-1500)}`).toBe(true);
    const report = JSON.parse(smoke.stdout) as { ok: boolean; checks: Record<string, { ok: boolean }> };
    // The whole report on failure: which terminal case, which words were missing or unexpected.
    expect(Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.ok ? true : check])))
      .toEqual(Object.fromEntries(FAST_CHECKS.map(name => [name, true])));
    expect(smoke.status).toBe(0);
  }, 200_000);
});
