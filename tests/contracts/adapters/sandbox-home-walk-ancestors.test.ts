import type { Dir } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep real files and Dirents; force the legal, adverse listing order instead of relying on the host filesystem.
const orderedHomes = new Set<string>(), unreadable = new Set<string>();
const opened: string[] = [];
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, opendir: async (...args: Parameters<typeof actual.opendir>) => {
    const path = String(args[0]); opened.push(path);
    if (unreadable.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    if (!orderedHomes.has(path)) return actual.opendir(...args);
    const names = await actual.readdir(path, { withFileTypes: true });
    names.sort((a, b) => Number(b.name.startsWith('worktree-')) - Number(a.name.startsWith('worktree-')));
    let index = 0;
    return { read: async () => names[index++] ?? null, close: async () => undefined } as Dir;
  } };
});
import { agentShellHardFloor, agentWorkspaceDeny, createWorkspaceScope, isWriteApprovalFloored, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const measured = await measureTestShellHost();
if (measured.bubblewrap.status !== 'available') console.info('verify-not-run: ancestor HOME execution', JSON.stringify(measured));
const roots: string[] = [], SECRET = 'SYNTHETIC-ANCESTOR-CREDENTIAL';
afterEach(async () => {
  orderedHomes.clear(); unreadable.clear(); opened.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(crowded = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-home-ancestors-')); roots.push(root);
  const home = join(root, 'home'), project = join(home, 'projects', 'active'), global = join(home, '.local', 'state', 'deckent');
  await mkdir(project, { recursive: true }); await mkdir(global, { recursive: true });
  const keys = [join(home, '.npmrc'), join(home, '.local', 'private.pem'), join(home, '.local', 'state', '.env'), join(home, 'projects', 'private.pem')];
  for (const key of keys) await writeFile(key, SECRET);
  if (crowded) for (let repo = 0; repo < 200; repo++) {
    const tree = join(home, `worktree-${repo}`); mkdirSync(tree);
    for (let file = 0; file < 101; file++) writeFileSync(join(tree, `ordinary-${file}`), 'ordinary');
    writeFileSync(join(tree, 'private.pem'), SECRET);
  }
  orderedHomes.add(home);
  const environment = { HOME: home, PATH: '/usr/bin:/bin', DECKENT_GLOBAL_HOME: global, LANG: 'en_US.UTF-8' };
  const product = resolveProductLayout({ projectRoot: project });
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, agentWorkspaceDeny(project, product, true)), scratchDir: null,
    writeFloor: isWriteApprovalFloored, repositoryWritable: true, hardFloor: agentShellHardFloor(project, product, [environment]) };
  const resolve = () => resolveBubblewrapView(layout, environment, {}, { floorReadOnly: false, open: true });
  return { home, project, global, keys, environment, layout, resolve };
}
const hidden = (path: string, view: { maskedFiles: readonly string[]; maskedDirectories: readonly string[] }) =>
  view.maskedFiles.includes(path) || view.maskedDirectories.some(dir => path === dir || path.startsWith(`${dir}/`));

describe.skipIf(process.platform !== 'linux')('HOME skip-root ancestor priority', () => {
  it('inspects state and project ancestors before 200 crowded depth-one siblings consume the budget', async () => {
    const f = await fixture(true), out = await f.resolve(); if (!out.ok) throw new Error(out.reason);
    for (const key of f.keys) expect(hidden(key, out.view), key).toBe(true);
    for (let repo = 0; repo < 200; repo++) expect(hidden(join(f.home, `worktree-${repo}`, 'private.pem'), out.view)).toBe(true);
    expect(out.view.maskedDirectories.some(path => path.startsWith(join(f.home, 'worktree-')))).toBe(true);
    expect(hidden(f.project, out.view)).toBe(false);
    for (const ancestor of [join(f.home, '.local'), join(f.home, '.local', 'state'), join(f.home, 'projects')]) {
      expect(opened.indexOf(ancestor)).toBeGreaterThan(0);
      expect(opened.indexOf(ancestor)).toBeLessThan(opened.findIndex(path => path.startsWith(join(f.home, 'worktree-'))));
      expect(out.view.maskedDirectories).not.toContain(ancestor);
    }
  });

  it.each(['.local', '.local/state', 'projects'])('still refuses an unreadable ancestor %s', async rel => {
    const f = await fixture(); unreadable.add(join(f.home, rel));
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED',
      reason: expect.stringContaining('ancestor cannot be inspected') });
  });

  it('still rejects credential symlinks inside a prioritized ancestor', async () => {
    const f = await fixture(); await symlink(f.keys[0]!, join(f.home, '.local', 'alias'));
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED',
      reason: expect.stringContaining('symbolic link points to a credential') });
  });

  it.skipIf(measured.bubblewrap.status !== 'available')('executes with crowded siblings while ancestor credentials remain unreadable and unwritable', async () => {
    const f = await fixture(true), provider = bubblewrapShellSandbox(f.layout).usable(measured);
    if (!provider.ok || !provider.realm) throw new Error('BWRAP_UNAVAILABLE');
    const result = await provider.realm.run({ command: 'cat "$HOME/.local/private.pem" "$HOME/.local/state/.env"; printf changed >> "$HOME/.local/private.pem"; echo ran > marker',
      cwd: f.project, environment: f.environment, timeoutMs: 10_000, writeFloorReadOnly: false, open: true });
    expect(result.status, result.output).toBe('exited'); expect(result.exitCode).toBe(0); expect(result.output).not.toContain(SECRET);
    for (const key of f.keys) expect(await readFile(key, 'utf8')).toBe(SECRET);
    expect(await readFile(join(f.project, 'marker'), 'utf8')).toBe('ran\n');
  });
});
