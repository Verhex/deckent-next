import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceScope, describeHostShellResult, HostShellTarget, probeShellCapabilities, resolveShellRealm, SHELL_CAPABILITIES_VERSION, type HostShellResult, type ShellCapabilities,
  type ShellSandbox } from '#adapters/index.js';
import { BUBBLEWRAP_BUNDLED, BUBBLEWRAP_MINIMUM_SYSTEM_VERSION, bubblewrapShellSandbox, inspectShellRealmSelection, selectBubblewrapLauncher,
  type BubblewrapSelectOptions } from '#adapters/core/shell-sandbox-bwrap/index.js';

// BWRAP-SELECT (owner S1–S7, 2026-09-29): the launcher is the system bwrap when it is root-owned in root-owned directories and at least
// 0.12.0, otherwise the bundled build verified by sha256 and run from a 0700 copy under the product state root; the capability probe runs
// with the selected launcher. Fixture launchers are shell scripts (the ownership rules take the test uid as the trusted owner and the
// fixture root as the top of the ancestor walk; the defaults are uid 0 and `/`).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const uid = process.getuid!();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A launcher script: `--version` prints `version` (or `raw`), anything else appends its own path to the log and exits with `code`. */
const launcher = (log: string, version: string, options: { code?: number; stderr?: string; raw?: string } = {}) => ['#!/bin/sh',
  `if [ "$1" = "--version" ]; then echo "${options.raw ?? `bubblewrap ${version}`}"; exit 0; fi`, `echo "$0" >> '${log}'`,
  ...(options.stderr ? [`echo '${options.stderr}' >&2`] : []), `exit ${options.code ?? 0}`, ''].join('\n');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bwrap-select-')); roots.push(root);
  const log = join(root, 'exec.log'), sys = join(root, 'usr', 'bin'), pkg = join(root, 'pkg', 'bundled', 'linux-x64'), state = join(root, 'state');
  await mkdir(sys, { recursive: true }); await mkdir(pkg, { recursive: true });
  await chmod(join(root, 'usr'), 0o755); await chmod(sys, 0o755);
  const bundledScript = launcher(log, '0.13.0');
  const bundled = join(pkg, 'bwrap');
  await writeFile(bundled, bundledScript, { mode: 0o755 });
  const options = (extra: Partial<BubblewrapSelectOptions> = {}): BubblewrapSelectOptions => ({ stateDir: state, systemPaths: [], bundledPath: bundled,
    bundledSha256: sha256(bundledScript), bundledVersion: '0.13.0', trustedOwners: [uid], ancestorRoot: root, apparmorRestricted: () => false, ...extra });
  const executed = async () => existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : [];
  return { root, log, sys, bundled, bundledScript, state, options, executed };
}
const linux = (bubblewrap: ShellCapabilities['bubblewrap']): ShellCapabilities => ({ schemaVersion: SHELL_CAPABILITIES_VERSION, platform: 'linux', bubblewrap,
  userNamespace: 'available', landlock: { status: 'available', abi: 7 } });
/** A stand-in Landlock provider (never run): what the resolver picks after a rejected bubblewrap. */
const landlockStub: ShellSandbox = { kind: 'landlock', usable: () => ({ ok: true, realm: { kind: 'landlock', run: async () => { throw new Error('not run'); } },
  marker: 'sandbox: landlock', posture: () => 'landlock', notice: null, containment: 'sandbox' }) };
const cardView = { projectReadOnly: false, writeFloorReadOnly: false, repositoryWritable: false };
async function sandboxFor(root: string) {
  const project = join(root, 'project'); await mkdir(project, { recursive: true });
  return bubblewrapShellSandbox({ project: await createWorkspaceScope(project), scratchDir: null, writeFloor: null });
}

