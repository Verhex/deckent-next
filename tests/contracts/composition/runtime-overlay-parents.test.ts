import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globalStateRoot } from '#platform/index.js';
import { createWorkspaceScope } from '#adapters/index.js';
import { shellSandboxCapabilities } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE } from '../../fixtures/workspace-descriptor-custody.js';

// Astra 2182 R3 (P1): a sandboxed write's missing parent directories are decided like the entry itself — a directory named like a floor or
// configuration path, or under a protected tree, is never made without a card, and nothing above it either. Real runtime service, real
// policy files, the production sandbox list and the launcher the service selects (BWRAP-SELECT), real overlay in a user namespace.
const roots: string[] = [];
afterEach(async () => { await closeModeRuntimes(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const custodyIt = it.skipIf(!WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE);
const measured = await shellSandboxCapabilities(globalStateRoot());
const ready = process.platform === 'linux' && measured.bubblewrap.status === 'available' && measured.bubblewrap.launcher?.overlay === true
  && measured.userNamespace === 'available';
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
  rule('write-op', 'operation', ['workspace.file.write'], 'allow')];
const runtime = (grants = GRANTS) => modeRuntime({ grants, mode: 'full-auto', shell: { schemaVersion: 1, realm: 'require-sandbox' } });
const workspaceFiles = (f: Awaited<ReturnType<typeof runtime>>) =>
  (f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file'") as { target_id: string; state: string }[]).map(row => row.target_id).sort();

describe.skipIf(!ready)('full-auto write set: new parent directories (Astra 2182 R3)', () => {
  custodyIt('[requires Linux /proc/self/fd custody] a floor name nested under new ordinary directories makes none of them; the root .github tree too; an ordinary file beside is applied', async () => {
    const f = await runtime();
    const result = await f.call('run_shell', { command: 'd=package.json; mkdir -p a/b/$d/c; echo bad > a/b/$d/c/x.txt; '
      + 'g=.github; mkdir -p $g/workflows; echo on > $g/workflows/x.yml; echo ok > src/ok.ts; echo done' });
    expect(result).toMatchObject({ card: false, status: 'ok' });
    expect(existsSync(join(f.project, 'a'))).toBe(false);
    expect(existsSync(join(f.project, '.github'))).toBe(false);
    expect(result.text).toContain('a/b/package.json/ (write floor: the owner approves — use edit_file/write_file)');
    expect(result.text).toContain('a/b/package.json/c/x.txt (its directory could not be created)');
    // A refused entry keeps its own reason; its directories are never decided.
    expect(result.text).toContain('.github/workflows/x.yml (write floor');
    expect(result.text).not.toContain('.github/ (');
    expect(await readFile(join(f.project, 'src', 'ok.ts'), 'utf8')).toBe('ok\n');
    expect(workspaceFiles(f)).toEqual(['src/ok.ts']);
    // The file and `a/`, `a/b/` were decided (and audited as relaxed edits) but nothing was made: the floor name below them held all back.
    const paths = f.audit().map(record => record.event.subject).filter(event => event.kind === 'permission-mode' && event.cell === 'edit-non-floor')
      .map(event => (event.summary as { path: string }).path).sort();
    expect(paths).toEqual(['a/', 'a/b/', 'a/b/package.json/c/x.txt', 'src/ok.ts']);
  }, 120_000);

  custodyIt('[requires Linux /proc/self/fd custody] ordinary new directories are made once for all their files and reported; a nested .github is an ordinary path by the T-L4 §5 contract', async () => {
    const f = await runtime();
    const result = await f.call('run_shell', { command: 'mkdir -p n1/n2 && echo f > n1/n2/f && echo g > n1/n2/g; g=.github; mkdir -p a/$g/workflows && echo on > a/$g/workflows/x.yml; echo done' });
    expect(result).toMatchObject({ card: false, status: 'ok' });
    expect(await readFile(join(f.project, 'n1', 'n2', 'g'), 'utf8')).toBe('g\n');
    // The floor's `.github/**` is anchored at the root (GitHub reads workflows only there): widening it is an owner checkpoint, not this fix.
    expect(await readFile(join(f.project, 'a', '.github', 'workflows', 'x.yml'), 'utf8')).toBe('on\n');
    expect(result.text).toContain('[deckent] write set: new directories created: ');
    for (const directory of ['n1/', 'n1/n2/', 'a/', 'a/.github/', 'a/.github/workflows/']) expect(result.text).toContain(directory);
    expect(workspaceFiles(f)).toEqual(['a/.github/workflows/x.yml', 'n1/n2/f', 'n1/n2/g']);
    const paths = f.audit().map(record => record.event.subject).filter(event => event.kind === 'permission-mode' && event.cell === 'edit-non-floor')
      .map(event => (event.summary as { path: string }).path);
    // One decision per new directory, whatever it holds.
    expect(paths.filter(path => path === 'n1/n2/').length).toBe(1);
  }, 120_000);

  it('a bare mkdir of a floor name: named literally it asks (card), hidden it reaches the write set and stays an uncreated empty directory', async () => {
    const f = await runtime();
    const named = await f.call('run_shell', { command: 'mkdir src/package.json' });
    expect(named).toMatchObject({ card: true, status: 'denied' });
    const hidden = await f.call('run_shell', { command: 'd=package.json; mkdir src/$d; echo done' });
    expect(hidden).toMatchObject({ card: false, status: 'ok' });
    expect(hidden.text).toContain('empty new directories were not created: src/package.json');
    expect(existsSync(join(f.project, 'src', 'package.json'))).toBe(false);
  }, 120_000);

  it('a company write deny makes no parent directory', async () => {
    const f = await runtime([...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], 'deny')]);
    const result = await f.call('run_shell', { command: 'mkdir -p n1/n2 && echo f > n1/n2/f; echo done' });
    expect(result).toMatchObject({ card: false, status: 'ok' });
    expect(existsSync(join(f.project, 'n1'))).toBe(false);
    // The entry's own decision refuses first; no directory is decided or made.
    expect(result.text).toContain('not applied: n1/n2/f (denied by policy)');
    expect(result.text).not.toContain('n1/ (');
    expect(workspaceFiles(f)).toEqual([]);
  }, 120_000);
});

describe('the edit tools cannot make a floor-named directory either (Astra 2182 R3)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] write_file under a missing parent fails with the custody diagnosis and makes no directory, card or not', async () => {
    for (const decision of ['deny', 'allow'] as const) {
      const f = await modeRuntime({ grants: [...GRANTS, rule('edit-tool', 'agent-tool', ['write_file'], 'require-approval', true)], mode: 'full-auto' });
      const result = await f.call('write_file', { path: 'src/package.json/payload.txt', content: 'bad\n' }, decision);
      // Before any card: descriptor hosts see the absent parent; unsupported hosts fail closed before looking it up.
      const reason = WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE ? 'parent-not-found' : 'parent-platform-unsupported';
      expect(result).toMatchObject({ card: false, status: 'error', text: `[deckent] write_file: error=${reason}` });
      expect(existsSync(join(f.project, 'src', 'package.json'))).toBe(false);
      const nested = await f.call('write_file', { path: 'src/new/package.json', content: '{}\n' }, decision);
      expect(nested).toMatchObject({ card: false, status: 'error', text: `[deckent] write_file: error=${reason}` });
      expect(existsSync(join(f.project, 'src', 'new'))).toBe(false);
    }
  }, 120_000);

  custodyIt('[requires Linux /proc/self/fd custody] the same grants write an ordinary file under an existing directory', async () => {
    for (const decision of ['deny', 'allow'] as const) {
      const f = await modeRuntime({ grants: [...GRANTS, rule('edit-tool', 'agent-tool', ['write_file'], 'require-approval', true)], mode: 'full-auto' });
      expect(await f.call('write_file', { path: 'src/fine.ts', content: 'ok\n' }, decision)).toMatchObject({ status: 'ok' });
      expect(await readFile(join(f.project, 'src', 'fine.ts'), 'utf8')).toBe('ok\n');
    }
  }, 120_000);

  it('the write-set path rules classify a new directory by its own name and as a tree, the configuration name included', async () => {
    const { classifySandboxWritePath } = await import('#adapters/core/agent-workspace-floor/index.js');
    const root = await mkdtemp(join(tmpdir(), 'deckent-directory-classification-')); roots.push(root);
    const scope = await createWorkspaceScope(root);
    const authority = (rel: string) => rel.startsWith('cfg.json');
    expect(classifySandboxWritePath(scope, authority, 'src/package.json', 'mkdir')).toBe('edit-floor');
    expect(classifySandboxWritePath(scope, authority, '.github', 'mkdir')).toBe('edit-floor');
    expect(classifySandboxWritePath(scope, authority, 'a/.husky', 'mkdir')).toBe('edit-floor');
    expect(classifySandboxWritePath(scope, authority, 'cfg.json', 'mkdir')).toBe('edit-authority');
    expect(classifySandboxWritePath(scope, authority, '.git', 'mkdir')).toBe('denied');
    expect(classifySandboxWritePath(scope, authority, 'src/new', 'mkdir')).toBe('edit');
    // A file keeps the file rules: `.github` as a file name is not the tree.
    expect(classifySandboxWritePath(scope, authority, '.github', 'write')).toBe('edit');
  }, 60_000);
});
