import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeShellCapabilities, type ShellSandboxFactory } from '#adapters/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// SHELL-OVERLAY (owner 2026-09-29: the permanent C5 answer — a sandboxed write cannot create a new floor name without a card). A full-auto
// shell call past the narrow set writes into an overlay; at its end each change is decided like an edit of that path and applied as its
// own `workspace.file.write` effect. Real runtime service, real policy files, real bubblewrap 0.13 (the reproducible build staged in the
// gitignored `.pack/`), real overlay in a user namespace.
afterEach(closeModeRuntimes);
const PACK_BWRAP = join(import.meta.dirname, '../../../.pack/bwrap/x86_64/bwrap');
const measured = await probeShellCapabilities();
const ready = process.platform === 'linux' && measured.bubblewrap === 'available' && measured.userNamespace === 'available' && existsSync(PACK_BWRAP);
const bwrap013: ShellSandboxFactory = layout => [bubblewrapShellSandbox(layout, { binaryPaths: [PACK_BWRAP] })];
/** The live shape plus the first-run template's write operation grant (what an edit's operation side needs). */
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
  rule('write-op', 'operation', ['workspace.file.write'], 'allow')];
const runtime = (mode: 'full-auto' | 'auto-edit' = 'full-auto', grants = GRANTS, shell: Record<string, unknown> = {}) =>
  modeRuntime({ grants, mode, shell: { schemaVersion: 1, realm: 'require-sandbox', ...shell }, sandboxes: bwrap013 });