describe('bubblewrap launcher selection (BWRAP-SELECT)', () => {
  it('selects a root-owned system bwrap at or above the minimum and runs the probe with that launcher', async () => {
    const f = await fixture();
    await writeFile(join(f.sys, 'bwrap'), launcher(f.log, '0.12.1'), { mode: 0o755 });
    const observed = await selectBubblewrapLauncher(f.options({ systemPaths: [join(f.sys, 'bwrap')] }));
    expect(BUBBLEWRAP_MINIMUM_SYSTEM_VERSION).toBe('0.12.0');
    expect(observed).toMatchObject({ status: 'available', launcher: { source: 'system', path: join(f.sys, 'bwrap'), version: '0.12.1', sha256: null, overlay: true },
      rejected: [], restriction: null });
    // The user-namespace smoke ran with the selected file, and nothing else ran (the bundled candidate was not needed).
    expect(await f.executed()).toEqual([join(f.sys, 'bwrap')]);
  });

  it('names every rejected system candidate — below the minimum, writable, in a writable directory, a symbolic link, setuid, unparsable — and falls to the bundled build', async () => {
    const f = await fixture();
    const loose = join(f.root, 'loose'); await mkdir(loose); await chmod(loose, 0o777);
    const paths = { old: join(f.sys, 'bwrap-old'), writable: join(f.sys, 'bwrap-writable'), dir: join(loose, 'bwrap'), link: join(f.sys, 'bwrap-link'),
      setuid: join(f.sys, 'bwrap-setuid'), garbled: join(f.sys, 'bwrap-garbled'), missing: join(f.sys, 'bwrap-missing') };
    await writeFile(paths.old, launcher(f.log, '0.9.0'), { mode: 0o755 });
    await writeFile(paths.writable, launcher(f.log, '0.13.0')); await chmod(paths.writable, 0o775);
    await writeFile(paths.dir, launcher(f.log, '0.13.0'), { mode: 0o755 });
    await symlink(paths.old, paths.link);
    await writeFile(paths.setuid, launcher(f.log, '0.13.0')); await chmod(paths.setuid, 0o4755);
    await writeFile(paths.garbled, launcher(f.log, '', { raw: 'bubblewrap 0.12' }), { mode: 0o755 });
    const observed = await selectBubblewrapLauncher(f.options({ systemPaths: Object.values(paths) }));
    expect(observed.status).toBe('available');
    expect(observed.launcher).toMatchObject({ source: 'bundled', version: '0.13.0', sha256: sha256(f.bundledScript), overlay: true });
    const reasons = Object.fromEntries(observed.rejected.map(item => [item.path, item.reason]));
    expect(reasons[paths.old]).toMatch(/0\.9\.0 is below the minimum 0\.12\.0/u);
    expect(reasons[paths.writable]).toMatch(/writable by group or others/u);
    expect(reasons[paths.dir]).toMatch(new RegExp(`directory ${loose} is writable by group or others`, 'u'));
    expect(reasons[paths.link]).toMatch(/symbolic link/u);
    expect(reasons[paths.setuid]).toMatch(/setuid or setgid/u);
    expect(reasons[paths.garbled]).toMatch(/unrecognized version/u);
    expect(paths.missing in reasons).toBe(false); // absent is not a rejection
    // Only the version query ran on candidates that passed the file rules (old, garbled); the smoke ran with the realized copy only.
    expect(await f.executed()).toEqual([observed.launcher!.path]);
  });

  it('refuses a bundled binary that does not match the shipped build, and runs nothing', async () => {
    const f = await fixture();
    const observed = await selectBubblewrapLauncher(f.options({ bundledSha256: '0'.repeat(64) }));
    expect(observed).toMatchObject({ status: 'unavailable', launcher: null });
    expect(observed.rejected).toEqual([{ path: f.bundled, reason: expect.stringMatching(/does not match the shipped build \(sha256 0{64}\)/u) }]);
    expect(await f.executed()).toEqual([]);
    expect(existsSync(join(f.state, 'bin', `bwrap-${'0'.repeat(64)}`))).toBe(false);
    // No bundled build for this architecture: said, not silent.
    const none = await selectBubblewrapLauncher(f.options({ bundledPath: null }));
    expect(none).toMatchObject({ status: 'unavailable', launcher: null, detail: expect.stringMatching(/no bundled bubblewrap/u) });
  });

  it('umask 002 install: a group-writable package file is copied (the verified bytes) into a 0700 directory under the state root and run from there', async () => {
    const f = await fixture();
    await chmod(f.bundled, 0o775);
    await mkdir(join(f.state, 'bin'), { recursive: true }); await chmod(join(f.state, 'bin'), 0o755);
    const realized = join(f.state, 'bin', `bwrap-${sha256(f.bundledScript)}`);
    await writeFile(realized, 'tampered\n', { mode: 0o700 }); // a stale or tampered copy is replaced, never run
    const observed = await selectBubblewrapLauncher(f.options());
    expect(observed).toMatchObject({ status: 'available', launcher: { source: 'bundled', path: realized } });
    expect(await readFile(realized, 'utf8')).toBe(f.bundledScript);
    expect((await stat(realized)).mode & 0o7777).toBe(0o500);
    expect((await stat(join(f.state, 'bin'))).mode & 0o777).toBe(0o700);
    expect(await f.executed()).toEqual([realized]);
    // A second selection reuses the verified copy (same inode) instead of writing another.
    const before = (await lstat(realized)).ino;
    expect((await selectBubblewrapLauncher(f.options())).launcher?.path).toBe(realized);
    expect((await lstat(realized)).ino).toBe(before);
    // No state root: the bundled build cannot be realized — refused with the reason, never run from the package tree.
    expect(await selectBubblewrapLauncher(f.options({ stateDir: null }))).toMatchObject({ status: 'unavailable', rejected: [{ reason: expect.stringMatching(/state root/u) }] });
  });

  it('re-verifies the launcher on every use: a changed copy or system file is refused with a typed reason', async () => {
    const f = await fixture();
    const observed = await selectBubblewrapLauncher(f.options());
    const sandbox = await sandboxFor(f.root);
    expect(sandbox.usable(linux(observed))).toMatchObject({ ok: true, marker: 'sandbox: bubblewrap' });
    await chmod(observed.launcher!.path, 0o700);
    await writeFile(observed.launcher!.path, launcher(f.log, '0.13.0', { stderr: 'swapped' }));
    expect(sandbox.usable(linux(observed))).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer matches the shipped build/u) });

    await writeFile(join(f.sys, 'bwrap'), launcher(f.log, '0.12.1'), { mode: 0o755 });
    const system = await selectBubblewrapLauncher(f.options({ systemPaths: [join(f.sys, 'bwrap')] }));
    expect(sandbox.usable(linux(system))).toMatchObject({ ok: true });
    await writeFile(join(f.sys, 'bwrap'), launcher(f.log, '0.12.2'));
    expect(sandbox.usable(linux(system))).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since the service measured it/u) });
  });

  it('refuses a launcher a sandboxed command could replace: a state root inside the project or the scratch area', async () => {
    const f = await fixture();
    const project = join(f.root, 'project'); await mkdir(project, { recursive: true });
    const inside = await selectBubblewrapLauncher(f.options({ stateDir: join(project, '.state') }));
    expect(inside.status).toBe('available');
    const sandbox = bubblewrapShellSandbox({ project: await createWorkspaceScope(project), scratchDir: null, writeFloor: null });
    expect(sandbox.usable(linux(inside))).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the project or scratch area/u) });
    const scratch = join(f.root, 'scratch'); await mkdir(scratch);
    const inScratch = await selectBubblewrapLauncher(f.options({ stateDir: join(scratch, 'state') }));
    const withScratch = bubblewrapShellSandbox({ project: await createWorkspaceScope(project), scratchDir: scratch, writeFloor: null });
    expect(withScratch.usable(linux(inScratch))).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the project or scratch area/u) });
    expect(withScratch.usable(linux(await selectBubblewrapLauncher(f.options())))).toMatchObject({ ok: true });
  });

  it('AppArmor: a restricted user namespace is typed, and the resolver falls back to Landlock visibly with the fix', async () => {
    const f = await fixture();
    const script = launcher(f.log, '0.13.0', { code: 1, stderr: 'bwrap: setting up uid map: Permission denied' });
    await writeFile(f.bundled, script);
    const observed = await selectBubblewrapLauncher(f.options({ bundledSha256: sha256(script), apparmorRestricted: () => true }));
    expect(observed).toMatchObject({ status: 'restricted', launcher: { source: 'bundled' }, restriction: { kind: 'apparmor', hint: expect.stringMatching(/AppArmor profile/u) } });
    const generic = await selectBubblewrapLauncher(f.options({ bundledSha256: sha256(script) }));
    expect(generic).toMatchObject({ status: 'restricted', restriction: { kind: 'user-namespace' } });

    const sandbox = await sandboxFor(f.root);
    expect(sandbox.usable(linux(observed))).toMatchObject({ ok: false, restricted: true, reason: expect.stringMatching(/AppArmor/u) });
    const landlock = landlockStub;
    const resolved = resolveShellRealm('prefer-sandbox', linux(observed), [sandbox, landlock]);
    expect(resolved).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock',
      notice: expect.stringMatching(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: .*AppArmor/u) });
    // The approval card reads the posture: it carries the same line (the live stream and the model result carry the notice).
    expect(resolved.ok && resolved.posture(cardView)).toBe(`landlock\n${resolved.ok ? resolved.notice : ''}`);
    // The fix text survives the reason bound.
    expect(resolved.ok && resolved.notice).toContain('/usr/local/bin/bwrap');
    // REALM-NOTICE (supersedes the earlier "no notice" rule): an ordinary unusable bubblewrap (not a restriction) is a visible fallback too.
    expect(resolveShellRealm('prefer-sandbox', linux({ ...observed, status: 'unavailable', restriction: null }), [sandbox, landlock]))
      .toMatchObject({ notice: expect.stringMatching(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: bubblewrap unavailable/u) });
  });

  it('the probe carries the launcher observation (contract v2) and bounds it', async () => {
    const f = await fixture();
    const observed = await selectBubblewrapLauncher(f.options());
    const capabilities = await probeShellCapabilities({ platform: 'linux', bubblewrap: async () => observed,
      kernel: async () => ({ userNamespace: true, landlockAbi: 7, landlockErrno: 0 }) });
    expect(capabilities).toEqual({ schemaVersion: 2, platform: 'linux', bubblewrap: observed, userNamespace: 'available', landlock: { status: 'available', abi: 7 } });
  });
});

