import { expect, it } from 'vitest';
import { ServicePolicyAuthorization } from '#engine/index.js';

const principal = { id: 'local-user', issuer: 'installation', subject: '1000', assurance: 'os-user' as const, scopeIds: ['service-scope'] };
const target = { scopeId: 'service-scope', serviceId: 'runtime' };
const grant = { id: 'shutdown-grant', effect: 'allow', actions: ['shutdown'], scopes: ['service-scope'],
  principals: [{ issuer: 'installation', subject: '1000' }], resource: { kind: 'service', ids: ['runtime'] } };
const policy = { schemaVersion: 1, revision: 'policy-1', restrictions: [], grants: [grant] };

it('returns the exact current service grant for durable audit without inheriting Run authority', async () => {
  const authorization = new ServicePolicyAuthorization({ async load() { return policy; } });
  await expect(authorization.authorize(target, principal)).resolves.toEqual({ revision: 'policy-1', ruleId: 'shutdown-grant' });
  const projectOnly = new ServicePolicyAuthorization({ async load() { return { ...policy,
    grants: [{ ...grant, actions: 'all', resource: { kind: 'run', ids: 'all' } }] }; } });
  await expect(projectOnly.authorize(target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('requires matching target, scope, principal and explicit action even for the socket owner', async () => {
  const authorization = new ServicePolicyAuthorization({ async load() { return policy; } });
  for (const other of [{ ...target, scopeId: 'foreign' }, { ...target, serviceId: 'another-service' }]) {
    await expect(authorization.authorize(other, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  }
  await expect(authorization.authorize(target, { ...principal, subject: '0' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const otherAction = new ServicePolicyAuthorization({ async load() { return { ...policy,
    grants: [{ ...grant, actions: ['inspect'] }] }; } });
  await expect(otherAction.authorize(target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('reauthorizes every call and keeps deny/restrictions stronger than a previous grant', async () => {
  let current: unknown = policy; let reads = 0;
  const authorization = new ServicePolicyAuthorization({ async load() { reads++; return current; } });
  await authorization.authorize(target, principal);
  current = { ...policy, revision: 'revoked', grants: [] };
  await expect(authorization.authorize(target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  current = { ...policy, restrictions: [{ id: 'deny', actions: 'all', scopes: 'all', principals: 'all', resource: grant.resource }] };
  await expect(authorization.authorize(target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(reads).toBe(3);
});

it('rejects invalid or unavailable policy without returning private source errors', async () => {
  for (const load of [async () => ({ invalid: true }), async () => { throw new Error('private-source-detail'); }]) {
    const authorization = new ServicePolicyAuthorization({ load });
    await expect(authorization.authorize(target, principal)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE', message: 'POLICY_UNAVAILABLE' });
  }
});
