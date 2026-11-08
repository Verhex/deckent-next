import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeModelBindingDefinition, policyResources, modelInvocationProfileSchema, mcpPrincipalRef, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { guardModelUseNative, resolveModelUse, type ModelUseContext, type ModelUseReadPorts } from '#engine/core/model-use/index.js';
import { modelInvocationProfileDigest } from '#engine/core/model-invocation/index.js';
// Exercise admission and recheck through the same public resolver used by composition.
const pinModelUse = (...args: [ModelUseReadPorts, string, ModelInvocationProfile, VerifiedPrincipal]) => resolveModelUse(...args, { action: 'pin' });
const recheckModelUse = (...args: [ModelUseReadPorts, string, ModelInvocationProfile, VerifiedPrincipal, NonNullable<Awaited<ReturnType<typeof pinModelUse>>>]) =>
  resolveModelUse(args[0], args[1], args[2], args[3], { action: 'recheck', pin: args[4] });

const owner = { issuer: 'fixture-host', subject: '1000' };
const person: VerifiedPrincipal = { id: 'person', ...owner, assurance: 'os-user', scopeIds: ['target'] };
const ai: VerifiedPrincipal = { ...person, id: 'ai', ...mcpPrincipalRef(owner) };
const definition = { encodingVersion: 1 as const, provider: { id: 'fixture-provider', version: 1 }, model: { id: 'fixture-model', version: 1,
  nativeId: 'fixture-native', protocols: [{ family: 'fixture-protocol', version: 'v1', capabilities: [] }] } };
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const reference = { providerId: definition.provider.id, providerVersion: 1, modelId: definition.model.id, modelVersion: 1 };
const leaseId = '00000000-0000-4000-8000-000000000001';
function fixture(attached = true) {
  const sourceProfile = modelInvocationProfileSchema.parse({ schemaVersion: 2, billingAxis: 'subscription', id: 'fixture-profile', version: 1, scopeId: 'source',
    reference, bindingDigest: binding.digest, protocol: { family: 'fixture-protocol', version: 'v1' },
    adapter: { id: 'native-cli-headless', version: 1, definition: { schemaVersion: 1, executable: '/fixture/cli', configDir: '/fixture/login', stateDir: '/fixture/state', minCliVersion: '1.0.0', ownerUid: 1000,
      sourceBinding: { schemaVersion: 1, installationId: 'installation', companyId: 'company', scopeId: 'source', principal: owner }, delegatedUse: { consentedBy: owner, atMs: 1, classes: ['ai', 'system'] } } },
    allocation: { id: 'fixture-allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 1000, responseMaxBytes: 1000, timeoutMs: 1000 } });
  let profile: ModelInvocationProfile = modelInvocationProfileSchema.parse({ ...sourceProfile, scopeId: 'target', ...(!attached ? { adapter: { ...sourceProfile.adapter, definition: { ...sourceProfile.adapter.definition, sourceBinding: { schemaVersion: 1, installationId: 'installation', companyId: 'company', scopeId: 'target', principal: owner } } } } : {}), ...(attached ? { schemaVersion: 3, useLeaseId: leaseId } : {}) });
  const context = (scope: string, profile: ModelInvocationProfile): ModelUseContext => ({
    config: { installation: { sharedRegistrationId: scope === 'target' && attached ? 'registration' : undefined }, company: { id: 'company' },
      provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_catalog: { schemaVersion: 1, revision: 'catalog', providers: [
        { id: definition.provider.id, version: 1, models: [definition.model] }] } } as unknown as ModelUseContext['config'],
    document: { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [{ id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: [scope],
      principals: 'all', resource: { kind: policyResources.modelInvocation.kind, ids: 'all' } },
      { id: 'invoke-ai', effect: 'allow', actions: ['invoke'], scopes: [scope], principals: [{ issuer: ai.issuer, subject: ai.subject }],
        resource: { kind: policyResources.modelInvocation.kind, ids: 'all' } }] },
    principal: { ...person, scopeIds: [scope] }, installationId: 'installation' as ModelUseContext['installationId'], projectId: scope as ModelUseContext['projectId'],
    layout: {} as ModelUseContext['layout'], path: async () => 'unused' });
  const source = context('source', sourceProfile), target = context('target', profile);
  const state = { leaseState: 'active', attachmentState: 'active', sourceProfile, source, target, unregistered: false, activation: 'active',
    retained: { reference, sourceDigest: modelInvocationProfileDigest(sourceProfile), targetDigest: modelInvocationProfileDigest(profile), bindingDigest: binding.digest }, leaseId };
  const ports: ModelUseReadPorts = {
    config: async () => target.config, context: async root => root === 'source-root' ? source : target,
    shared: async () => ({ source: { owner, projectRoot: 'source-root', projectId: source.projectId, scopeId: 'source' } }) as never,
    store: () => ({ registration: async () => ({ unregistered: state.unregistered,
      entries: [{ attachment: { projectId: target.projectId }, state: state.attachmentState, modelLease: { schemaVersion: 1, state: state.leaseState, leaseId: state.leaseId, profiles: [state.retained] } }] }) }) as never,
    activation: async (_context, scopeId) => ({ schemaVersion: 1, scopeId, reference, revision: 1, state: state.activation, catalogRevision: 'catalog', definition, binding }) as never,
    selection: async () => null, catalogReader: async () => { throw new Error('not needed'); },
  };
  const replace = (next: ModelInvocationProfile) => { profile = next; Object.assign(target.config, { provider_invocation_profiles: { schemaVersion: 1, profiles: [next] } }); return next; };
  return { ports, state, profile, replace };
}

it('pins only authority identities and digests, and revalidates an unchanged direct person connection', async () => {
  const f = fixture(false), pin = await pinModelUse(f.ports, 'target-root', f.profile, person);
  expect(pin).toMatchObject({ scopeId: 'target', installationId: 'installation', companyId: 'company', principal: personWithoutScopes(), lease: null });
  expect(Object.keys(pin!).sort()).toEqual(['companyId', 'installationId', 'lease', 'principal', 'profileDigest', 'projectId', 'schemaVersion', 'scopeId']);
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!)).resolves.toBeUndefined();
});
const personWithoutScopes = () => ({ id: person.id, issuer: person.issuer, subject: person.subject, assurance: person.assurance });

it('rejects another person using a direct subscription even under an all-principals invocation policy', async () => {
  const f = fixture(false);
  await expect(resolveModelUse(f.ports, 'target-root', f.profile, { ...person, subject: '1001' })).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
});
it('checks current delegation before native send and refuses changed consent without sending', async () => {
  const f = fixture(false), pin = await pinModelUse(f.ports, 'target-root', f.profile, ai), send = vi.fn();
  const port = guardModelUseNative({ prepare: vi.fn(), send }, () => recheckModelUse(f.ports, 'target-root', f.profile, ai, pin!));
  f.replace({ ...f.profile, adapter: { ...f.profile.adapter, definition: { ...f.profile.adapter.definition, delegatedUse: null } } });
  await expect(port.send({})).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' }); expect(send).not.toHaveBeenCalled();
  await expect(resolveModelUse(f.ports, 'target-root', { ...f.profile, adapter: { ...f.profile.adapter, definition: { ...f.profile.adapter.definition, delegatedUse: null } } }, ai))
    .rejects.toMatchObject({ code: 'HEADLESS_DELEGATION_REFUSED' });
});
describe('an admitted ONCE connection never grants a revoked or pending job an effect', () => {
  it('refuses a pending lease before an effect', async () => {
    const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person), effect = vi.fn(); f.state.leaseState = 'pending';
    await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!).then(effect)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    expect(effect).not.toHaveBeenCalled();
  });
  it('refuses a revoked lease on every subsequent send, measure and pre-spawn check', async () => {
    const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person), send = vi.fn(async () => ({ state: 'ok' }) as never), measure = vi.fn(async () => null);
    const check = () => recheckModelUse(f.ports, 'target-root', f.profile, person, pin!);
    const port = guardModelUseNative({ prepare: vi.fn(), send, measure }, check);
    await port.send({}); expect(send).toHaveBeenCalledTimes(1); f.state.leaseState = 'revoked';
    await expect(port.send({})).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await expect(port.measure!({})).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    const spawn = vi.fn(); await expect(check().then(spawn)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    expect(send).toHaveBeenCalledTimes(1); expect(measure).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
  it('does not revive admitted work after restore publishes a new lease and profile', async () => {
    const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person);
    f.state.leaseId = '00000000-0000-4000-8000-000000000002';
    const restored = f.replace(modelInvocationProfileSchema.parse({ ...f.profile, useLeaseId: f.state.leaseId }));
    f.state.retained.targetDigest = modelInvocationProfileDigest(restored);
    await expect(resolveModelUse(f.ports, 'target-root', restored, person)).resolves.toBeTruthy();
    await expect(recheckModelUse(f.ports, 'target-root', restored, person, pin!)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
  });
  it('rejects a changed source digest even when the target profile still matches admission', async () => {
    const f = fixture(); f.state.retained.sourceDigest = '0'.repeat(64);
    await expect(pinModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
  });
  it('rejects a changed target digest before source use', async () => {
    const f = fixture(); f.state.retained.targetDigest = '0'.repeat(64);
    await expect(pinModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  });
  it('cannot erase a revoked lease by downgrading the profile version', async () => {
    const f = fixture(); f.state.leaseState = 'revoked'; const { useLeaseId: omitted, ...plain } = f.profile as Extract<ModelInvocationProfile, { schemaVersion: 3 }>; void omitted;
    await expect(resolveModelUse(f.ports, 'target-root', modelInvocationProfileSchema.parse({ ...plain, schemaVersion: 2 }), person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  });
  it('refuses an unregistered source rather than trusting its retained active lease', async () => {
    const f = fixture(); f.state.unregistered = true;
    await expect(resolveModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  });
});
it('binds an admitted pin to its exact principal even for two actors acting for the same person', async () => {
  const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, ai);
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, { ...ai, id: 'another-ai' }, pin!)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
});
it('refuses another company even when source and target were both moved together', async () => {
  const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person);
  Object.assign(f.state.source.config.company, { id: 'other-company' }); Object.assign(f.state.target.config.company, { id: 'other-company' });
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
});
it('refuses another installation even when source and target now agree on the new installation', async () => {
  const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person);
  Object.assign(f.state.source, { installationId: 'other-installation' }); Object.assign(f.state.target, { installationId: 'other-installation' });
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
});
it('rechecks source activation and target policy rather than treating a pin as permission', async () => {
  const f = fixture(), pin = await pinModelUse(f.ports, 'target-root', f.profile, person); f.state.activation = 'inactive';
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!)).rejects.toMatchObject({ code: 'MODEL_USE_NOT_ACTIVE' });
  f.state.activation = 'active'; Object.assign(f.state.target.document, { grants: [] });
  await expect(recheckModelUse(f.ports, 'target-root', f.profile, person, pin!)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
it('cannot issue a subscription pin without existing installation and project identities', async () => {
  const f = fixture(false); Object.assign(f.state.target, { installationId: null });
  await expect(pinModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  Object.assign(f.state.target, { installationId: 'installation', projectId: null });
  await expect(pinModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
});
it('observes an inactive direct connection without granting invocation or a pin', async () => {
  const f = fixture(false); f.state.activation = 'inactive';
  await expect(resolveModelUse(f.ports, 'target-root', f.profile, person, { action: 'inspect' })).resolves.toBeNull();
  await expect(resolveModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'MODEL_USE_NOT_ACTIVE' });
  await expect(pinModelUse(f.ports, 'target-root', f.profile, person)).rejects.toMatchObject({ code: 'MODEL_USE_NOT_ACTIVE' });
  await expect(resolveModelUse(f.ports, 'target-root', f.profile, { ...person, subject: '1001' }, { action: 'inspect' }))
    .rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  // A profile whose binding no longer matches the catalog names that reason (reconnect), not a generic denial.
  f.state.activation = 'active'; const stale = f.replace({ ...f.profile, bindingDigest: '0'.repeat(64) });
  await expect(pinModelUse(f.ports, 'target-root', stale, person)).rejects.toMatchObject({ code: 'MODEL_USE_BINDING_CHANGED' });
});

it('refuses a copied direct person-only connection on first use in another installation, company, scope or principal', async () => {
  const effect = vi.fn();
  const installation = fixture(false); Object.assign(installation.state.target, { installationId: 'copied-installation' });
  await expect(resolveModelUse(installation.ports, 'target-root', installation.profile, person).then(effect)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  const company = fixture(false); Object.assign(company.state.target.config.company, { id: 'copied-company' });
  await expect(resolveModelUse(company.ports, 'target-root', company.profile, person).then(effect)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  const scope = fixture(false), copied = scope.replace({ ...scope.profile, scopeId: 'copied-scope' });
  await expect(resolveModelUse(scope.ports, 'target-root', copied, { ...person, scopeIds: ['copied-scope'] }).then(effect)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  const principal = fixture(false); Object.assign(principal.state.target, { principal: { ...person, issuer: 'copied-host' } });
  await expect(resolveModelUse(principal.ports, 'target-root', principal.profile, { ...person, issuer: 'copied-host' }).then(effect)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  expect(effect).not.toHaveBeenCalled();
});
it('reads legacy definitions without silently manufacturing source authority at inspect, admission or send', async () => {
  const f = fixture(false), { sourceBinding, ...legacy } = f.profile.adapter.definition; void sourceBinding;
  const profile = f.replace({ ...f.profile, adapter: { ...f.profile.adapter, definition: legacy } });
  const before = JSON.stringify(profile);
  await expect(resolveModelUse(f.ports, 'target-root', profile, person, { action: 'inspect' })).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
  await expect(pinModelUse(f.ports, 'target-root', profile, person)).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
  expect(JSON.stringify(profile)).toBe(before);
});
