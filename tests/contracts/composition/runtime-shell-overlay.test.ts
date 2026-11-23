import { toolErrorClass } from '#capabilities/index.js';
import { createAgentShell } from '#composition/core/agent-turn/index.js';
import * as adapters from '#adapters/index.js';
import { createWorkspaceScope, readTerminalShellConfig, runHostShell } from '#adapters/index.js';
import { agentToolArgumentsDigest, agentToolCallApprovalGate, refuseRequiredApproval } from '#engine/index.js';
import { failEffectRecordWrite, observeToolOutcomes, toolProducer } from '../support/tool-producer.js';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalStateRoot, SystemTrustedClock } from '#platform/index.js';
import { shellSandboxCapabilities } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// SHELL-OVERLAY (owner 2026-09-29: the permanent C5 answer — a sandboxed write cannot create a new floor name without a card). A full-auto
// shell call past the narrow set writes into an overlay; at its end each change is decided like an edit of that path and applied as its
// own `workspace.file.write` effect. Real runtime service, real policy files, the production sandbox list and the launcher the service
// itself selects (BWRAP-SELECT: the measurement under the global state root — the test run's temporary DECKENT_GLOBAL_HOME, vitest.config),
// real overlay in a user namespace. Nothing test-only chooses the launcher: this is the production path that makes overlay active.
afterEach(closeModeRuntimes);
const measured = await shellSandboxCapabilities(globalStateRoot());
const ready = process.platform === 'linux' && measured.bubblewrap.status === 'available' && measured.bubblewrap.launcher?.overlay === true
  && measured.userNamespace === 'available';
/** The live shape plus the first-run template's write operation grant (what an edit's operation side needs). */
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
  rule('write-op', 'operation', ['workspace.file.write'], 'allow')];
const runtime = (mode: 'full-auto' | 'auto-edit' = 'full-auto', grants = GRANTS, shell: Record<string, unknown> = {}) =>
  modeRuntime({ grants, mode, shell: { schemaVersion: 1, realm: 'require-sandbox', ...shell } });
/**
 * CI-KARARLILIK: waits (20 ms polls, 10 s bound) until a running call's private directory holds `rel`, the observable point an owner's
 * concurrent write must follow. `work`: the start mark is taken (the directory's ctime once `upper` and `work` exist). `upper/<path>`: the
 * sandboxed command already wrote or removed that path (a removal is a whiteout there). A fixed wait after the directory appeared raced
 * the sandbox's setup on a loaded runner: the owner's file landed before the command's `rm -d`, which then failed, so nothing conflicted.
 */
