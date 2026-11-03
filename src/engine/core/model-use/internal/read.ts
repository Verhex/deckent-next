import { isDeepStrictEqual } from 'node:util';
import { delegatedUseOf, subscriptionDelegationRefusal, modelInvocationProfileSchema, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson } from '#engine/core/project-attachment/index.js';
import { modelInvocationProfileDigest, subscriptionActor } from '#engine/core/model-invocation/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { ModelInvocationPolicyAuthorization } from '#engine/core/policy/index.js';
import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import type { ModelUseReadPorts, ModelUseContext } from './ports.js';
import { pinModelUse, recheckModelUse, type ModelUsePin } from './recheck.js';

export const modelUseProfiles = (config: Readonly<Record<string, unknown>>) =>
  ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
/** Current binding, active set and source policy, never a historical connect receipt. */
export async function assertModelUseSource(ports: ModelUseReadPorts, context: ModelUseContext, profile: ModelInvocationProfile, actor: VerifiedPrincipal = context.principal) {
  if (profile.schemaVersion === 3) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  assertModelUsePerson(context, profile, actor);
  await new ModelInvocationPolicyAuthorization({ load: async () => context.document }).authorize('invoke', profile, actor);
  const binding = await new ModelBindingApplication({ read: async () => context.config['provider_catalog'] }).inspect(profile.reference);
  if (binding.status !== 'declared' || binding.binding.digest !== profile.bindingDigest) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const active = await ports.activation(context, profile.scopeId, profile.reference);
  if (!active || active.state !== 'active' || active.binding?.digest !== binding.binding.digest) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const activationRevision = active.revision;
  return { ...binding, activationRevision };
}
/** Rechecked at preview, admission and every send. The two scopes remain separate authorities. */
export function resolveModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal, check: { action: 'pin' }): Promise<ModelUsePin | null>;
export function resolveModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal, check: { action: 'recheck'; pin: ModelUsePin }): Promise<void>;
export function resolveModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal): Promise<NonNullable<Awaited<ReturnType<typeof inspectModelUse>>>['use']>;
export async function resolveModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal, check?: { action: 'pin' } | { action: 'recheck'; pin: ModelUsePin }) {
  const resolved = await inspectModelUse(ports, root, profile, actor);
  if (!check) return resolved?.use ?? null;
  const pin = resolved && (profile.schemaVersion === 3 || modelInvocationBillingAxis(profile) === 'subscription') ? pinModelUse(profile, actor, resolved) : null;
  if (check.action === 'recheck') return recheckModelUse(pin, check.pin);
  return pin;
}
/** Internal snapshot shared by resolution and admission pins: authorize exactly the context being pinned. */
export async function inspectModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal) {
  const subscription = modelInvocationBillingAxis(profile) === 'subscription';
  if (profile.schemaVersion !== 3 && !subscription && !(await ports.config(root)).installation.sharedRegistrationId) return null;
  const target = await ports.context(root, profile.scopeId);
  if (!target.config.installation.sharedRegistrationId) {
    if (profile.schemaVersion === 3) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    if (subscription) await assertFreshModelUse(ports, target, profile, actor);
    return { target, use: null };
  }
  assertModelUsePerson(target, profile, actor);
  const context = await ports.shared(target.config, profile.scopeId, subscriptionActor(actor).owner);
  const registry = await ports.store(target.config).registration();
  const entry = registry?.entries.find(item => item.attachment.projectId === target.projectId), lease = entry?.modelLease;
  const retained = lease?.profiles.find(item => isDeepStrictEqual(item.reference, profile.reference));
  // A config write cannot erase a revoked lease by downgrading its profile version.
  if (profile.schemaVersion !== 3) {
    if (retained) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    if (subscription) await assertFreshModelUse(ports, target, profile, actor);
    return { target, use: null };
  }
  if (!registry || registry.unregistered || !context.source || !entry || entry.state !== 'active' || lease?.state !== 'active' || lease.leaseId !== profile.useLeaseId
    || !retained || retained.targetDigest !== modelInvocationProfileDigest(profile) || !actor.scopeIds.includes(profile.scopeId)
    || !sameAttachmentPerson(context.source.owner, subscriptionActor(actor).owner)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const fresh = modelUseProfiles(target.config).find(item => item.id === profile.id && item.scopeId === profile.scopeId);
  if (!fresh || modelInvocationProfileDigest(fresh) !== retained.targetDigest) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  await new ModelInvocationPolicyAuthorization({ load: async () => target.document }).authorize('invoke', profile, actor);
  const source = await ports.context(context.source.projectRoot, context.source.scopeId);
  if (source.installationId !== target.installationId || source.projectId !== context.source.projectId || source.config.company.id !== target.config.company.id)
    return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const sourceProfile = modelUseProfiles(source.config).find(item => item.scopeId === context.source!.scopeId && isDeepStrictEqual(item.reference, profile.reference));
  if (!sourceProfile || modelInvocationProfileDigest(sourceProfile) !== retained.sourceDigest || sourceProfile.bindingDigest !== retained.bindingDigest)
    return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  await assertModelUseSource(ports, source, sourceProfile, { ...actor, scopeIds: [sourceProfile.scopeId] });
  return { target, use: { source, sourceProfile, target, lease } };
}

/** Person-only connections remain bound to the local owner; a workload needs that owner's current class consent. */
function assertModelUsePerson(context: ModelUseContext, profile: ModelInvocationProfile, actor: VerifiedPrincipal) {
  if (modelInvocationBillingAxis(profile) !== 'subscription') return;
  const caller = subscriptionActor(actor), owner = subscriptionActor(context.principal).owner;
  if (!actor.scopeIds.includes(profile.scopeId) || !sameAttachmentPerson(caller.owner, owner)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const definition = profile.adapter.definition, uid = definition['ownerUid'], connectedOwner = definition['owner'];
  if (uid !== undefined && String(uid) !== owner.subject) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  if (connectedOwner !== undefined && !isDeepStrictEqual(connectedOwner, owner)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const refusal = subscriptionDelegationRefusal({ billing: 'subscription', ...caller, consent: delegatedUseOf(definition) });
  if (refusal) throw new ModelUseDelegationError(refusal);
}

async function assertFreshModelUse(ports: ModelUseReadPorts, target: ModelUseContext, profile: ModelInvocationProfile, actor: VerifiedPrincipal) {
  const fresh = modelUseProfiles(target.config).find(item => item.id === profile.id && item.scopeId === profile.scopeId);
  if (!fresh || modelInvocationProfileDigest(fresh) !== modelInvocationProfileDigest(profile)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  await assertModelUseSource(ports, target, fresh, actor);
}

/** Preserve the shared delegation rule's typed reason without importing a transport or renderer into this owner. */
class ModelUseDelegationError extends Error {
  constructor(readonly code: NonNullable<ReturnType<typeof subscriptionDelegationRefusal>>) { super(code); this.name = 'ModelUseDelegationError'; }
}
