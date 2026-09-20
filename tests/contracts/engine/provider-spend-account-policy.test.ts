import { expect, it } from 'vitest';
import { ProviderSpendAccountPolicyAuthorization } from '#engine/index.js';

const principal = { id: 'operator', issuer: 'os', subject: '1000', assurance: 'os-user' as const, scopeIds: ['scope'] };
const target = { scopeId: 'scope', budgetId: 'shared-budget', budgetRevision: 1 };
const grant = { id: 'account-inspect', effect: 'allow', actions: ['inspect'], scopes: ['scope'],
  principals: [{ issuer: 'os', subject: '1000' }], resource: { kind: 'provider-spend-account', ids: ['shared-budget'] } };

it('requires an account-specific grant rather than a model invocation inspection grant', async () => {
  const authorization = new ProviderSpendAccountPolicyAuthorization({ async load() {
    return { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [
      { ...grant, resource: { kind: 'model-invocation', ids: 'all' } },
    ] };
  } });
  await expect(authorization.authorize('inspect', target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('checks the exact account and scope against the current policy for every inspection', async () => {
  let granted = true;
  const authorization = new ProviderSpendAccountPolicyAuthorization({ async load() {
    return { schemaVersion: 1, revision: granted ? 'enabled' : 'revoked', restrictions: [], grants: granted ? [grant] : [] };
  } });
  await expect(authorization.authorize('inspect', target, principal)).resolves.toEqual({ revision: 'enabled', ruleId: 'account-inspect' });
  await expect(authorization.authorize('inspect', { ...target, budgetId: 'other' }, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(authorization.authorize('inspect', { ...target, scopeId: 'other' }, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  granted = false;
  await expect(authorization.authorize('inspect', target, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('does not expose policy backend errors or grant access when policy cannot load', async () => {
  const authorization = new ProviderSpendAccountPolicyAuthorization({ async load() { throw new Error('private policy path'); } });
  await expect(authorization.authorize('inspect', target, principal)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE', message: 'POLICY_UNAVAILABLE' });
});
