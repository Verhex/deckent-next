import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLandlockRules, createWorkspaceScope, landlockShellSandbox, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// SEC-4 (Claude Security F34): the Landlock and bubblewrap realms enforce one credential floor. A directory named only by the project's
// `.gitignore` (here `secrets/` and `certs/`) is walked and deny-matched by both realms; only the generated/vendored baseline
// (`BASELINE_IGNORED_DIRS`) is left unscanned. Before the fix Landlock gave such a directory one read-write grant over its whole subtree.
const capabilities = await measureTestShellHost();
const landlockAbi = capabilities.landlock.status === 'available' ? capabilities.landlock.abi : 0;
const bubblewrapReady = capabilities.bubblewrap.status === 'available';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** The protected files under `.gitignore`d directories, workspace-relative; each matches the Core credential floor. */
const PROTECTED = ['secrets/.env', 'secrets/deep/id_rsa', 'secrets/credentials.json', 'certs/prod.pem', 'certs/tls.key'];
/** Clean files beside them: still reachable (the walk carves, it does not close the directory). */
const CLEAN = ['secrets/plain.txt', 'certs/ca.txt', 'src/a.ts'];

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dn-deny-parity-')); roots.push(base);
  const root = join(base, 'project'), scratch = join(base, 'scratch'), home = join(base, 'home');
  for (const dir of [join(root, 'secrets', 'deep'), join(root, 'certs'), join(root, 'src'), join(root, 'node_modules', 'pkg'), scratch, home]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, '.gitignore'), 'secrets/\n/certs\nnode_modules/\n');
  for (const rel of PROTECTED) await writeFile(join(root, rel), `SECRET-${rel}\n`);
  for (const rel of CLEAN) await writeFile(join(root, rel), `CLEAN-${rel}\n`);
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '');
  const scope = await createWorkspaceScope(root);
  const layout: ShellSandboxLayout = { project: scope, scratchDir: scratch };
  const environment = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  return { base, root: scope.root, scratch, home, scope, layout, environment };
}

describe.skipIf(process.platform !== 'linux')('SEC-4: Landlock and bubblewrap hide the same credential files under .gitignore\'d directories', () => {
  it('the fixture premise: both directories are .gitignore-derived (not baseline) and every protected path is on the deny floor', async () => {
    const f = await fixture();
    expect(f.scope.ignoredDirs.has('secrets') && f.scope.ignoredDirs.has('certs')).toBe(true);
    for (const rel of PROTECTED) expect(f.scope.denied(rel), rel).toBe(true);
    for (const rel of CLEAN) expect(f.scope.denied(rel), rel).toBe(false);
  });

  it('rule/view level: Landlock grants no rule reaching a protected file; bubblewrap masks the same files', async () => {
    const f = await fixture();
    const built = await buildLandlockRules(f.layout);
    if (!built.ok) throw new Error(built.reason);
    const inProject = new Map(built.rules.filter(([, path]) => !path.startsWith('/')).map(([cls, path]) => [path, cls]));
    // No rule on the file itself and no non-listing rule on any ancestor directory (a rule on a directory reaches everything beneath it).
    for (const rel of PROTECTED) {
      const ancestors = rel.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      expect(inProject.has(rel), rel).toBe(false);
      for (const dir of ['.', ...ancestors]) expect([undefined, 'l'], `${rel} via ${dir}`).toContain(inProject.get(dir));
    }
    // The ignored directories are carved, not closed: their clean entries keep their own grant.
    expect(inProject.get('secrets')).toBe('l');
    expect(inProject.get('certs')).toBe('l');
    expect(inProject.get('secrets/plain.txt')).toBe('w');
    expect(inProject.get('certs/ca.txt')).toBe('w');
    // The baseline (generated/vendored) tree is still one grant, unscanned.
    expect(inProject.get('node_modules')).toBe('w');

    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    const masked = [...view.view.maskedFiles, ...view.view.maskedDirectories, ...view.view.emptiedDirectories ?? []];
    for (const rel of PROTECTED) expect(masked.some(path => path === join(f.root, rel) || join(f.root, rel).startsWith(`${path}/`)), rel).toBe(true);
    for (const rel of CLEAN) expect(masked.some(path => path === join(f.root, rel) || join(f.root, rel).startsWith(`${path}/`)), rel).toBe(false);
  });

  it('the walk under a .gitignore\'d directory stays bounded: past the entry bound the set is refused, never cut or skipped', async () => {
    const f = await fixture();
    await writeFile(join(f.root, '.gitignore'), 'vendor/\n');
    await mkdir(join(f.root, 'vendor'));
    for (let index = 0; index < 60; index += 1) await writeFile(join(f.root, 'vendor', `f${index}.txt`), '');
    const scope = await createWorkspaceScope(f.root);
    expect(scope.ignoredDirs.has('vendor')).toBe(true);
    // The project outside `vendor/` has 6 entries at the root and a handful below: the bound is crossed only by walking `vendor/`.
    expect(await buildLandlockRules({ project: scope, scratchDir: f.scratch }, { maxEntries: 50 })).toMatchObject({ ok: false, reason: expect.stringContaining('entries') });
    expect(await resolveBubblewrapView({ project: scope, scratchDir: f.scratch }, f.environment, { maxEntries: 50 })).toMatchObject({ ok: false, reason: expect.stringContaining('entries') });
  });

  const read = 'for p in "$@"; do if cat "$p" >/dev/null 2>&1; then echo "READ $p"; else echo "DENIED $p"; fi; done';
  const command = (paths: readonly string[]) => `set -- ${paths.map(path => `'${path}'`).join(' ')}; ${read}`;

  it.skipIf(landlockAbi < 3)('real kernel, Landlock realm: the protected files are unreadable, the clean files beside them readable', async () => {
    const f = await fixture();
    const usable = landlockShellSandbox(f.layout).usable(capabilities);
    if (!usable.ok) throw new Error(usable.reason);
    const ran = await usable.realm.run({ command: command([...PROTECTED, ...CLEAN]), cwd: f.root, environment: f.environment, timeoutMs: 20_000, fixedEnv: { TMPDIR: f.scratch } });
    const lines = ran.output.split('\n');
    for (const rel of PROTECTED) expect(lines, ran.output).toContain(`DENIED ${rel}`);
    for (const rel of CLEAN) expect(lines, ran.output).toContain(`READ ${rel}`);
    expect(ran.output).not.toContain('SECRET-');
  });

  it.skipIf(!bubblewrapReady)('real bubblewrap realm: the same protected files are unreadable, the same clean files readable', async () => {
    const f = await fixture();
    const usable = bubblewrapShellSandbox(f.layout).usable(capabilities);
    if (!usable.ok) throw new Error(usable.reason);
    const ran = await usable.realm.run({ command: command([...PROTECTED, ...CLEAN]), cwd: f.root, environment: f.environment, timeoutMs: 20_000, fixedEnv: { TMPDIR: f.scratch } });
    const lines = ran.output.split('\n');
    for (const rel of PROTECTED) expect(lines, ran.output).toContain(`DENIED ${rel}`);
    for (const rel of CLEAN) expect(lines, ran.output).toContain(`READ ${rel}`);
    expect(ran.output).not.toContain('SECRET-');
  });
});