// REALM-NOTICE (live 2026-09-29): a preferred provider passed over for any reason — not only a host restriction — is a visible fallback
// (stream, model result, approval card), and doctor shows the realm chosen and every provider passed over, measured read-only.
describe('a visible fallback after a preferred provider is passed over (REALM-NOTICE)', () => {
  it('REALM-NOTICE (live 2026-09-29): a launcher inside the project falls back to Landlock visibly — stream/result notice and card posture name it', async () => {
    const f = await fixture();
    const project = join(f.root, 'project'); await mkdir(project, { recursive: true });
    // The live shape: the state root (and so the realized bundled copy) inside the project; the probe says available, the provider refuses.
    const inside = await selectBubblewrapLauncher(f.options({ stateDir: join(project, '.deckent', 'host', 'global') }));
    expect(inside.status).toBe('available');
    const sandbox = bubblewrapShellSandbox({ project: await createWorkspaceScope(project), scratchDir: null, writeFloor: null });
    for (const mode of ['prefer-sandbox', 'require-sandbox'] as const) {
      const resolved = resolveShellRealm(mode, linux(inside), [sandbox, landlockStub]);
      expect(resolved).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock',
        notice: `[deckent] sandbox: landlock instead of bubblewrap (bubblewrap: bwrap at ${inside.launcher!.path} is inside the project or scratch area, where a sandboxed command could replace it).`,
        rejected: [{ kind: 'bubblewrap', reason: expect.stringMatching(/inside the project or scratch area/u) }] });
      // The approval card carries the same line after the winning provider's posture.
      expect(resolved.ok && resolved.posture(cardView)).toBe(`landlock\n${resolved.ok ? resolved.notice : ''}`);
    }
    // Producer to surface: the effect target streams the notice before the command's output, and the model result ends with it.
    const ran: HostShellResult = { status: 'exited', exitCode: 0, signal: null, output: 'ok\n', totalBytes: 3, omittedBytes: 0, durationMs: 10, cleanup: 'clean' };
    const running: ShellSandbox = { kind: 'landlock', usable: () => ({ ok: true, realm: { kind: 'landlock', run: async () => ran }, marker: 'sandbox: landlock',
      posture: () => 'landlock', notice: null, containment: 'sandbox' }) };
    const resolution = resolveShellRealm('prefer-sandbox', linux(inside), [sandbox, running]);
    const notice = resolution.ok ? resolution.notice! : '', streamed: string[] = [], results: HostShellResult[] = [];
    await new HostShellTarget(project, { timeoutMs: 1_000, extraEnv: [], signal: new AbortController().signal, realm: resolution,
      onOutput: (_stream, text) => streamed.push(text), onResult: result => results.push(result) }).apply({ input: { command: 'ls' } } as never);
    expect(streamed).toEqual([`${notice}\n`]);
    expect(describeHostShellResult('ls', results[0]!, resolution.ok ? resolution : null)).toBe(`[deckent] run_shell: sandbox: landlock; exit 0 after 0.0s (ls)\nok\n\n${notice}`);
    // No rejection → no notice: the same bubblewrap with its state root outside the project is chosen as is.
    const outside = await selectBubblewrapLauncher(f.options());
    expect(resolveShellRealm('prefer-sandbox', linux(outside), [sandbox, landlockStub])).toMatchObject({ ok: true, realm: { kind: 'bubblewrap' }, notice: null, rejected: [] });
    // A preferred provider that fails without winning anything leaves the host fallback text unchanged in shape (every reason named).
    const none = resolveShellRealm('prefer-sandbox', linux(inside), [sandbox]);
    expect(none).toMatchObject({ ok: true, marker: 'sandbox: none', notice: expect.stringMatching(/^\[deckent\] sandbox: none; running on host \(bubblewrap: bwrap at .* inside the project/u) });
  });

  it('REALM-NOTICE: a rejection reason is bounded and single-line in the notice', () => {
    const noisy: ShellSandbox = { kind: 'bubblewrap', usable: () => ({ ok: false, reason: `line one\nline\u0007two ${'x'.repeat(2_000)}` }) };
    const resolved = resolveShellRealm('prefer-sandbox', linux({ status: 'unavailable', launcher: null, rejected: [], restriction: null, detail: null }), [noisy, landlockStub]);
    if (!resolved.ok || !resolved.notice) throw new Error('expected a notice');
    expect(resolved.notice).toMatch(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: line one line two x+…\)\.$/u);
    expect([...resolved.notice].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)).toBe(false);
    expect(resolved.notice.length).toBeLessThan(600);
  });

  it('REALM-NOTICE doctor: the probe says available, the provider refuses — the report shows both, with the realm chosen and why', async () => {
    const f = await fixture();
    const project = join(f.root, 'project'); await mkdir(project, { recursive: true });
    const stateDir = join(project, '.deckent', 'host', 'global');
    const capabilities = linux(await selectBubblewrapLauncher(f.options({ stateDir })));
    const scope = await createWorkspaceScope(project);
    // The shipped provider list (bubblewrap, then the real Landlock provider), the service's resolver.
    const report = await inspectShellRealmSelection({ mode: 'prefer-sandbox', stateDir, project: scope, capabilities });
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'prefer-sandbox', stateDir, selected: 'landlock', marker: 'sandbox: landlock', code: null, preferSandbox: null,
      notice: expect.stringMatching(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: bwrap at .* is inside the project or scratch area/u),
      rejected: [{ kind: 'bubblewrap', restricted: false, reason: expect.stringMatching(/inside the project or scratch area/u) }],
      bubblewrap: { status: 'available', launcher: { source: 'bundled', path: join(stateDir, 'bin', `bwrap-${sha256(f.bundledScript)}`), version: '0.13.0', overlay: true } },
      landlock: { status: 'available', abi: 7 } });
    // Host mode: the shell runs on the host. The prefer-sandbox view (the MCP default, Astra 2188 R8) is the launch-eligible walk: Landlock
    // is usable for this one-shot shell call but cannot hold a long-lived MCP launch, so with bubblewrap also unavailable it falls to host
    // too (never reporting Landlock as the MCP default while the real McpClientPool.open would run on the host).
    expect(await inspectShellRealmSelection({ mode: 'host', stateDir, project: scope, capabilities })).toMatchObject({ selected: 'host', marker: null, notice: null, rejected: [],
      preferSandbox: { selected: 'host', marker: 'sandbox: none', notice: expect.stringMatching(/landlock: runs one command at a time/u) } });
    // require-sandbox with nothing usable: refused, typed, every reason named.
    const bare = { ...capabilities, landlock: { status: 'unavailable' as const, abi: null } };
    expect(await inspectShellRealmSelection({ mode: 'require-sandbox', stateDir, project: scope, capabilities: bare })).toMatchObject({ selected: null,
      code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [{ kind: 'bubblewrap' }, { kind: 'landlock', reason: 'landlock unavailable' }] });
    // State root outside the project: bubblewrap, no notice, nothing passed over.
    expect(await inspectShellRealmSelection({ mode: 'prefer-sandbox', stateDir: f.state, project: scope, capabilities: linux(await selectBubblewrapLauncher(f.options())) }))
      .toMatchObject({ selected: 'bubblewrap', marker: 'sandbox: bubblewrap', notice: null, rejected: [] });
  });

  it('REALM-NOTICE doctor: a read-only measurement (place: false) never creates, writes or re-modes the state root; a placed copy is used', async () => {
    const f = await fixture();
    const unplaced = await selectBubblewrapLauncher(f.options({ place: false }));
    expect(unplaced).toMatchObject({ status: 'unavailable', launcher: null,
      rejected: [{ reason: expect.stringMatching(/^the bundled bwrap is not placed at .* yet \(the runtime service places it when it measures the host\)$/u) }] });
    expect(existsSync(f.state)).toBe(false);
    expect(await f.executed()).toEqual([]);
    const placed = await selectBubblewrapLauncher(f.options());
    const before = await lstat(placed.launcher!.path, { bigint: true });
    await chmod(join(f.state, 'bin'), 0o750);
    expect(await selectBubblewrapLauncher(f.options({ place: false }))).toMatchObject({ status: 'available', launcher: { source: 'bundled', path: placed.launcher!.path } });
    const after = await lstat(placed.launcher!.path, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
    expect((await stat(join(f.state, 'bin'))).mode & 0o777).toBe(0o750);
  });

});