describe.skipIf(!ready)('full-auto sandbox write set (SHELL-OVERLAY, C5)', () => {
  it('a new floor name is not written; ordinary changes, a rename and an opaque directory are applied, each audited like an edit', async () => {
    const f = await runtime();
    await mkdir(join(f.project, 'sub', 'deep'), { recursive: true });
    await writeFile(join(f.project, 'sub', 'deep', 'f'), 'f\n'); await writeFile(join(f.project, 'src', 'gone.ts'), 'gone\n');
    const result = await f.call('run_shell', { command: 'f=pack; echo \'{"name":"x"}\' > src/${f}age.json; echo new > src/x.ts; chmod +x src/x.ts; '
      + 'mv src/gone.ts src/moved.ts; d=deep; mv sub/$d sub/old && mkdir sub/$d && echo z > sub/$d/z; g=.en; echo SECRET=1 > ${g}v; echo done' });
    expect(result).toMatchObject({ card: false, status: 'ok' });
    expect(result.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    // C5: the floor name the classifier could not see never reaches the project, and the model is told how it can.
    expect(existsSync(join(f.project, 'src', 'package.json'))).toBe(false);
    expect(result.text).toContain('src/package.json (write floor: the owner approves — use edit_file/write_file)');
    // A new name on the deny floor (the read floor: `.env`) is not applied either.
    expect(result.text).toContain('.env (denied path)');
    expect(existsSync(join(f.project, '.env'))).toBe(false);
    expect(await readFile(join(f.project, 'src', 'x.ts'), 'utf8')).toBe('new\n');
    expect(existsSync(join(f.project, 'src', 'gone.ts'))).toBe(false);
    expect(await readFile(join(f.project, 'src', 'moved.ts'), 'utf8')).toBe('gone\n');
    expect(await readdir(join(f.project, 'sub', 'deep'))).toEqual(['z']);
    expect(await readFile(join(f.project, 'sub', 'old', 'f'), 'utf8')).toBe('f\n');
    expect(result.text).toMatch(/write set: applied 6 \(/u);
    const events = f.audit().map(record => record.event.subject);
    expect(events[0]).toMatchObject({ kind: 'permission-mode', mode: 'full-auto', cell: 'shell-modify' });
    const edits = events.slice(1);
    expect(edits.every(event => event.kind === 'permission-mode' && event.cell === 'edit-non-floor' && (event.tool as { name: string }).name === 'run_shell')).toBe(true);
    expect(edits.map(event => (event.summary as { path: string }).path).sort()).toEqual(['src/gone.ts', 'src/moved.ts', 'src/x.ts', 'sub/deep/f', 'sub/deep/z', 'sub/old/f']);
    // Each applied entry is its own settled C11 record of the project write operation; nothing is left in the private directory.
    const records = f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file'") as { target_id: string; state: string }[];
    expect(records.length).toBe(6);
    expect(records.every(row => row.state === 'settled')).toBe(true);
  }, 120_000);

  it('a company rule that denies project writes keeps every change out; the command still ran', async () => {
    const f = await runtime('full-auto', [...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], 'deny')]);
    const result = await f.call('run_shell', { command: 'f=x; echo new > src/$f.ts; echo done' });
    expect(result).toMatchObject({ card: false, status: 'ok' });
    expect(result.text).toContain('not applied: src/x.ts (denied by policy)');
    expect(existsSync(join(f.project, 'src', 'x.ts'))).toBe(false);
  }, 120_000);

  it('the project changing under the call applies nothing; a stopped run applies nothing', async () => {
    const f = await runtime();
    const running = f.call('run_shell', { command: 'f=a; sleep 1; echo mine >> src/$f.ts; echo new > src/y.ts' });
    // Once the call's private directory exists the mark is taken; the owner's editor then writes the same file.
    const writes = join(f.data, 'state', 'file-effects', 'sandbox-writes');
    for (let tries = 0; tries < 200 && (await readdir(writes).catch(() => [])).length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 200));
    await writeFile(join(f.project, 'src', 'a.ts'), 'theirs\n');
    const result = await running;
    expect(result.text).toContain('nothing was applied — the project changed during the call: src/a.ts');
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('theirs\n');
    expect(existsSync(join(f.project, 'src', 'y.ts'))).toBe(false);
    // A run that timed out kept its writes aside and none reached the project; its private directory is gone.
    const g = await runtime('full-auto', GRANTS, { timeoutMs: 1_500 });
    const stopped = await g.call('run_shell', { command: 'f=x; echo new > src/$f.ts; sleep 20' });
    expect(stopped.status).toBe('error');
    expect(stopped.text).toContain('what it changed was kept aside and not applied');
    expect(existsSync(join(g.project, 'src', 'x.ts'))).toBe(false);
    expect(await readdir(join(g.data, 'state', 'file-effects', 'sandbox-writes'))).toEqual([]);
  }, 120_000);

  it('outside a full-auto relaxation nothing changes: standart asks, and the owner-approved call writes directly (no write set)', async () => {
    const f = await runtime('auto-edit');
    const result = await f.call('run_shell', { command: 'f=x; echo new > src/$f.ts' }, 'allow');
    expect(result).toMatchObject({ card: true, status: 'ok' });
    expect(result.text).not.toContain('write set');
    expect(await readFile(join(f.project, 'src', 'x.ts'), 'utf8')).toBe('new\n');
  }, 120_000);

  // Astra 2180 R1: a directory the command removed is an entry like a file — classified, decided, its own C11 effect, reported — never a
  // direct removal beside the write-set path.
  describe('directory removals go through the same boundary as files (Astra 2180 R1)', () => {
    const effects = (f: Awaited<ReturnType<typeof runtime>>) => f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file' ORDER BY target_id") as { target_id: string; state: string }[];
    it('policy deny: nothing is removed and the report holds it back; allow: the empty directory and a whole tree are removed, each as its own effect', async () => {
      const denied = await runtime('full-auto', [...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], 'deny')]);
      await mkdir(join(denied.project, 'src', 'empty'));
      const held = await denied.call('run_shell', { command: 'd=empty; mv src/$d /tmp/gone; echo done' });
      expect(held).toMatchObject({ card: false, status: 'ok' });
      expect(held.text).toContain('not applied: src/empty/ (denied by policy)');
      expect(existsSync(join(denied.project, 'src', 'empty'))).toBe(true);
      expect(effects(denied)).toEqual([]);
      const f = await runtime();
      await mkdir(join(f.project, 'src', 'empty')); await mkdir(join(f.project, 'src', 'tree', 'sub'), { recursive: true });
      await writeFile(join(f.project, 'src', 'tree', 'a'), 'a\n'); await writeFile(join(f.project, 'src', 'tree', 'sub', 'b'), 'b\n');
      const removed = await f.call('run_shell', { command: 'd=empty; t=tree; mv src/$d /tmp/gone && mv src/$t /tmp/tree; echo done' });
      expect(removed).toMatchObject({ card: false, status: 'ok' });
      expect(removed.text).toContain('write set: applied 5 (');
      for (const name of ['src/empty/', 'src/tree/', 'src/tree/sub/', 'src/tree/a', 'src/tree/sub/b']) expect(removed.text).toContain(name);
      expect(existsSync(join(f.project, 'src', 'empty'))).toBe(false); expect(existsSync(join(f.project, 'src', 'tree'))).toBe(false);
      expect(effects(f)).toEqual(['src/empty', 'src/tree', 'src/tree/a', 'src/tree/sub', 'src/tree/sub/b'].map(target_id => ({ target_id, state: 'settled' })));
      const paths = f.audit().map(record => record.event.subject).filter(event => event.cell === 'edit-non-floor').map(event => (event.summary as { path: string }).path).sort();
      expect(paths).toEqual(['src/empty', 'src/tree', 'src/tree/a', 'src/tree/sub', 'src/tree/sub/b']);
    }, 120_000);

    it('a floor directory is never removed: read-only in the view, or held back by the write set; a stopped run removes nothing', async () => {
      const f = await runtime('full-auto', GRANTS, { timeoutMs: 1_500 });
      // An existing floor tree is bound read-only in the view (defense in depth): the removal fails there already.
      await mkdir(join(f.project, '.github', 'workflows'), { recursive: true });
      const bound = await f.call('run_shell', { command: 'd=.github; mv $d /tmp/g; echo done' });
      expect(bound.text).toContain('Read-only file system');
      expect(existsSync(join(f.project, '.github', 'workflows'))).toBe(true);
      // A directory whose own name is on the floor (`Makefile`) is not bound read-only as a tree: its removal reaches the write set and is
      // held back by the same classification as a file of that name.
      await mkdir(join(f.project, 'Makefile'));
      const floor = await f.call('run_shell', { command: 'd=Make; mv ${d}file /tmp/m; echo done' });
      expect(floor).toMatchObject({ card: false, status: 'ok' });
      expect(floor.text).toContain('not applied: Makefile/ (write floor: the owner approves');
      expect(existsSync(join(f.project, 'Makefile'))).toBe(true);
      await mkdir(join(f.project, 'src', 'empty'));
      const stopped = await f.call('run_shell', { command: 'd=empty; mv src/$d /tmp/gone; sleep 20' });
      expect(stopped.status).toBe('error');
      expect(stopped.text).toContain('kept aside and not applied');
      expect(existsSync(join(f.project, 'src', 'empty'))).toBe(true);
      expect(effects(f)).toEqual([]);
    }, 120_000);

    it('a lower directory that changed during the call (a file added to it) is a conflict: nothing is applied', async () => {
      const f = await runtime();
      await mkdir(join(f.project, 'src', 'empty'));
      const running = f.call('run_shell', { command: 'd=empty; mv src/$d /tmp/gone; echo new > src/other.ts; sleep 1' });
      const writes = join(f.data, 'state', 'file-effects', 'sandbox-writes');
      for (let tries = 0; tries < 200 && (await readdir(writes).catch(() => [])).length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 200));
      await writeFile(join(f.project, 'src', 'empty', 'theirs.txt'), 'theirs\n');
      const result = await running;
      expect(result.text).toContain('nothing was applied — the project changed during the call: src/empty');
      expect(await readFile(join(f.project, 'src', 'empty', 'theirs.txt'), 'utf8')).toBe('theirs\n');
      expect(existsSync(join(f.project, 'src', 'other.ts'))).toBe(false);
      expect(effects(f)).toEqual([]);
    }, 120_000);
  });
});
