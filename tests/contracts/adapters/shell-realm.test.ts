import { existsSync, lstatSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bubblewrapObservation, probeShellCapabilities, resolveShellRealm, hostShellRealm, runHostShell, HostShellTarget, landlockShellSandbox,
  type BubblewrapCapability } from '#adapters/core/host-shell/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { readTerminalShellConfig } from '#adapters/core/contract/index.js';

/** A selected launcher whose own run succeeded (BWRAP-SELECT), measured at /usr/bin/bwrap when this host has one (its identity is re-checked). */
const system = existsSync('/usr/bin/bwrap') ? lstatSync('/usr/bin/bwrap', { bigint: true }) : null;
const selected: BubblewrapCapability = { status: 'available', rejected: [], restriction: null, detail: null, launcher: { source: 'system', path: '/usr/bin/bwrap',
  version: '0.13.0', sha256: null, overlay: true, identity: system ? `${system.dev}:${system.ino}:${system.size}:${system.mtimeNs}:${system.ctimeNs}` : 'absent' } };
const linux = (kernel = { userNamespace: true, landlockAbi: 7, landlockErrno: 0 }, bwrap = false) => ({
  platform: 'linux', bubblewrap: vi.fn(async (): Promise<BubblewrapCapability> => bwrap ? selected : bubblewrapObservation('unavailable')), kernel: vi.fn(async () => kernel),
});

