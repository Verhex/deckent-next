import { expect, it } from 'vitest';
import { ModelInvocationPolicyAuthorization } from '#engine/core/policy/index.js';
import { modelInvocationTargetId } from '#engine/core/model-invocation/index.js';

const principal = { id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const target = { scopeId: 's', reference };
const grant = { id: 'invoke-owner', effect: 'allow', actions: ['invoke', 'inspect'], scopes: ['s'],
  principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } };
const policy = { schemaVersion: 1, revision: 'policy-1', grants: [grant], restrictions: [] as object[] };

it('grants only the exact stable-reference target and denies otherwise (C12 Q8: baseline unchanged)', async () => {
  const authorization = new ModelInvocationPolicyAuthorization({ async load() { return policy; } });
  expect(await authorization.authorize('invoke', target, principal)).toEqual({ revision: 'policy-1', ruleId: 'invoke-owner' });
  await expect(authorization.authorize('invoke', { ...target, reference: { ...reference, modelVersion: 3 } }, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const unavailable = new ModelInvocationPolicyAuthorization({ async load() { throw new Error('offline'); } });
  await expect(unavailable.authorize('invoke', target, principal)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
});
it('returns a typed refusal, not denial, when the grant requires approval (C12 Q8: no catalog broker here yet)', async () => {
  const authorization = new ModelInvocationPolicyAuthorization({ async load() { return { ...policy, grants: [{ ...grant, effect: 'require-approval' }] }; } });
  await expect(authorization.authorize('invoke', target, principal)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
});
