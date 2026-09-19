import { expect, it } from 'vitest';
import { ModelActivationPolicyAuthorization } from '#engine/core/policy/index.js';
import { modelActivationTargetId } from '#engine/core/model-activation/index.js';

const principal = { id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const target = { scopeId: 's', reference };
const grant = { id: 'model-owner', effect: 'allow', actions: ['activate', 'deactivate'], scopes: ['s'],
  principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'model-activation', ids: [modelActivationTargetId(reference)] } };

it('requires explicit stable-reference grants and applies current deny before returning audit evidence', async () => {
  let policy = { schemaVersion: 1, revision: 'policy-1', grants: [grant], restrictions: [] as object[] };
  const authorization = new ModelActivationPolicyAuthorization({ async load() { return policy; } });
  expect(await authorization.authorize('activate', target, principal)).toEqual({ revision: 'policy-1', ruleId: 'model-owner' });
  await expect(authorization.authorize('activate', { ...target, reference: { ...reference, modelVersion: 3 } }, principal)).rejects.toThrow('POLICY_DENIED');
  await expect(authorization.authorize('deactivate', { ...target, scopeId: 'foreign' }, principal)).rejects.toThrow('POLICY_DENIED');
  policy = { ...policy, revision: 'policy-2', grants: [grant, { ...grant, id: 'blocked', effect: 'deny' }] };
  await expect(authorization.authorize('deactivate', target, principal)).rejects.toThrow('POLICY_DENIED');
});
it('does not grant activation from vocabulary membership or unavailable policy', async () => {
  const empty = new ModelActivationPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'none', grants: [], restrictions: [] }; } });
  await expect(empty.authorize('activate', target, principal)).rejects.toThrow('POLICY_DENIED');
  const unavailable = new ModelActivationPolicyAuthorization({ async load() { throw new Error('offline'); } });
  await expect(unavailable.authorize('deactivate', target, principal)).rejects.toThrow('POLICY_UNAVAILABLE');
});
