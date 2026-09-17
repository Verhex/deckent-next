import { describe, expect, it } from 'vitest';
import { AttemptApplication, authenticate, type AttemptStore } from '#engine/index.js';
import { LocalOsPrincipalVerifier } from '#adapters/index.js';
import { userInfo, hostname } from 'node:os';

const principal = { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'token-verified', scopeIds: ['scope'] };
const request = { schemaVersion: 2, commandId: 'command', scopeId: 'scope', action: { kind: 'create', identity: {
  runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 'scope', generation: 1, layoutRevision: 'layout' } } };
describe('verified execution identity boundary', () => {
  it('rejects client principal claims, weak verifier output and foreign scope before store access', async () => {
    let reads = 0; const store: AttemptStore = { async load() { reads++; return null; }, async receipt() { reads++; return null; }, async commit() { throw new Error('unreachable'); } };
    const policy = { async authorize() {} };
    const app = new AttemptApplication(store, policy, { async verify() { return principal; } });
    await expect(app.execute({ ...request, principalId: 'administrator' })).rejects.toThrow();
    await expect(app.execute({ ...request, schemaVersion: 1 })).rejects.toThrow();
    for (const assurance of ['unverified', 'token-parsed']) {
      const weak = new AttemptApplication(store, policy, { async verify() { return { ...principal, assurance }; } });
      await expect(weak.execute(request)).rejects.toThrow('AUTHENTICATION_REQUIRED');
    }
    await expect(app.execute({ ...request, scopeId: 'foreign', action: { kind: 'cancel', attemptId: 'attempt' } })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
    expect(reads).toBe(0);
  });
  it('sanitizes verifier failures and freezes verification results', async () => {
    await expect(authenticate({ async verify() { throw new Error('secret-token'); } }, 'secret-token', 'scope')).rejects.toThrow('AUTHENTICATION_REQUIRED');
    const verified = await authenticate({ async verify() { return principal; } }, undefined, 'scope');
    expect(Object.isFrozen(verified)).toBe(true); expect(Object.isFrozen(verified.scopeIds)).toBe(true);
  });
  it('derives a local principal from the OS, refusing supplied identity credentials', async () => {
    const verifier = new LocalOsPrincipalVerifier(['scope']);
    const local = await authenticate(verifier, undefined, 'scope');
    expect(local).toMatchObject({ subject: String(userInfo().uid), issuer: hostname(), assurance: 'os-user' });
    await expect(authenticate(verifier, { principalId: 'root' }, 'scope')).rejects.toThrow('AUTHENTICATION_REQUIRED');
  });
});
