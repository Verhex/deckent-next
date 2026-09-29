import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applySandboxWriteSet, createWorkspaceScope, ensureWorkspaceParents, fileContentVersion, isWriteApprovalFloored, scanSandboxWriteSet, WorkspaceFileTarget,
  type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { linuxShellHost, measureTestShellHost } from '../../fixtures/shell-host.js';

// SHELL-OVERLAY at the real boundary: the launcher the host measurement selects (BWRAP-SELECT: a system bwrap ≥ 0.12 or the bundled,
// lock-verified 0.13 realized under this test process's state root), a real overlay in a user namespace, the native lister reading the
// kernel's `user.overlay.*` attributes. Runs wherever the selected launcher has the overlay options; the real-sandbox guard
// (bwrap-real-sandbox-guard.test.ts) fails the suite where a sandbox-capable host selected none.
const capabilities = await measureTestShellHost();
const launcher = capabilities.bubblewrap.launcher;
const ready = process.platform === 'linux' && capabilities.userNamespace === 'available' && capabilities.bubblewrap.status === 'available' && launcher?.overlay === true;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, 'state', 'work', 'work'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-overlay-')); roots.push(root);
  const project = join(root, 'project'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, 'src'), { recursive: true }), mkdir(join(project, 'sub', 'deep'), { recursive: true }), mkdir(join(project, 'sub', 'k2'), { recursive: true }),
    mkdir(join(state, 'upper'), { recursive: true, mode: 0o700 }), mkdir(join(state, 'work'), { recursive: true, mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await Promise.all([writeFile(join(project, 'src', 'a.ts'), 'a\n'), writeFile(join(project, 'package.json'), '{}\n'), writeFile(join(project, 'sub', 'deep', 'f'), 'f\n'),
    writeFile(join(project, 'sub', 'deep', 'g'), 'g\n'), writeFile(join(project, 'sub', 'k'), 'k\n'), writeFile(join(project, 'sub', 'k2', 'x'), 'x\n'), writeFile(join(project, '.env'), 'SECRET\n')]);
  const scope = await createWorkspaceScope(project);
  const layout: ShellSandboxLayout = { project: scope, scratchDir: null, writeFloor: isWriteApprovalFloored };
  const writeSet = { upper: join(state, 'upper'), work: join(state, 'work') };
  // The start mark as the runtime takes it: the call directory's own ctime, set after the project's content exists (here: a fresh chmod).
  // A change in the same coarse clock tick as the mark counts as a conflict (safe side, design §6): the fixture leaves a tick between them.
  await new Promise(resolve => setTimeout(resolve, 30));
  await chmod(state, 0o700);
  const mark = (await lstat(state, { bigint: true })).ctimeNs;
  const usable = bubblewrapShellSandbox(layout).usable(capabilities);
  if (!usable.ok) throw new Error(usable.reason);
  const run = (command: string) => usable.realm.run({ command, cwd: scope.root, environment: { HOME: home, PATH: '/usr/bin:/bin' }, timeoutMs: 20_000,
    writeFloorReadOnly: true, writeSet });
  return { root, project, scope, layout, writeSet, mark, usable, run };
}

describe.skipIf(!ready)('sandbox write set: overlay mount and upper scan (SHELL-OVERLAY)', () => {
  it('the selected launcher decides: one with overlay offers write sets, one without does not (and refuses a write-set request)', async () => {
    const f = await fixture();
    expect(f.usable.ok && f.usable.writeSets).toBe(true);
    // The same real, still-verifying launcher measured as older than 0.11: no write sets, and a write-set request runs nothing.
    const older = bubblewrapShellSandbox(f.layout).usable(linuxShellHost({ userNamespace: capabilities.userNamespace,
      bubblewrap: { ...capabilities.bubblewrap, launcher: { ...launcher!, overlay: false } } }));
    expect(older.ok).toBe(true);
    expect(older.ok && older.writeSets).toBeFalsy();
    const refused = older.ok ? await older.realm.run({ command: 'echo ran > ran.txt', cwd: f.scope.root, environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000,
      writeFloorReadOnly: true, writeSet: f.writeSet }) : null;
    expect(refused).toMatchObject({ status: 'spawn-failed', exitCode: null });
    expect(refused?.output).toContain('has no overlay (bubblewrap 0.11.0 or later is needed); nothing was run.');
    expect(existsSync(join(f.project, 'ran.txt'))).toBe(false);
    // The view mounts the project as an overlay (never a bind) and the directories must be outside it.
    const view = await resolveBubblewrapView(f.layout, { PATH: '/usr/bin' }, {}, { floorReadOnly: true, writeSet: f.writeSet });
    expect(view.ok).toBe(true);
    const args = bubblewrapArguments((view as { view: Parameters<typeof bubblewrapArguments>[0] }).view);
    expect(args.join(' ')).toContain(`--overlay-src ${f.project} --overlay ${f.writeSet.upper} ${f.writeSet.work} ${f.project}`);
    expect(args.join(' ')).not.toContain(`--bind ${f.project} ${f.project}`);
    const inside = join(f.project, '.deckent-writes');
    await mkdir(join(inside, 'upper'), { recursive: true, mode: 0o700 }); await mkdir(join(inside, 'work'), { mode: 0o700 });
    expect(await resolveBubblewrapView(f.layout, {}, {}, { writeSet: { upper: join(inside, 'upper'), work: join(inside, 'work') } }))
      .toEqual({ ok: false, reason: 'the write set directories overlap the project' });
  }, 60_000);

  it('writes stay aside; the scan reads creations, changes, deletions, opaque directories, renames and refuses what cannot be applied', async () => {
    const f = await fixture();
    const result = await f.run([
      'echo new > src/x.ts', 'echo mod >> src/a.ts', 'rm sub/k', 'mkdir -p fresh/empty', 'mv sub/deep sub/old && mkdir sub/deep && echo z > sub/deep/z',
      'ln -s a.ts src/link', 'echo h > src/h && ln src/h src/h2', 'mkfifo src/fifo', 'echo n > src/package.json', 'chmod +x src/x.ts', 'cat .env; echo env=$?',
      'echo x >> package.json; echo floor=$?', `[ -e ${f.writeSet.upper} ]; echo upper=$?`, 'rm sub/k2/x',
    ].join('; '));
    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(result.output).toContain('env=1'); expect(result.output).toContain('floor=1');
    // The overlay's own directories are not in the view (the kernel's `user.overlay.*` names stay the kernel's).
    expect(result.output).toContain('upper=1');
    // Nothing reached the project.
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('a\n');
    expect(existsSync(join(f.project, 'src', 'x.ts'))).toBe(false);
    expect(existsSync(join(f.project, 'sub', 'k'))).toBe(true);
    const scan = await scanSandboxWriteSet(f.writeSet.upper, f.project, f.mark);
    if (!scan.ok) throw new Error(scan.reason);
    const byRel = Object.fromEntries(scan.changes.map(change => [change.rel, change]));
    expect(byRel['src/x.ts']).toMatchObject({ kind: 'write', lowerVersion: 'absent', mode: 0o755, digest: fileContentVersion(Buffer.from('new\n')) });
    expect(byRel['src/a.ts']).toMatchObject({ kind: 'write', lowerVersion: fileContentVersion(Buffer.from('a\n')) });
    expect(byRel['sub/k']).toMatchObject({ kind: 'delete' }); expect(byRel['sub/k2/x']).toMatchObject({ kind: 'delete' });
    // The opaque directory: the lower f and g are gone although no whiteout names them; the rename is a copy plus the deletion.
    expect(byRel['sub/deep/f']).toMatchObject({ kind: 'delete' }); expect(byRel['sub/deep/g']).toMatchObject({ kind: 'delete' });
    expect(byRel['sub/deep/z']).toMatchObject({ kind: 'write' });
    expect(byRel['sub/old/f']).toMatchObject({ kind: 'write', lowerVersion: 'absent' });
    // A new floor name is an ordinary change here: the decision (not the scan) keeps it out.
    expect(byRel['src/package.json']).toMatchObject({ kind: 'write', lowerVersion: 'absent' });
    expect(byRel['package.json']).toBeUndefined();
    expect(Object.fromEntries(scan.refused.map(entry => [entry.rel, entry.reason]))).toEqual({ 'src/link': 'symbolic-link', 'src/h': 'hard-link', 'src/h2': 'hard-link',
      'src/fifo': 'special-file' });
    expect(scan.emptyDirectories).toEqual(['fresh/empty']);
    expect(scan.conflicts).toEqual([]);
    expect(scan.changes.findIndex(change => change.kind === 'write')).toBeGreaterThan(scan.changes.findLastIndex(change => change.kind === 'delete'));
  }, 60_000);

  it('a lower file changed during the call is a conflict; bounds refuse the whole set', async () => {
    const f = await fixture();
    const running = f.run('rm sub/k; sleep 1; echo mine >> src/a.ts');
    await new Promise(resolve => setTimeout(resolve, 300));
    await writeFile(join(f.project, 'src', 'a.ts'), 'theirs\n');
    // A whiteout over a lower entry that someone else removed meanwhile: a conflict too (no ctime left to read).
    await rm(join(f.project, 'sub', 'k'));
    expect(await running).toMatchObject({ status: 'exited' });
    const scan = await scanSandboxWriteSet(f.writeSet.upper, f.project, f.mark);
    expect(scan.ok && scan.conflicts).toEqual(['src/a.ts', 'sub/k']);
    const bounded = await scanSandboxWriteSet(f.writeSet.upper, f.project, f.mark, { maxEntries: 1, maxTotalBytes: 1, maxFileBytes: 1, maxDepth: 32 });
    expect(bounded.ok).toBe(false);
  }, 60_000);
});

describe('write-set entries at the file target (SHELL-OVERLAY)', () => {
  it('only a write-set target accepts the form; a digest mismatch refuses; a removal that reached prepared is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-overlay-target-')); roots.push(root);
    const project = join(root, 'project'), upper = join(root, 'upper'), journal = join(root, 'journal');
    await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(upper, 'src'), { recursive: true });
    await writeFile(join(project, 'src', 'a.ts'), 'a\n'); await writeFile(join(upper, 'src', 'a.ts'), 'b\n');
    const scope = await createWorkspaceScope(project);
    const request = (input: unknown, expectedVersion: string, key = 'a'.repeat(64)) => ({ operation: { id: 'workspace.file.write', version: 1 }, target: { kind: 'workspace-file', id: 'src/a.ts' },
      idempotencyKey: key, input, expectedVersion }) as never;
    const entry = { writeSet: { change: 'write', digest: fileContentVersion(Buffer.from('b\n')), mode: 0o640 } };
    await expect(new WorkspaceFileTarget(scope, journal).apply(request(entry, fileContentVersion(Buffer.from('a\n'))))).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    const target = new WorkspaceFileTarget(scope, journal, { writeSet: { upper } });
    await expect(target.apply(request({ writeSet: { ...entry.writeSet, digest: '0'.repeat(64) } }, fileContentVersion(Buffer.from('a\n'))))).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    await target.apply(request(entry, fileContentVersion(Buffer.from('a\n'))));
    expect(await readFile(join(project, 'src', 'a.ts'), 'utf8')).toBe('b\n');
    expect((await lstat(join(project, 'src', 'a.ts'))).mode & 0o777).toBe(0o640);
    // A removal: committed → applied (absent); a crash between prepared and committed → unknown, never decided from the file.
    const del = 'b'.repeat(64);
    await target.apply(request({ writeSet: { change: 'delete' } }, fileContentVersion(Buffer.from('b\n')), del));
    expect(existsSync(join(project, 'src', 'a.ts'))).toBe(false);
    expect(await target.lookup({ kind: 'workspace-file', id: 'src/a.ts' }, del)).toEqual({ status: 'applied', version: 'absent' });
    const crashed = 'c'.repeat(64);
    await writeFile(join(journal, `${crashed}.json`), JSON.stringify({ schemaVersion: 2, rel: 'src/a.ts', expected: fileContentVersion(Buffer.from('b\n')), next: 'absent',
      temporary: '.a.ts.deckent-000000000000.tmp', state: 'prepared', escapedTo: null }));
    expect(await target.lookup({ kind: 'workspace-file', id: 'src/a.ts' }, crashed)).toBeNull();
  });
});