describe('shell realm configuration and measured capabilities (S5)', () => {
  it('defaults an absent section or field to prefer-sandbox without changing schema versions', () => {
    expect(readTerminalShellConfig({}).realm).toBe('prefer-sandbox');
    expect(readTerminalShellConfig({ terminal: { shell: { schemaVersion: 1 } } }).realm).toBe('prefer-sandbox');
    for (const realm of ['host', 'prefer-sandbox', 'require-sandbox']) {
      expect(readTerminalShellConfig({ terminal: { shell: { schemaVersion: 1, realm } } }).realm).toBe(realm);
    }
    expect(() => readTerminalShellConfig({ terminal: { shell: { schemaVersion: 1, realm: 'automatic' } } })).toThrow();
  });
  it('measures bwrap absence, user namespace and Landlock ABI independently', async () => {
    expect(await probeShellCapabilities(linux())).toEqual({ schemaVersion: 2, platform: 'linux', bubblewrap: bubblewrapObservation('unavailable'), userNamespace: 'available',
      landlock: { status: 'available', abi: 7 } });
    expect(await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 38 }, true)))
      .toMatchObject({ bubblewrap: { status: 'available', launcher: { path: '/usr/bin/bwrap' } }, userNamespace: 'unavailable', landlock: { status: 'unavailable', abi: null } });
  });
  it('keeps failed or malformed probes unknown without hiding other measurements', async () => {
    const env = linux(); env.kernel.mockRejectedValue(new Error('helper missing'));
    expect(await probeShellCapabilities(env)).toMatchObject({ bubblewrap: { status: 'unavailable' }, userNamespace: 'unknown', landlock: { status: 'unknown', abi: null } });
    env.kernel.mockResolvedValue({ userNamespace: true, landlockAbi: NaN, landlockErrno: 0 });
    expect(await probeShellCapabilities(env)).toMatchObject({ userNamespace: 'unknown', landlock: { status: 'unknown' } });
  });
  it.each(['darwin', 'win32'])('does not run probes or commands on unsupported %s', async platform => {
    const env = { ...linux(), platform };
    const capabilities = await probeShellCapabilities(env);
    expect(capabilities).toMatchObject({ bubblewrap: { status: 'unsupported', launcher: null }, userNamespace: 'unsupported', landlock: { status: 'unsupported', abi: null } });
    expect(env.kernel).not.toHaveBeenCalled(); expect(env.bubblewrap).not.toHaveBeenCalled();
    for (const mode of ['host', 'prefer-sandbox', 'require-sandbox'] as const) {
      expect(resolveShellRealm(mode, capabilities)).toEqual({ ok: false, code: 'SHELL_REALM_UNSUPPORTED' });
    }
  });
  it('bounds a stuck capability observation and preserves the other independent result', async () => {
    vi.useFakeTimers();
    try {
      const env = linux(); env.bubblewrap.mockImplementation(() => new Promise(() => undefined));
      let result: unknown;
      void probeShellCapabilities(env).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(result).toMatchObject({ bubblewrap: { status: 'unknown', detail: 'launcher probe SHELL_PROBE_TIMEOUT' }, userNamespace: 'available', landlock: { abi: 7 } });
    } finally { vi.useRealTimers(); }
  });
  it('a failed binary observation and a denied ABI query stay unknown independently', async () => {
    const env = linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 1 });
    env.bubblewrap.mockRejectedValue(new Error('probe failed'));
    expect(await probeShellCapabilities(env)).toMatchObject({ bubblewrap: { status: 'unknown', launcher: null }, userNamespace: 'unavailable',
      landlock: { status: 'unknown', abi: null } });
  });
  /** The default view most of this file's assertions care about: an owner-approved standart call (project and its write floor writable,
   * `.git` read-only) — what the static text used to say unconditionally before it became call-derived. */
  const OWNER_APPROVED_STANDART = { projectReadOnly: false, writeFloorReadOnly: false, repositoryWritable: false };
  it('the C11 target independently rejects a refused realm before invoking the runner', async () => {
    const onOutput = vi.fn(), onResult = vi.fn();
    const target = new HostShellTarget('/tmp', { timeoutMs: 1000, extraEnv: [], signal: new AbortController().signal,
      onOutput, onResult, realm: { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' } });
    await expect(target.apply({ input: { command: 'printf must-not-run' } } as never)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    expect(onOutput).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
  });
  it('requires a usable sandbox provider, even if every host capability is present', async () => {
    const capabilities = await probeShellCapabilities(linux(undefined, true));
    expect(resolveShellRealm('require-sandbox', capabilities)).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [] });
    expect(resolveShellRealm('prefer-sandbox', capabilities)).toMatchObject({ ok: true, realm: { kind: 'host' },
      notice: expect.stringContaining('sandbox: none') });
    const host = resolveShellRealm('host', capabilities);
    expect(host).toEqual({ ok: true, realm: hostShellRealm, marker: null, notice: null, posture: expect.any(Function), containment: 'host' });
    // Host has no write boundary: its posture ignores the view entirely (a call from any authority reads the same fixed text).
    expect(host.ok && host.posture(OWNER_APPROVED_STANDART)).toContain('not a sandbox');
  });
  it('S9: takes sandbox providers in preference order, names why each was unusable in the visible fallback, and host mode never picks one', async () => {
    const capabilities = await probeShellCapabilities(linux(undefined, true));
    const realm = { kind: 'bubblewrap' as const, run: vi.fn() };
    const unusable = { kind: 'landlock' as const, usable: vi.fn(() => ({ ok: false as const, reason: 'no-abi' })) };
    const posture = () => 'in a bubblewrap sandbox';
    const usable = { kind: 'bubblewrap' as const, usable: vi.fn(() => ({ ok: true as const, realm, marker: 'sandbox: bubblewrap', posture, notice: null, containment: 'sandbox' as const })) };
    // REALM-NOTICE: a later provider that wins after one was passed over says so (stream/result notice, card posture), whatever the reason.
    const later = resolveShellRealm('prefer-sandbox', capabilities, [unusable, usable]);
    expect(later).toEqual({ ok: true, realm, marker: 'sandbox: bubblewrap', notice: '[deckent] sandbox: bubblewrap instead of landlock (landlock: no-abi).',
      posture: expect.any(Function), containment: 'sandbox', rejected: [{ kind: 'landlock', reason: 'no-abi' }] });
    expect(later.ok && later.posture(OWNER_APPROVED_STANDART)).toBe('in a bubblewrap sandbox\n[deckent] sandbox: bubblewrap instead of landlock (landlock: no-abi).');
    expect(resolveShellRealm('prefer-sandbox', capabilities, [usable])).toEqual({ ok: true, realm, marker: 'sandbox: bubblewrap', notice: null, posture, containment: 'sandbox',
      rejected: [] });
    expect(resolveShellRealm('require-sandbox', capabilities, [usable])).toMatchObject({ ok: true, realm });
    expect(resolveShellRealm('host', capabilities, [usable])).toMatchObject({ ok: true, realm: hostShellRealm, marker: null, notice: null });
    expect(usable.usable).toHaveBeenCalledWith(capabilities);
    expect(resolveShellRealm('prefer-sandbox', capabilities, [unusable])).toMatchObject({ ok: true, realm: hostShellRealm, marker: 'sandbox: none', containment: 'host',
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; .*landlock: no-abi/u) });
    expect(resolveShellRealm('require-sandbox', capabilities, [unusable])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [{ kind: 'landlock', reason: 'no-abi' }] });
  });
  // S9 + S11 merged: the shipped providers in the shipped order, against fake measurements (no sandbox runs here).
  it('picks bubblewrap when usable, Landlock when bubblewrap is not, and names both reasons when neither is', async () => {
    const layout = { project: { root: '/nonexistent', ignoredDirs: new Set<string>(), denied: () => false }, scratchDir: null };
    const providers = [bubblewrapShellSandbox(layout), landlockShellSandbox(layout)];
    const both = await probeShellCapabilities(linux({ userNamespace: true, landlockAbi: 7, landlockErrno: 0 }, true));
    const bwrapUsable = providers[0]!.usable(both).ok;
    expect(resolveShellRealm('prefer-sandbox', both, providers)).toMatchObject(bwrapUsable
      ? { ok: true, realm: { kind: 'bubblewrap' }, marker: 'sandbox: bubblewrap', notice: null, containment: 'sandbox' }
      : { ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', containment: 'sandbox', notice: expect.stringMatching(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: /u) });
    const noBwrap = await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: 7, landlockErrno: 0 }, false));
    const landlockPicked = resolveShellRealm('require-sandbox', noBwrap, providers);
    expect(landlockPicked).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', containment: 'sandbox',
      notice: '[deckent] sandbox: landlock instead of bubblewrap (bubblewrap: bubblewrap unavailable).' });
    expect(landlockPicked.ok && landlockPicked.posture(OWNER_APPROVED_STANDART)).toContain('Landlock');
    expect(resolveShellRealm('prefer-sandbox', await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: 3, landlockErrno: 0 }, false)), providers))
      .toMatchObject({ realm: { kind: 'landlock' }, marker: 'sandbox: degraded', notice: expect.stringContaining('DEGRADED'), containment: 'degraded' });
    const neither = await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 38 }, false));
    expect(resolveShellRealm('prefer-sandbox', neither, providers)).toMatchObject({ ok: true, realm: { kind: 'host' }, marker: 'sandbox: none', containment: 'host',
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; running on host \(bubblewrap: bubblewrap unavailable; landlock: landlock unavailable\)/u) });
    expect(resolveShellRealm('require-sandbox', neither, providers)).toMatchObject({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [{ kind: 'bubblewrap' }, { kind: 'landlock' }] });
  });
  it.skipIf(process.platform !== 'linux')('host delegates to the existing runner without changing output or result fields', async () => {
    const request = { command: 'printf "host-bytes\\n"', cwd: '/tmp', environment: {} };
    const old = await runHostShell(request), current = await hostShellRealm.run(request);
    expect({ ...current, durationMs: 0 }).toEqual({ ...old, durationMs: 0 });
    expect(current.output).toBe('host-bytes\n');
  });
});
