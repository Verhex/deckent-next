import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentShellHardFloor, agentWorkspaceDeny, createWorkspaceScope, isWriteApprovalFloored, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const measured = await measureTestShellHost();
if (measured.bubblewrap.status !== 'available') console.info('verify-not-run: HOME execution', JSON.stringify(measured));
const roots: string[] = [];
const SECRET = 'SYNTHETIC-HOME-CREDENTIAL-ONLY';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-home-walk-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), global = join(home, '.deckent');
  await mkdir(project); await mkdir(global, { recursive: true });
  const environment = { HOME: home, PATH: '/usr/bin:/bin', DECKENT_GLOBAL_HOME: global, LANG: 'en_US.UTF-8' };
  const product = resolveProductLayout({ projectRoot: project });
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, agentWorkspaceDeny(project, product, true)), scratchDir: null,
    writeFloor: isWriteApprovalFloored, repositoryWritable: true, hardFloor: agentShellHardFloor(project, product, [environment]) };
  const resolve = (env = environment) => resolveBubblewrapView(layout, env, {}, { floorReadOnly: false, open: true });
  const secret = async (rel: string) => { const path = join(home, rel); await mkdir(dirname(path), { recursive: true }); await writeFile(path, SECRET); return path; };
  return { root, project, home, global, environment, layout, resolve, secret };
}
function largeWorktrees(home: string) {
  for (let repo = 0; repo < 5; repo++) {
    const path = join(home, 'worktrees', `repo-${repo}`); mkdirSync(path, { recursive: true });
    for (let file = 0; file < 10_020; file++) writeFileSync(join(path, `ordinary-${file}.txt`), 'ordinary');
    writeFileSync(join(path, 'private.pem'), SECRET);
  }
}
const hidden = (path: string, view: { maskedFiles: readonly string[]; maskedDirectories: readonly string[] }) =>
  view.maskedFiles.includes(path) || view.maskedDirectories.some(dir => path === dir || path.startsWith(`${dir}/`));

describe.skipIf(process.platform !== 'linux')('bounded HOME credential protection', () => {
  it('accepts 50,100 ordinary files in worktrees and hides every shallow credential, including in pruned trees', async () => {
    const f = await fixture(); largeWorktrees(f.home);
    const keys = await Promise.all(['.npmrc', 'folder/key.pem', 'a/b/.env', '.ssh/id_ed25519', '.config/gcloud/deep/nested/token',
      '.local/share/keyrings/deep/token', '.gnupg/private-keys-v1.d/key', '.config/git/credentials', '.docker/config.json', '.aws/credentials'].map(f.secret));
    const out = await f.resolve(); if (!out.ok) throw new Error(out.reason);
    for (const path of [...keys, ...Array.from({ length: 5 }, (_, repo) => join(f.home, 'worktrees', `repo-${repo}`, 'private.pem'))])
      expect({ path, hidden: hidden(path, out.view) }).toEqual({ path, hidden: true });
    expect(out.view.maskedDirectories.some(path => path.startsWith(join(f.home, 'worktrees')))).toBe(true);
    expect(hidden(f.project, out.view)).toBe(false);
  });

  it('protects literal registry paths beyond depth three without scanning their contents', async () => {
    const f = await fixture();
    const keys = await Promise.all(['.gnupg/a/b/c/d/token', '.local/share/keyrings/a/b/c/token', '.config/gcloud/a/b/c/token', '.codex/auth.json'].map(f.secret));
    const out = await f.resolve(); if (!out.ok) throw new Error(out.reason);
    for (const path of keys) expect(hidden(path, out.view)).toBe(true);
  });

  it.each(['.npmrc', '.aws', '.config'])('refuses a symlink at known credential component %s', async rel => {
    const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.home, rel));
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED', reason: expect.stringMatching(/symbolic link/u) });
  });

  it.each(['a/b/private.pem', 'a/b/c/deep.pem'])('refuses a harmlessly named symlink to HOME credential %s', async rel => {
    const f = await fixture(); const key = await f.secret(rel); await symlink(key, join(f.home, 'ordinary.txt'));
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED' });
  });

  it('refuses a harmlessly named symlink to a credential outside HOME', async () => {
    const f = await fixture(); const key = join(f.root, 'private.pem'); await writeFile(key, SECRET); await symlink(key, join(f.home, 'ordinary.txt'));
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED' });
  });

  it('refuses an undeterminable HOME root with actionable English and Turkish catalog text', async () => {
    const f = await fixture(); const fake = join(f.root, 'not-a-directory'); await writeFile(fake, 'ordinary');
    const english = await f.resolve({ ...f.environment, HOME: fake });
    expect(english).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED', reason: expect.stringContaining('repair HOME/credential paths') });
    const turkish = await f.resolve({ ...f.environment, HOME: fake, LANG: 'tr_TR.UTF-8' });
    expect(turkish).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED', reason: expect.stringContaining('yollarını düzeltip yeniden deneyin') });
  });

  it('still refuses an oversized HOME root instead of lifting the entry bound', async () => {
    const f = await fixture();
    for (let file = 0; file < 20_001; file++) writeFileSync(join(f.home, `ordinary-${file}`), 'ordinary');
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED' });
  });

  it('refuses an open view with no HOME rather than silently omitting credential protection', async () => {
    const f = await fixture();
    expect(await resolveBubblewrapView(f.layout, {}, {}, { open: true })).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED' });
  });

  it('refuses when hiding an oversized subtree would also hide the active project', async () => {
    const f = await fixture(); const work = join(f.home, 'work'), project = join(work, 'project'); await mkdir(project, { recursive: true });
    for (let file = 0; file < 20_001; file++) writeFileSync(join(work, `ordinary-${file}`), 'ordinary');
    const product = resolveProductLayout({ projectRoot: project });
    const layout: ShellSandboxLayout = { ...f.layout, project: await createWorkspaceScope(project, agentWorkspaceDeny(project, product, true)),
      hardFloor: agentShellHardFloor(project, product, [f.environment]) };
    expect(await resolveBubblewrapView(layout, f.environment, {}, { open: true })).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED' });
  });

  it('still refuses when the credential hiding set exceeds the mask bound', async () => {
    const f = await fixture(); await mkdir(join(f.home, 'keys'));
    for (let file = 0; file < 4_097; file++) writeFileSync(join(f.home, 'keys', `${file}.pem`), SECRET);
    expect(await f.resolve()).toMatchObject({ ok: false, code: 'SHELL_HOME_CREDENTIALS_UNDETERMINED', reason: expect.stringContaining('mask bound') });
  });

  it.skipIf(measured.bubblewrap.status !== 'available')('executes the open sandbox with large HOME while credential bytes and writes remain blocked', async () => {
    const f = await fixture(); largeWorktrees(f.home); const key = await f.secret('.npmrc');
    const provider = bubblewrapShellSandbox(f.layout).usable(measured); if (!provider.ok || !provider.realm) throw new Error('BWRAP_UNAVAILABLE');
    const result = await provider.realm.run({ command: 'cat "$HOME/.npmrc"; for key in "$HOME"/worktrees/repo-*/private.pem; do cat "$key"; done; printf changed >> "$HOME/.npmrc"; echo ran > marker',
      cwd: f.project, environment: f.environment, timeoutMs: 10_000, writeFloorReadOnly: false, open: true });
    expect(result.status, result.output).toBe('exited'); expect(result.exitCode).toBe(0); expect(result.output).not.toContain(SECRET);
    expect(await readFile(key, 'utf8')).toBe(SECRET); expect(await readFile(join(f.project, 'marker'), 'utf8')).toBe('ran\n');
  });
});