describe('write-set apply loop: directories are entries (Astra 2180 R1)', () => {
  it('a directory removal is classified, decided and executed like a file; it is held back when something beneath it stayed', async () => {
    const executed: string[] = [], decided: string[] = [];
    const scan = { ok: true as const, refused: [], conflicts: [], emptyDirectories: [], directoryModes: new Map<string, number>(), newDirectories: new Set<string>(),
      changes: [{ kind: 'delete' as const, rel: 'src/t/a', lowerVersion: 'x' }, { kind: 'delete' as const, rel: 'src/u/b', lowerVersion: 'y' },
        { kind: 'rmdir' as const, rel: 'src/t' }, { kind: 'rmdir' as const, rel: 'src/u' }] };
    const report = await applySandboxWriteSet({ scan, signal: new AbortController().signal, ensureParents: async () => true,
      classify: (rel, kind) => kind === 'rmdir' && rel === 'src/u' ? 'edit-floor' : 'edit',
      decider: { async decide(rel, cell) { decided.push(`${rel}:${cell}`); return rel === 'src/t/a' ? { ok: false, reason: 'denied-by-policy' } : cell === 'edit-floor' ? { ok: false, reason: 'write-floor' }
        : { ok: true, gate: { async admit() {} } }; } },
      async execute(change) { executed.push(`${change.kind}:${change.rel}`); } });
    expect(executed).toEqual(['delete:src/u/b']);
    expect(decided).toEqual(['src/t/a:edit', 'src/u/b:edit', 'src/u:edit-floor']);
    expect(report.applied).toEqual(['src/u/b']);
    expect(report.notApplied).toEqual([{ rel: 'src/t/a', reason: 'denied-by-policy' }, { rel: 'src/t/', reason: 'not-empty' }, { rel: 'src/u/', reason: 'write-floor' }]);
    const aborted = new AbortController(); aborted.abort();
    const stopped = await applySandboxWriteSet({ scan, signal: aborted.signal, ensureParents: async () => true, classify: () => 'edit',
      decider: { async decide() { return { ok: true, gate: { async admit() {} } }; } }, async execute(change) { executed.push(change.rel); } });
    expect(stopped).toMatchObject({ applied: [], stopped: true });
  });
});

