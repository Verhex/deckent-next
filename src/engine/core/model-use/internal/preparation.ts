import { configuredInvocationProfiles } from '#engine/core/provider-catalog/index.js';
import { createHash } from 'node:crypto';
import { attachmentPreparationSchema } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/core/model-invocation/index.js';
import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { assertModelUseSource } from './read.js';
import type { ModelUseReadPorts } from './ports.js';

/** Read-only consent material. Profile, policy, active-set and budget changes invalidate the preview. */
export async function inspectModelUsePreparation(ports: ModelUseReadPorts, root: string, scopeId: string) {
  const source = await ports.context(root, scopeId), selected = [];
  for (const profile of configuredInvocationProfiles(source.config).filter(item => item.scopeId === scopeId)) {
    try { selected.push({ profile, binding: await assertModelUseSource(ports, source, profile) }); }
    catch (error) { if (!['PROJECT_ATTACHMENT_DENIED', 'MODEL_USE_NOT_ACTIVE', 'MODEL_USE_BINDING_CHANGED', 'POLICY_DENIED'].includes(String((error as { code?: string }).code))) throw error; }
  }
  const selection = await ports.selection(source);
  const digest = createHash('sha256').update(JSON.stringify({ profiles: selected.map(({ profile, binding }) => ({ digest: modelInvocationProfileDigest(profile), binding })),
    budget: source.config['provider_spending'] ?? null, selection, policy: source.document.revision })).digest('hex');
  const preparation = attachmentPreparationSchema.parse({ digest, connections: selected.map(({ profile }) => ({ reference: profile.reference, billing: modelInvocationBillingAxis(profile) })) });
  return { source, selected, preparation, selection };
}
