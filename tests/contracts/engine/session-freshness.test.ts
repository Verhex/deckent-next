import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { authenticateSession, assertSessionActive } from '../../../src/engine/core/authentication/index.js';
import { LocalOsSessionAuthority } from '../../../src/adapters/core/local-principal/index.js';
import type { TrustedClock } from '../../../src/platform/core/clock/index.js';

const clock = () => {
  const sample = { wallMs: 1000, monotonicMs: 100 };
  return { sample, port: { sample: () => ({ ...sample }) } satisfies TrustedClock };
};
describe('live local session authority', () => {
  it('authenticates only exact scope-bound evidence without changing the principal contract', async () => {
    const c = clock(); const a = await LocalOsSessionAuthority.create(['scope-a'], 100, c.port);
    const result = await authenticateSession(a, a, c.port, undefined, 'scope-a');
    expect(Object.keys(result.principal).sort()).toEqual(['assurance', 'id', 'issuer', 'scopeIds', 'subject']);
    await expect(authenticateSession(a, a, c.port, 'static-bearer', 'scope-a')).rejects.toThrow('SESSION_REQUIRED');
    await expect(authenticateSession(a, a, c.port, undefined, 'scope-b')).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
    expect(await a.isSessionActive({ ...result.session, scopeIds: ['scope-b'] })).toBe(false);
    await a.revoke(result.session.sessionId);
    expect(await a.isSessionActive(result.session)).toBe(false);
  });
  it.each(['wall-forward', 'wall-backward', 'monotonic-expired', 'monotonic-backward'] as const)('never revives a %s lease', async mode => {
    const c = clock(); const a = await LocalOsSessionAuthority.create(['scope'], 100, c.port);
    const { session } = await a.verifySession(undefined);
    if (mode === 'wall-forward') c.sample.wallMs = 1100;
    if (mode === 'wall-backward') c.sample.wallMs = 999;
    if (mode === 'monotonic-expired') c.sample.monotonicMs = 200;
    if (mode === 'monotonic-backward') c.sample.monotonicMs = 99;
    expect(await a.isSessionActive(session)).toBe(false);
    c.sample.wallMs = 1000; c.sample.monotonicMs = 100;
    expect(await a.isSessionActive(session)).toBe(false);
  });
  it('rechecks expiry after asynchronous reauthentication and live authority checks', async () => {
    const c = clock(); const a = await LocalOsSessionAuthority.create(['scope'], 100, c.port);
    const verified = await a.verifySession(undefined);
    const delayed = { verifySession: async () => { c.sample.wallMs = 1100; return verified; } };
    await expect(authenticateSession(delayed, a, c.port, undefined, 'scope')).rejects.toThrow('SESSION_EXPIRED');
    c.sample.wallMs = 1000;
    const authority = { revoke: async () => undefined, isSessionActive: async () => { c.sample.wallMs = 1100; return true; } };
    await expect(assertSessionActive(verified.session, authority, c.port)).rejects.toThrow('SESSION_EXPIRED');
  });
  it('rejects mismatched identity and future authentication even with an affirmative authority', async () => {
    const c = clock(); const a = await LocalOsSessionAuthority.create(['scope'], 100, c.port);
    const verified = await a.verifySession(undefined);
    const future = { ...verified, session: { ...verified.session, authenticatedAt: 1001 } };
    await expect(authenticateSession({ verifySession: async () => future }, a, c.port, undefined, 'scope')).rejects.toThrow('SESSION_EXPIRED');
    const forged = { ...verified, session: { ...verified.session, principalRef: { ...verified.session.principalRef, subject: 'other' } } };
    await expect(authenticateSession({ verifySession: async () => forged }, a, c.port, undefined, 'scope')).rejects.toThrow('SESSION_REQUIRED');
  });
  it('a killed real process cannot retain its decision session', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      await once(child, 'spawn');
      const c = clock(); const a = await LocalOsSessionAuthority.create(['scope'], 100, c.port, { pid: child.pid!, uid: process.getuid!() });
      const { session } = await a.verifySession(undefined);
      expect(await a.isSessionActive(session)).toBe(true);
      child.kill(); await exited;
      expect(await a.isSessionActive(session)).toBe(false);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
  });
  it('connection revocation invalidates an otherwise live process lease', async () => {
    const c = clock(); const connection = new AbortController();
    const a = await LocalOsSessionAuthority.create(['scope'], 100, c.port,
      { pid: process.pid, uid: process.getuid!(), connection: connection.signal });
    const { session } = await a.verifySession(undefined); connection.abort();
    expect(await a.isSessionActive(session)).toBe(false);
  });
});