// The real bundled 0.13.0 (staged into the source tree by `node scripts/build-bwrap.mjs --stage-dev <out>`; gitignored). This machine's
// system bwrap is 0.9.0, below the minimum, so a real sandbox here runs only through the bundled build.
const stagedBundle = fileURLToPath(new URL(`../../../src/adapters/core/shell-sandbox-bwrap/bundled/linux-${process.arch}/bwrap`, import.meta.url));
const staged = existsSync(stagedBundle) && sha256(readFileSync(stagedBundle)) === BUBBLEWRAP_BUNDLED.sha256[process.arch as 'x64'];
describe('the bundled bubblewrap on this host (BWRAP-SELECT)', () => {
  it.skipIf(!staged)('selects the bundled 0.13.0 over a system bwrap below the minimum and runs the sandbox from the realized copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-bwrap-real-')); roots.push(root);
    const observed = await selectBubblewrapLauncher({ stateDir: join(root, 'state') });
    const realized = join(root, 'state', 'bin', `bwrap-${BUBBLEWRAP_BUNDLED.sha256[process.arch as 'x64']}`);
    // A host with a system bwrap at or above the minimum selects that one (S1); this machine's is 0.9.0 and must be rejected by number.
    if (observed.launcher?.source === 'system') { expect(observed.launcher.version).toMatch(/^0\.(1[2-9]|[2-9]\d)\./u); return; }
    // An AppArmor-restricted host (Ubuntu 24.04 CI runners): the bundled copy is refused the user namespace — typed, with the fix (S3).
    let apparmor = false; try { apparmor = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch { /* no sysctl */ }
    if (apparmor && observed.status === 'restricted') {
      expect(observed).toMatchObject({ launcher: { source: 'bundled', path: realized }, restriction: { kind: 'apparmor' } });
      return;
    }
    expect(observed).toMatchObject({ status: 'available', launcher: { source: 'bundled', version: '0.13.0', overlay: true, path: realized } });
    if (existsSync('/usr/bin/bwrap')) expect(observed.rejected).toContainEqual({ path: '/usr/bin/bwrap', reason: expect.stringMatching(/below the minimum 0\.12\.0/u) });
    const sandbox = await sandboxFor(root);
    const usable = sandbox.usable(linux(observed));
    if (!usable.ok) throw new Error(usable.reason);
    const result = await usable.realm.run({ command: 'readlink /proc/1/exe; echo inside', cwd: join(root, 'project'), timeoutMs: 10_000,
      environment: { PATH: '/usr/bin:/bin', HOME: join(root, 'home') } });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(result.output).toContain(`bwrap-${BUBBLEWRAP_BUNDLED.sha256[process.arch as 'x64']}`);
    expect(result.output).toContain('inside');
  });
});