// Astra 2182 R3: a new parent directory is an entry's precondition decided like the entry itself — before any of them is made.
describe('write-set apply loop: new parent directories are decided like entries (Astra 2182 R3)', () => {
  const allow = { ok: true as const, gate: { async admit() {} } };
  const scanOf = (writes: string[], newDirectories: string[]) => ({ ok: true as const, refused: [], conflicts: [], emptyDirectories: [],
    directoryModes: new Map<string, number>(), newDirectories: new Set(newDirectories),
    changes: writes.map(rel => ({ kind: 'write' as const, rel, digest: '0'.repeat(64), size: 1, mode: 0o644, lowerVersion: 'absent' })) });
  /** The loop with a recording decider: `cells` maps a classified path (a directory as `dir`) to its cell, `refuse` a decided path to its reason. */
  async function run(writes: string[], newDirectories: string[], cells: Record<string, 'edit-floor' | 'edit-authority' | 'denied'> = {},
    refuse: Record<string, 'write-floor' | 'configuration-file' | 'denied-by-policy'> = {}) {
    const decided: string[] = [], made: string[][] = [], executed: string[] = [], classified: string[] = [];
    const report = await applySandboxWriteSet({ scan: scanOf(writes, newDirectories), signal: new AbortController().signal,
      classify: (rel, kind) => { classified.push(`${kind}:${rel}`); return cells[rel] ?? 'edit'; },
      decider: { async decide(rel, cell) { decided.push(`${rel}:${cell}`); return refuse[rel] ? { ok: false, reason: refuse[rel]! } : allow; } },
      async ensureParents(rel, _modeOf, admit) { made.push(newDirectories.filter(directory => rel.startsWith(`${directory}/`) && admit(directory))); return true; },
      async execute(change) { executed.push(change.rel); } });
    return { report, decided, made, executed, classified };
  }

  it('a floor-named parent (nested under ordinary new ones) refuses the write and every write under it; no parent is made', async () => {
    const { report, decided, made, executed, classified } = await run(['a/b/package.json/c/x.txt', 'a/b/package.json/y.txt', 'a/ok.txt'],
      ['a', 'a/b', 'a/b/package.json', 'a/b/package.json/c'], { 'a/b/package.json': 'edit-floor' }, { 'a/b/package.json/': 'write-floor' });
    expect(classified).toContain('mkdir:a/b/package.json');
    // The entry first, then each new directory once for the whole set (as `dir/`), shallowest first; the refused one stops before anything is made.
    expect(decided).toEqual(['a/b/package.json/c/x.txt:edit', 'a/:edit', 'a/b/:edit', 'a/b/package.json/:edit-floor', 'a/b/package.json/y.txt:edit', 'a/ok.txt:edit']);
    expect(made).toEqual([['a']]);
    expect(executed).toEqual(['a/ok.txt']);
    expect(report.notApplied).toEqual([{ rel: 'a/b/package.json/', reason: 'write-floor' }, { rel: 'a/b/package.json/c/x.txt', reason: 'parent-refused' },
      { rel: 'a/b/package.json/y.txt', reason: 'parent-refused' }]);
    expect(report.createdDirectories).toEqual(['a']);
  });

  it('a configuration-named parent asks the owner (not applied); a denied parent name is held back without a decision of its own', async () => {
    const config = await run(['cfg.json/x'], ['cfg.json'], { 'cfg.json': 'edit-authority' }, { 'cfg.json/': 'configuration-file' });
    expect(config.decided).toEqual(['cfg.json/x:edit', 'cfg.json/:edit-authority']);
    expect(config.made).toEqual([]);
    expect(config.report.notApplied).toEqual([{ rel: 'cfg.json/', reason: 'configuration-file' }, { rel: 'cfg.json/x', reason: 'parent-refused' }]);
    const denied = await run(['secret/x'], ['secret'], { secret: 'denied' });
    expect(denied.decided).toEqual(['secret/x:edit']);
    expect(denied.executed).toEqual([]);
    expect(denied.report.notApplied).toEqual([{ rel: 'secret/', reason: 'denied' }, { rel: 'secret/x', reason: 'parent-refused' }]);
    const policy = await run(['n/x'], ['n'], {}, { 'n/': 'denied-by-policy' });
    expect(policy.report.notApplied).toEqual([{ rel: 'n/', reason: 'denied-by-policy' }, { rel: 'n/x', reason: 'parent-refused' }]);
    expect(policy.made).toEqual([]);
  });

  it('a refused entry keeps its own reason and decides none of its directories', async () => {
    const { report, decided, made } = await run(['.github/workflows/x.yml'], ['.github', '.github/workflows'], { '.github/workflows/x.yml': 'edit-floor' },
      { '.github/workflows/x.yml': 'write-floor' });
    expect(decided).toEqual(['.github/workflows/x.yml:edit-floor']);
    expect(made).toEqual([]);
    expect(report.notApplied).toEqual([{ rel: '.github/workflows/x.yml', reason: 'write-floor' }]);
  });

  it('ordinary new directories are decided once and made before their files; an existing parent is not a decision', async () => {
    const { report, decided, made, executed } = await run(['n1/n2/f', 'n1/n2/g', 'src/h'], ['n1', 'n1/n2']);
    expect(decided).toEqual(['n1/n2/f:edit', 'n1/:edit', 'n1/n2/:edit', 'n1/n2/g:edit', 'src/h:edit']);
    expect(made[0]).toEqual(['n1', 'n1/n2']);
    expect(executed).toEqual(['n1/n2/f', 'n1/n2/g', 'src/h']);
    expect(report.createdDirectories).toEqual(['n1', 'n1/n2']);
    expect(report.notApplied).toEqual([]);
  });
});

