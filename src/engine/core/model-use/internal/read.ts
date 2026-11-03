import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson } from '#engine/core/project-attachment/index.js';
import { modelInvocationProfileDigest, subscriptionActor } from '#engine/core/model-invocation/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { ModelInvocationPolicyAuthorization } from '#engine/core/policy/index.js';
import type { ModelUseReadPorts, ModelUseContext } from './ports.js';

export const modelUseProfiles = (config: Readonly<Record<string, unknown>>) =>
  ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
/** Current binding, active set and source policy, never a historical connect receipt. */
export async function assertModelUseSource(ports: ModelUseReadPorts, context: ModelUseContext, profile: ModelInvocationProfile, actor: VerifiedPrincipal = context.principal) {
  if (profile.schemaVersion === 3) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  await new ModelInvocationPolicyAuthorization({ load: async () => context.document }).authorize('invoke', profile, actor);
  const binding = await new ModelBindingApplication({ read: async () => context.config['provider_catalog'] }).inspect(profile.reference);
  if (binding.status !== 'declared' || binding.binding.digest !== profile.bindingDigest) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const active = await ports.activation(context, profile.scopeId, profile.reference);
  if (!active || active.state !== 'active' || active.binding?.digest !== binding.binding.digest) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const activationRevision = active.revision;
  return { ...binding, activationRevision };
}
/** Rechecked at preview, admission and every send. The two scopes remain separate authorities. */
export async function resolveModelUse(ports: ModelUseReadPorts, root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal) {
  if (profile.schemaVersion !== 3 && !(await ports.config(root)).installation.sharedRegistrationId) return null;
  const target = await ports.context(root, profile.scopeId);
  if (!target.config.installation.sharedRegistrationId) {
    if (profile.schemaVersion === 3) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    return null;
  }
  const context = await ports.shared(target.config, profile.scopeId, subscriptionActor(actor).owner);
  const registry = await ports.store(target.config).registration();
  const entry = registry?.entries.find(item => item.attachment.projectId === target.projectId), lease = entry?.modelLease;
  const retained = lease?.profiles.find(item => isDeepStrictEqual(item.reference, profile.reference));
  // A config write cannot erase a revoked lease by downgrading its profile version.
  if (profile.schemaVersion !== 3) { if (retained) return attachmentFailure('PROJECT_ATTACHMENT_DENIED'); return null; }
  if (!registry || !context.source || !entry || entry.state !== 'active' || lease?.state !== 'active' || lease.leaseId !== profile.useLeaseId
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
  return { source, sourceProfile, target, lease };
}
