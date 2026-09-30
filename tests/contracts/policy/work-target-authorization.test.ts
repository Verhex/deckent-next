import { describe, expect, it } from 'vitest';
import { authorizeWorkTargetUse, PolicyAuthorizationError, workTargetAttemptAuthorization } from '#engine/index.js';
import type { AttemptIdentity, VerifiedPrincipal } from '#domain/index.js';

// Sol WT-R1: attempt:execute never substitutes for work-target:use on the consumed target; the attempt gate is never bypassed; a
// require-approval or unavailable target decision never becomes allow.
const principal: VerifiedPrincipal = { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] } as VerifiedPrincipal;
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' } as AttemptIdentity;
const policy = (effect: 'allow' | 'require-approval' | null, actions = ['use']) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants: effect === null ? []
  : [{ id: 'target', effect, actions, scopes: ['s'], principals: [{ issuer: 'host', subject: '1' }], resource: { kind: 'work-target', ids: ['n1'] } }] });
function harness(document: unknown, attemptRefusal: Error | null = null) {
  const attempts: string[] = []; let loads = 0;
  const base = {
    async authorizeIdentity(action: string) { attempts.push(action); if (attemptRefusal) throw attemptRefusal; },
    async authorize(action: string) { attempts.push(action); if (attemptRefusal) throw attemptRefusal; },
  };
  const source = { async load() { loads++; if (document instanceof Error) throw document; return document; } };
  return { attempts, loads: () => loads, authorization: workTargetAttemptAuthorization(base as never, source, 'n1'), base, source };
}

describe('workTargetAttemptAuthorization (engine)', () => {
  it('requires work-target:use for execute on both entry points after the attempt gate; allow passes', async () => {
    const h = harness(policy('allow'));
    await h.authorization.authorizeIdentity('execute', identity, principal);
    await h.authorization.authorize('execute', { identity } as never, principal);
    expect(h.attempts).toEqual(['execute', 'execute']); expect(h.loads()).toBe(2);
  });
  it('refuses execute without a use grant even when the attempt action is granted', async () => {
    const h = harness(policy('allow', ['adopt']));
    await expect(h.authorization.authorizeIdentity('execute', identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(h.authorization.authorize('execute', { identity } as never, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(h.attempts).toEqual(['execute', 'execute']);
  });
  it('never turns require-approval or an unavailable policy into allow', async () => {
    await expect(harness(policy('require-approval')).authorization.authorizeIdentity('execute', identity, principal)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    await expect(harness(new Error('unreadable')).authorization.authorizeIdentity('execute', identity, principal)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    await expect(harness(null).authorization.authorizeIdentity('execute', identity, principal)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
  });
  it('never bypasses a refused attempt action: the target is not consulted', async () => {
    const h = harness(policy('allow'), new PolicyAuthorizationError('POLICY_DENIED'));
    await expect(h.authorization.authorizeIdentity('execute', identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(h.loads()).toBe(0);
  });
  it('maps adopt/rollback to adopt, prepare/deliver integration to use, read/recover-output only for target-reading operations; unchanged without a target', async () => {
    const h = harness(policy('allow', ['adopt']));
    await h.authorization.authorizeIdentity('adopt-integration', identity, principal);
    await h.authorization.authorizeIdentity('rollback-integration', identity, principal);
    await h.authorization.authorizeIdentity('read-output', identity, principal);
    expect(h.loads()).toBe(2);
    await expect(harness(policy('allow')).authorization.authorizeIdentity('adopt-integration', identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Lead WT-R1 extension: prepare/deliver integration always use the target; read/recover-output only where the operation reads it.
    for (const action of ['prepare-integration', 'deliver-integration'] as const) {
      await expect(harness(policy('allow', ['adopt'])).authorization.authorizeIdentity(action, identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    const reading = workTargetAttemptAuthorization(harness(null).base as never, { async load() { return policy('allow', ['adopt']); } }, 'n1', true);
    for (const action of ['read-output', 'recover-output'] as const) await expect(reading.authorizeIdentity(action, identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(harness(policy(null)).authorization.authorizeIdentity('recover-output', identity, principal)).resolves.toBeUndefined();
    await expect(authorizeWorkTargetUse({ async load() { return policy('allow', ['adopt']); } }, 'n1', 's', principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(authorizeWorkTargetUse({ async load() { throw new Error('never read'); } }, null, 's', principal)).resolves.toBeUndefined();
    const plain = harness(policy(null));
    expect(workTargetAttemptAuthorization(plain.base as never, plain.source, null)).toBe(plain.base);
  });
});