describe('ensureWorkspaceParents makes only decided, non-floor directories — all or none (Astra 2182 R3, defense in depth)', () => {
  async function project() {
    const root = await mkdtemp(join(tmpdir(), 'deckent-parents-')); roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    return { root, scope: await createWorkspaceScope(root) };
  }
  it('refuses a floor-named directory even when admitted, and makes none of the ordinary ones above it', async () => {
    const { root, scope } = await project();
    expect(await ensureWorkspaceParents(scope, 'src/package.json/payload.txt', () => 0o755, () => true)).toBe(false);
    expect(existsSync(join(root, 'src', 'package.json'))).toBe(false);
    expect(await ensureWorkspaceParents(scope, 'a/b/package.json/c/x.txt', () => 0o755, () => true)).toBe(false);
    expect(existsSync(join(root, 'a'))).toBe(false);
    expect(await ensureWorkspaceParents(scope, '.github/workflows/x.yml', () => 0o755, () => true)).toBe(false);
    expect(existsSync(join(root, '.github'))).toBe(false);
  });
  it('refuses a directory the caller did not decide (none made); makes decided ordinary ones with their mode', async () => {
    const { root, scope } = await project();
    expect(await ensureWorkspaceParents(scope, 'n1/n2/f', () => 0o755, directory => directory === 'n1')).toBe(false);
    expect(existsSync(join(root, 'n1'))).toBe(false);
    expect(await ensureWorkspaceParents(scope, 'n1/n2/f', () => 0o750, () => true)).toBe(true);
    expect((await lstat(join(root, 'n1', 'n2'))).mode & 0o777).toBe(0o750);
    // Existing directories are no decision: nothing new is needed, `admit` is never asked.
    expect(await ensureWorkspaceParents(scope, 'n1/n2/g', () => 0o755, () => { throw new Error('asked'); })).toBe(true);
  });
});
