import { configuredInvocationProfiles } from '#engine/core/provider-catalog/index.js';
import { verifiedPrincipal } from '#engine/core/authentication/index.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { installationRegistrationSchema, modelInvocationProfileSchema, type ModelUseLease } from '#domain/index.js';
import { attachmentFailure, sameAttachmentPerson } from '#engine/core/project-attachment/index.js';
import { modelInvocationProfileDigest } from '#engine/core/model-invocation/index.js';
import { ModelActivationApplication } from '#engine/core/model-activation/index.js';
import { ModelActivationPolicyAuthorization } from '#engine/core/policy/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { carryModelUseCatalog } from './catalog.js';
import { inspectModelUsePreparation } from './preparation.js';
import type { ModelUseWritePorts } from './ports.js';

/** The witnessed attach action authorizes this join; config and activation are still written only by their applications. */
export async function grantModelUse(ports: ModelUseWritePorts, root: string, scopeId: string, expectedPreparation?: string) {
  const config = await ports.config(root), store = ports.store(config);
  const actor = await ports.authorize(config);
  return store.hold(async () => {
    let registry = await store.registration();
    const context = await ports.shared(config, scopeId, actor);
    if (!registry || !context.source || !context.attachment || !sameAttachmentPerson(registry.source.owner, actor)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const attachment = context.attachment, entry = registry.entries.find(item => item.attachment.projectId === attachment.projectId)!;
    if (entry.modelLease?.state === 'revoked') return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const { source, selected, preparation, selection } = await inspectModelUsePreparation(ports, context.source.projectRoot, context.source.scopeId);
    if (expectedPreparation && preparation.digest !== expectedPreparation) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    // Reauthorization must not overwrite an independently authored target connection or another scope's catalog.
    const existing = configuredInvocationProfiles(config);
    if (existing.some(profile => profile.scopeId === scopeId && (profile.schemaVersion !== 3 || !selected.some(item => isDeepStrictEqual(item.profile.reference, profile.reference)))))
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    if (existing.some(profile => profile.scopeId !== scopeId) && !isDeepStrictEqual(config['provider_catalog'], source.config['provider_catalog']))
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    const leaseId = entry.modelLease?.leaseId ?? randomUUID();
    const targetProfiles = selected.map(({ profile }) => modelInvocationProfileSchema.parse({ ...profile, schemaVersion: 3,
      billingAxis: modelInvocationBillingAxis(profile), scopeId, useLeaseId: leaseId }));
    const lease: ModelUseLease = { schemaVersion: 1, leaseId, state: 'pending', profiles: selected.map(({ profile }, index) => ({ reference: profile.reference,
      sourceDigest: modelInvocationProfileDigest(profile), targetDigest: modelInvocationProfileDigest(targetProfiles[index]!), bindingDigest: profile.bindingDigest })) };
    if (entry.modelLease && !isDeepStrictEqual(entry.modelLease.profiles, lease.profiles)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    if (entry.modelLease?.state === 'active') return entry.modelLease;
    const publish = async (value: ModelUseLease) => { const next = installationRegistrationSchema.parse({ ...registry, schemaVersion: 2,
      entries: registry!.entries.map(item => item.attachment.projectId === attachment.projectId ? { ...item, modelLease: value } : item) });
      await store.write(registry, next); registry = next; };
    await publish(lease);
    const target = await ports.context(root, scopeId);
    const set = (keyPath: string, value: unknown) => ports.write(target, keyPath, value, `${leaseId}.${keyPath}`);
    await set('schema_version', 6);
    if (selected.length) {
      const own = configuredInvocationProfiles(target.config).filter(profile => profile.scopeId !== scopeId);
      await set('provider_catalog', source.config['provider_catalog']);
      if (selection && selected.some(({ profile }) => isDeepStrictEqual(profile.reference, selection))) await set('terminal.chat.reference', selection);
      await set('provider_invocation_profiles', { schemaVersion: 1, profiles: [...own, ...targetProfiles] });
      const current = await ports.context(root, scopeId);
      const app = new ModelActivationApplication(verifiedPrincipal(current.principal),
        new ModelActivationPolicyAuthorization({ load: async () => current.document }), new ModelBindingApplication({ read: async () => current.config['provider_catalog'] }),
        () => ports.activationStore(current), Date.now);
      await carryModelUseCatalog(ports, source, current, targetProfiles, leaseId);
      for (const { profile, binding } of selected) { const before = await ports.activation(current, scopeId, profile.reference);
        await app.admit({ schemaVersion: 1, commandId: `${leaseId}.${profile.id}`, action: 'activate', scopeId,
          reference: profile.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding, expectedRevision: before?.revision ?? 0 }); }
    }
    const active = { ...lease, state: 'active' as const }; await publish(active); return active;
  });
}
export async function revokeModelUse(ports: ModelUseWritePorts, root: string, projectId: string) {
  const config = await ports.config(root), store = ports.store(config);
  const actor = await ports.authorize(config);
  return store.hold(async () => { const current = await store.registration(), entry = current?.entries.find(item => item.attachment.projectId === projectId);
    if (!current || !entry?.modelLease) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    if (!sameAttachmentPerson(actor, current.source.owner)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const next = installationRegistrationSchema.parse({ ...current, entries: current.entries.map(item => item === entry ? { ...item, modelLease: { ...item.modelLease!, state: 'revoked' } } : item) });
    await store.write(current, next); return { schemaVersion: 1, status: 'lease-revoked', projectId };
  });
}