async function callReached(f: { readonly data: string }, rel: string) {
  const writes = join(f.data, 'state', 'file-effects', 'sandbox-writes');
  for (let tries = 0; tries < 500; tries++) {
    for (const call of await readdir(writes).catch(() => [] as string[])) if (await lstat(join(writes, call, rel)).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`no running call's write-set directory holds ${rel}`);
}

it.skipIf(process.platform !== 'linux')('shell producer keeps the exit and vetoes continuation on a missing required audit', async () => {
  const f = await toolProducer([rule('shell-run', 'operation', ['host.shell.run'], 'allow')]), root = join(f.data, 'writes'); await mkdir(root);
  const shell = createAgentShell({ ...f, scope: await createWorkspaceScope(f.project), config: readTerminalShellConfig({}), productState: [], scratch: null,
    channel: { signal: f.signal, emit() {}, async drained() { return true; }, room: () => 65_536 }, writeSetRoot: async () => root,
    sandboxes: [{ kind: 'bubblewrap', usable: () => ({ ok: true, containment: 'sandbox', marker: 'fixture', notice: null, posture: () => '', writeSets: true,
      realm: { kind: 'bubblewrap', run: request => runHostShell({ cwd: request.cwd, command: request.command, signal: f.signal }) } }) }] });
  const report = { applied: [], notApplied: [], conflicts: [], unknown: [], createdDirectories: [], emptyDirectories: [], stopped: false, refused: null, clock: null };
  const settlement = vi.spyOn(adapters, 'applySandboxWriteSet').mockResolvedValueOnce(report)
    .mockResolvedValue({ ...report, notApplied: [{ rel: 'protected.txt', reason: 'audit-unavailable' }] });
  try {
    const observed = [];
    for (const [index, exit] of [7, 7, 0].entries()) {
      const result = await shell.apply('run_shell', { command: `exit ${exit}` }, f.signal, `call-${index}`, { round: 1, index }, refuseRequiredApproval,
        'owner-approved', { async decide() { throw new Error('unexpected write'); } });
      expect(result).toMatchObject({ cleanup: 'clean', text: expect.stringContaining(`exit ${exit} after`) });
      observed.push(result.status === 'ok' ? 'ok' : toolErrorClass(result));
    }
    expect(settlement).toHaveBeenCalledTimes(3);
    expect(observed).toEqual(['ordinary', 'uncertain', 'uncertain']);
  } finally { settlement.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('WER-A spawn refusal requires its effect record', async () => {
  const f = await toolProducer([rule('shell-run', 'operation', ['host.shell.run'], 'allow')]);
  const launch = vi.fn(async () => ({ status: 'spawn-failed' as const, exitCode: null, signal: null, output: 'fixture spawn refused',
    totalBytes: 21, omittedBytes: 0, durationMs: 0, cleanup: 'clean' as const }));
  const shell = createAgentShell({ ...f, scope: await createWorkspaceScope(f.project), config: readTerminalShellConfig({}), productState: [], scratch: null,
    channel: { signal: f.signal, emit() {}, async drained() { return true; }, room: () => 65_536 },
    sandboxes: [{ kind: 'bubblewrap', usable: () => ({ ok: true, containment: 'sandbox', marker: 'fixture', notice: null, posture: () => '',
      realm: { kind: 'bubblewrap', run: launch } }) }] });
  const apply = (index: number) => shell.apply('run_shell', { command: 'exit 7' }, f.signal, `call-${index}`, { round: 1, index }, refuseRequiredApproval);
  const recorded = await apply(0);
  failEffectRecordWrite(f.ledger);
  const unrecorded = await apply(1);
  expect(f.rows('SELECT state FROM effect_intents ORDER BY rowid')).toEqual([{ state: 'refused' }, { state: 'claimed' }]);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(unrecorded).toMatchObject({ status: 'error', text: expect.stringContaining('fixture spawn refused') });
  expect([toolErrorClass(recorded), toolErrorClass(unrecorded)]).toEqual(['ordinary', 'uncertain']);
});

it.skipIf(process.platform !== 'linux')('WER-A the inner effect approval gate has no call-time refusal evidence', async () => {
  const f = await toolProducer([rule('shell-run', 'operation', ['host.shell.run'], 'require-approval')]);
  const shell = createAgentShell({ ...f, scope: await createWorkspaceScope(f.project), config: readTerminalShellConfig({ terminal: { shell: { schemaVersion: 1, realm: 'host' } } }),
    productState: [], scratch: null, sandboxes: [], channel: { signal: f.signal, emit() {}, async drained() { return true; }, room: () => 65_536 } });
  const args = { command: 'exit 7' }, position = { round: 1, index: 0 };
  const gate = agentToolCallApprovalGate(async () => { throw new Error('no approval was requested'); }, new SystemTrustedClock(), {
    scopeId: f.scopeId, approval: null, subject: { kind: 'agent-tool-call', turnId: f.turnId, ...position,
      tool: 'run_shell', toolVersion: 1, resource: '(no target)', argsDigest: agentToolArgumentsDigest('run_shell', args) } }, new Map());
  const result = await shell.apply('run_shell', args, f.signal, 'call-gate', position, gate);
  expect(result).toMatchObject({ status: 'error', text: expect.stringContaining('approval') });
  expect(f.rows('SELECT state FROM effect_intents')).toEqual([]);
  expect(toolErrorClass(result)).toBe('uncertain');
});

it.skipIf(process.platform !== 'linux')('WER-A a missing child effect record closes continuation for exit zero and nonzero', async () => {
  const f = await toolProducer([rule('shell-run', 'operation', ['host.shell.run'], 'allow'), rule('write-op', 'operation', ['workspace.file.write'], 'allow')]);
  const root = join(f.data, 'writes'); await mkdir(root);
  const shell = createAgentShell({ ...f, scope: await createWorkspaceScope(f.project), config: readTerminalShellConfig({}), productState: [], scratch: null,
    channel: { signal: f.signal, emit() {}, async drained() { return true; }, room: () => 65_536 }, writeSetRoot: async () => root,
    sandboxes: [{ kind: 'bubblewrap', usable: () => ({ ok: true, containment: 'sandbox', marker: 'fixture', notice: null, posture: () => '', writeSets: true,
      realm: { kind: 'bubblewrap', async run(request) {
        const path = request.command === 'exit 0' ? 'first.txt' : 'second.txt';
        await writeFile(join(request.writeSet!.upper, path), 'written\n');
        return runHostShell({ cwd: request.cwd, command: request.command, signal: f.signal });
      } } }) }] });
  const db = new DatabaseSync(f.ledger);
  try { db.exec("CREATE TRIGGER child_unavailable BEFORE UPDATE ON effect_intents WHEN NEW.target_kind = 'workspace-file' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END"); }
  finally { db.close(); }
  const observed = [];
  for (const [index, [path, exit]] of ([['first.txt', 0], ['second.txt', 7]] as const).entries()) {
    const result = await shell.apply('run_shell', { command: `exit ${exit}` }, f.signal, `call-${index}`, { round: 1, index }, refuseRequiredApproval, 'owner-approved',
      { async decide() { return { ok: true, gate: refuseRequiredApproval }; } });
    expect(result.text).toContain(`exit ${exit} after`);
    expect(result.text).toContain(`outcome unknown (read the file to see its state): ${path}`);
    expect(await readFile(join(f.project, path), 'utf8')).toBe('written\n');
    observed.push(result.status === 'ok' ? 'ok' : toolErrorClass(result));
  }
  expect(f.rows('SELECT target_kind, state FROM effect_intents ORDER BY rowid')).toEqual([
    { target_kind: 'host-shell', state: 'settled' }, { target_kind: 'workspace-file', state: 'claimed' },
    { target_kind: 'host-shell', state: 'settled' }, { target_kind: 'workspace-file', state: 'claimed' }]);
  expect(observed).toEqual(['uncertain', 'uncertain']);
});

describe.skipIf(!ready)('full-auto sandbox write set (SHELL-OVERLAY, C5)', () => {
  it('a new floor name is not written; ordinary changes, file copies/removals and a new directory are applied, each audited like an edit', async () => {
    const f = await runtime();
    await mkdir(join(f.project, 'sub', 'deep'), { recursive: true });
    await writeFile(join(f.project, 'sub', 'deep', 'f'), 'f\n'); await writeFile(join(f.project, 'src', 'gone.ts'), 'gone\n');
    const command = 'f=pack; echo \'{"name":"x"}\' >> src/${f}age.json; echo new >> src/x.ts; chmod +x src/x.ts; '
      + 'cp src/gone.ts src/moved.ts && rm src/gone.ts; d=deep; cp -r sub/$d sub/old && rm sub/$d/f && echo z >> sub/$d/z; g=.en; echo SECRET=1 >> ${g}v; echo done';
    const result = await f.call('run_shell', { command });
    expect(result).toMatchObject({ card: false, status: 'error' });
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
    const subjects = f.audit().map(record => record.event.subject);
    const events = subjects.filter(subject => subject.kind !== 'access-refusal-summary');
    expect(events[0]).toMatchObject({ kind: 'permission-mode', mode: 'full-auto', cell: 'shell-modify' });
    const edits = events.slice(1);
    expect(edits.every(event => event.kind === 'permission-mode' && event.cell === 'edit-non-floor' && (event.tool as { name: string }).name === 'run_shell')).toBe(true);
    // A copied directory is a new overlay entry: decided (and audited)
    // like an entry, shown as `sub/old/`, made before its file; it is not an effect of its own.
    expect(edits.map(event => (event.summary as { path: string }).path).sort()).toEqual(['src/gone.ts', 'src/moved.ts', 'src/x.ts', 'sub/deep/f', 'sub/deep/z', 'sub/old/', 'sub/old/f']);
    const refusals = subjects.filter(subject => subject.kind === 'access-refusal-summary');
    expect(refusals).toEqual([expect.objectContaining({
      turnId: result.turnId, decisionSource: 'deckent-decision', evidenceBasis: 'shell-write-set',
      reasonCode: 'AGENT_TOOL_APPROVAL_REQUIRED', operationClass: 'write', count: 1,
      target: { role: 'workspace-file', identity: null },
    })]);
    const serializedRefusals = JSON.stringify(refusals);
    for (const privateText of [command, 'SECRET=1', 'src/package.json', '.env', 'src/gone.ts', 'src/moved.ts', 'src/x.ts', 'sub/deep/', 'sub/old/']) {
      expect(serializedRefusals).not.toContain(JSON.stringify(privateText).slice(1, -1));
    }
    expect(result.text).toContain('[deckent] write set: new directories created: sub/old/.');
    // Each applied entry is its own settled C11 record of the project write operation; nothing is left in the private directory.
    const records = f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file'") as { target_id: string; state: string }[];
    expect(records.length).toBe(6);
    expect(records.every(row => row.state === 'settled')).toBe(true);
  }, 120_000);

  it('a company rule that denies project writes keeps every change out; the command still ran', async () => {
    const f = await runtime('full-auto', [...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], 'deny')]), observed = observeToolOutcomes();
    const result = await f.call('run_shell', { command: 'f=x; echo new >> src/$f.ts; echo done' });
    expect(result).toMatchObject({ card: false, status: 'error' });
    expect(observed).toEqual(['uncertain']);
    expect(result.text).toContain('not applied: src/x.ts (denied by policy)');
    expect(existsSync(join(f.project, 'src', 'x.ts'))).toBe(false);
  }, 120_000);

  it('the project changing under the call applies nothing; a stopped run applies nothing', async () => {
    const f = await runtime();
    const running = f.call('run_shell', { command: 'f=a; sleep 1; echo mine >> src/$f.ts; echo new >> src/y.ts' });
    // Once the call's private directory holds `work` the mark is taken; the owner's editor then writes the same file (the command sleeps first).
    await callReached(f, 'work');
    await writeFile(join(f.project, 'src', 'a.ts'), 'theirs\n');
    const result = await running;
    expect(result.text).toContain('nothing was applied — the project changed during the call: src/a.ts');
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('theirs\n');
    expect(existsSync(join(f.project, 'src', 'y.ts'))).toBe(false);
    // A run that timed out kept its writes aside and none reached the project; its private directory is gone.
    const g = await runtime('full-auto', GRANTS, { timeoutMs: 1_500 });
    const stopped = await g.call('run_shell', { command: 'f=x; echo new >> src/$f.ts; sleep 20' });
    expect(stopped.status).toBe('error');
    expect(stopped.text).toContain('what it changed was kept aside and not applied');
    expect(existsSync(join(g.project, 'src', 'x.ts'))).toBe(false);
    expect(await readdir(join(g.data, 'state', 'file-effects', 'sandbox-writes'))).toEqual([]);
  }, 120_000);

  it('outside a full-auto relaxation nothing changes: standart asks, and the owner-approved call writes directly (no write set)', async () => {
    const f = await runtime('auto-edit');
    const result = await f.call('run_shell', { command: 'f=x; echo new >> src/$f.ts' }, 'allow');
    expect(result).toMatchObject({ card: true, status: 'ok' });
    expect(result.text).not.toContain('write set');
    expect(await readFile(join(f.project, 'src', 'x.ts'), 'utf8')).toBe('new\n');
  }, 120_000);

  // W3: moving directory trees is destructive. It is denied before an overlay or project effect exists.
  describe('directory moves require approval before the write-set boundary', () => {
    const effects = (f: Awaited<ReturnType<typeof runtime>>) => f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file'");
    it('workspace policy allow or deny never silently admits removal by a move', async () => {
      for (const verdict of ['allow', 'deny'] as const) {
        const f = await runtime('full-auto', [...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], verdict)]);
        await mkdir(join(f.project, 'src/empty'));
        await mkdir(join(f.project, 'src/tree/sub'), { recursive: true });
        await writeFile(join(f.project, 'src/tree/sub/a'), 'original');
        const result = await f.call('run_shell', { command: 'd=empty; t=tree; mv src/$d /tmp/gone && mv src/$t /tmp/tree' });
        expect(result).toMatchObject({ card: true, status: 'denied' });
        expect(await readFile(join(f.project, 'src/tree/sub/a'), 'utf8')).toBe('original');
        expect(existsSync(join(f.project, 'src/empty'))).toBe(true);
        expect(effects(f)).toEqual([]);
      }
    }, 120_000);
    it('moves of floor directories and a move followed by a long command are denied before execution', async () => {
      const f = await runtime('full-auto', GRANTS, { timeoutMs: 1_500 });
      await mkdir(join(f.project, '.github/workflows'), { recursive: true });
      await mkdir(join(f.project, 'Makefile'));
      await mkdir(join(f.project, 'src/empty'));
      for (const command of ['d=.github; mv $d /tmp/g; echo done', 'd=Make; mv ${d}file /tmp/m', 'd=empty; mv src/$d /tmp/gone; sleep 20']) {
        expect(await f.call('run_shell', { command })).toMatchObject({ card: true, status: 'denied' });
      }
      for (const path of ['.github/workflows', 'Makefile', 'src/empty']) expect(existsSync(join(f.project, path))).toBe(true);
      expect(effects(f)).toEqual([]);
    }, 120_000);
    it('a move compounded with a later write has no partial effects', async () => {
      const f = await runtime(); await mkdir(join(f.project, 'src/empty'));
      const result = await f.call('run_shell', { command: 'd=empty; mv src/$d /tmp/gone; echo new >> src/other.ts; sleep 1' });
      expect(result).toMatchObject({ card: true, status: 'denied' });
      expect(existsSync(join(f.project, 'src/empty'))).toBe(true);
      expect(existsSync(join(f.project, 'src/other.ts'))).toBe(false);
      expect(effects(f)).toEqual([]);
    }, 120_000);
  });

  // Astra 2180 R1: a directory the command removed is an entry like a file — classified, decided, its own C11 effect, reported — never a
  // direct removal beside the write-set path.
  describe('directory removals still settle through the file boundary (Astra 2180 R1)', () => {
    const effects = (f: Awaited<ReturnType<typeof runtime>>) => f.rows("SELECT target_id, state FROM effect_intents WHERE target_kind = 'workspace-file' ORDER BY target_id") as { target_id: string; state: string }[];
    it('policy deny: nothing is removed and the report holds it back; allow: the empty directory and a whole tree are removed, each as its own effect', async () => {
      const denied = await runtime('full-auto', [...GRANTS.slice(0, 2), rule('write-op', 'operation', ['workspace.file.write'], 'deny')]);
      await mkdir(join(denied.project, 'src', 'empty'));
      const held = await denied.call('run_shell', { command: 'd=empty; rm -d src/$d; echo done' });
      expect(held).toMatchObject({ card: false, status: 'error' });
      expect(held.text).toContain('not applied: src/empty/ (denied by policy)');
      expect(existsSync(join(denied.project, 'src', 'empty'))).toBe(true);
      expect(effects(denied)).toEqual([]);
      const f = await runtime();
      await mkdir(join(f.project, 'src', 'empty')); await mkdir(join(f.project, 'src', 'tree', 'sub'), { recursive: true });
      await writeFile(join(f.project, 'src', 'tree', 'a'), 'a\n'); await writeFile(join(f.project, 'src', 'tree', 'sub', 'b'), 'b\n');
      const removed = await f.call('run_shell', { command: 'd=empty; t=tree; rm -d src/$d && rm src/$t/a src/$t/sub/b && rm -d src/$t/sub src/$t; echo done' });
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
      const bound = await f.call('run_shell', { command: 'd=.github; rm -d $d/workflows $d; echo done' });
      expect(bound.text).toContain('Read-only file system');
      expect(existsSync(join(f.project, '.github', 'workflows'))).toBe(true);
      // A directory whose own name is on the floor (`Makefile`) is not bound read-only as a tree: its removal reaches the write set and is
      // held back by the same classification as a file of that name.
      await mkdir(join(f.project, 'Makefile'));
      const floor = await f.call('run_shell', { command: 'd=Make; rm -d ${d}file; echo done' });
      expect(floor).toMatchObject({ card: false, status: 'error' });
      expect(floor.text).toContain('not applied: Makefile/ (write floor: the owner approves');
      expect(existsSync(join(f.project, 'Makefile'))).toBe(true);
      await mkdir(join(f.project, 'src', 'empty'));
      const stopped = await f.call('run_shell', { command: 'd=empty; rm -d src/$d; sleep 20' });
      expect(stopped.status).toBe('error');
      expect(stopped.text).toContain('kept aside and not applied');
      expect(existsSync(join(f.project, 'src', 'empty'))).toBe(true);
      expect(effects(f)).toEqual([]);
    }, 120_000);

    it('a lower directory that changed during the call (a file added to it) is a conflict: nothing is applied', async () => {
      const f = await runtime();
      await mkdir(join(f.project, 'src', 'empty'));
      const running = f.call('run_shell', { command: 'd=empty; rm -d src/$d; echo new >> src/other.ts; sleep 1' });
      // The command removed the empty directory (its whiteout is in the call's upper); the owner then adds a file to it while the command sleeps.
      await callReached(f, join('upper', 'src', 'empty'));
      await writeFile(join(f.project, 'src', 'empty', 'theirs.txt'), 'theirs\n');
      const result = await running;
      expect(result.text).toContain('nothing was applied — the project changed during the call: src/empty');
      expect(await readFile(join(f.project, 'src', 'empty', 'theirs.txt'), 'utf8')).toBe('theirs\n');
      expect(existsSync(join(f.project, 'src', 'other.ts'))).toBe(false);
      expect(effects(f)).toEqual([]);
    }, 120_000);
  });
});
