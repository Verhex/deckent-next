import { describe, expect, it, vi } from 'vitest';
import { probeShellCapabilities, resolveShellRealm, hostShellRealm, runHostShell, HostShellTarget, landlockShellSandbox } from '#adapters/core/host-shell/index.js';
import { bubblewrapShellSandbox } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { readTerminalShellConfig } from '#adapters/core/contract/index.js';

const linux = (kernel = { userNamespace: true, landlockAbi: 7, landlockErrno: 0 }, bwrap = false) => ({
  platform: 'linux', findBubblewrap: vi.fn(async () => bwrap), kernel: vi.fn(async () => kernel),
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
    expect(await probeShellCapabilities(linux())).toEqual({ platform: 'linux', bubblewrap: 'unavailable', userNamespace: 'available',
      landlock: { status: 'available', abi: 7 } });
    expect(await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 38 }, true)))
      .toMatchObject({ bubblewrap: 'available', userNamespace: 'unavailable', landlock: { status: 'unavailable', abi: null } });
  });
  it('keeps failed or malformed probes unknown without hiding other measurements', async () => {
    const env = linux(); env.kernel.mockRejectedValue(new Error('helper missing'));
    expect(await probeShellCapabilities(env)).toMatchObject({ bubblewrap: 'unavailable', userNamespace: 'unknown', landlock: { status: 'unknown', abi: null } });
    env.kernel.mockResolvedValue({ userNamespace: true, landlockAbi: NaN, landlockErrno: 0 });
    expect(await probeShellCapabilities(env)).toMatchObject({ userNamespace: 'unknown', landlock: { status: 'unknown' } });
  });
  it.each(['darwin', 'win32'])('does not run probes or commands on unsupported %s', async platform => {
    const env = { ...linux(), platform };
    const capabilities = await probeShellCapabilities(env);
    expect(capabilities).toMatchObject({ bubblewrap: 'unsupported', userNamespace: 'unsupported', landlock: { status: 'unsupported', abi: null } });
    expect(env.kernel).not.toHaveBeenCalled(); expect(env.findBubblewrap).not.toHaveBeenCalled();
    for (const mode of ['host', 'prefer-sandbox', 'require-sandbox'] as const) {
      expect(resolveShellRealm(mode, capabilities)).toEqual({ ok: false, code: 'SHELL_REALM_UNSUPPORTED' });
    }
  });
  it('bounds a stuck capability observation and preserves the other independent result', async () => {
    vi.useFakeTimers();
    try {
      const env = linux(); env.findBubblewrap.mockImplementation(() => new Promise(() => undefined));
      let result: unknown;
      void probeShellCapabilities(env).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(result).toMatchObject({ bubblewrap: 'unknown', userNamespace: 'available', landlock: { abi: 7 } });
    } finally { vi.useRealTimers(); }
  });
  it('a failed binary observation and a denied ABI query stay unknown independently', async () => {
    const env = linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 1 });
    env.findBubblewrap.mockRejectedValue(new Error('probe failed'));
    expect(await probeShellCapabilities(env)).toMatchObject({ bubblewrap: 'unknown', userNamespace: 'unavailable',
      landlock: { status: 'unknown', abi: null } });
  });
  it('the C11 target independently rejects a refused realm before invoking the runner', async () => {
    const onOutput = vi.fn(), onResult = vi.fn();
    const target = new HostShellTarget('/tmp', { timeoutMs: 1000, extraEnv: [], signal: new AbortController().signal,
      onOutput, onResult, realm: { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' } });
    await expect(target.apply({ input: { command: 'printf must-not-run' } } as never)).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    expect(onOutput).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
  });
  it('requires a usable sandbox provider, even if every host capability is present', async () => {
    const capabilities = await probeShellCapabilities(linux(undefined, true));
    expect(resolveShellRealm('require-sandbox', capabilities)).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
    expect(resolveShellRealm('prefer-sandbox', capabilities)).toMatchObject({ ok: true, realm: { kind: 'host' },
      notice: expect.stringContaining('sandbox: none') });
    expect(resolveShellRealm('host', capabilities)).toEqual({ ok: true, realm: hostShellRealm, marker: null, notice: null, posture: expect.stringContaining('not a sandbox'),
      containment: 'host' });
  });
  it('S9: takes sandbox providers in preference order, names why each was unusable in the visible fallback, and host mode never picks one', async () => {
    const capabilities = await probeShellCapabilities(linux(undefined, true));
    const realm = { kind: 'bubblewrap' as const, run: vi.fn() };
    const unusable = { kind: 'landlock' as const, usable: vi.fn(() => ({ ok: false as const, reason: 'no-abi' })) };
    const usable = { kind: 'bubblewrap' as const, usable: vi.fn(() => ({ ok: true as const, realm, marker: 'sandbox: bubblewrap', posture: 'in a bubblewrap sandbox', notice: null, containment: 'sandbox' as const })) };
    expect(resolveShellRealm('prefer-sandbox', capabilities, [unusable, usable])).toEqual({ ok: true, realm, marker: 'sandbox: bubblewrap', notice: null, posture: 'in a bubblewrap sandbox',
      containment: 'sandbox' });
    expect(resolveShellRealm('require-sandbox', capabilities, [usable])).toMatchObject({ ok: true, realm });
    expect(resolveShellRealm('host', capabilities, [usable])).toMatchObject({ ok: true, realm: hostShellRealm, marker: null, notice: null });
    expect(usable.usable).toHaveBeenCalledWith(capabilities);
    expect(resolveShellRealm('prefer-sandbox', capabilities, [unusable])).toMatchObject({ ok: true, realm: hostShellRealm, marker: 'sandbox: none', containment: 'host',
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; .*landlock: no-abi/u) });
    expect(resolveShellRealm('require-sandbox', capabilities, [unusable])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
  });
  // S9 + S11 merged: the shipped providers in the shipped order, against fake measurements (no sandbox runs here).
  it('picks bubblewrap when usable, Landlock when bubblewrap is not, and names both reasons when neither is', async () => {
    const layout = { project: { root: '/nonexistent', ignoredDirs: new Set<string>(), denied: () => false }, scratchDir: null };
    const providers = [bubblewrapShellSandbox(layout, { binaryPaths: ['/usr/bin/bwrap'] }), landlockShellSandbox(layout)];
    const both = await probeShellCapabilities(linux({ userNamespace: true, landlockAbi: 7, landlockErrno: 0 }, true));
    const bwrapUsable = providers[0]!.usable(both).ok;
    expect(resolveShellRealm('prefer-sandbox', both, providers)).toMatchObject(bwrapUsable
      ? { ok: true, realm: { kind: 'bubblewrap' }, marker: 'sandbox: bubblewrap', notice: null, containment: 'sandbox' }
      : { ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', containment: 'sandbox' });
    const noBwrap = await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: 7, landlockErrno: 0 }, false));
    expect(resolveShellRealm('require-sandbox', noBwrap, providers)).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', notice: null,
      posture: expect.stringContaining('Landlock'), containment: 'sandbox' });
    expect(resolveShellRealm('prefer-sandbox', await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: 3, landlockErrno: 0 }, false)), providers))
      .toMatchObject({ realm: { kind: 'landlock' }, marker: 'sandbox: degraded', notice: expect.stringContaining('DEGRADED'), containment: 'degraded' });
    const neither = await probeShellCapabilities(linux({ userNamespace: false, landlockAbi: -1, landlockErrno: 38 }, false));
    expect(resolveShellRealm('prefer-sandbox', neither, providers)).toMatchObject({ ok: true, realm: { kind: 'host' }, marker: 'sandbox: none', containment: 'host',
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; running on host \(bubblewrap: bubblewrap unavailable; landlock: landlock unavailable\)/u) });
    expect(resolveShellRealm('require-sandbox', neither, providers)).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
  });
  it.skipIf(process.platform !== 'linux')('host delegates to the existing runner without changing output or result fields', async () => {
    const request = { command: 'printf "host-bytes\\n"', cwd: '/tmp', environment: {} };
    const old = await runHostShell(request), current = await hostShellRealm.run(request);
    expect({ ...current, durationMs: 0 }).toEqual({ ...old, durationMs: 0 });
    expect(current.output).toBe('host-bytes\n');
  });
});
