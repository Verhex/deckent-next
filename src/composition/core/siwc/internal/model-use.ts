import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import type { ModelInvocationProfile, VerifiedPrincipal } from '#domain/index.js';
import { attachmentFailure } from '#engine/index.js';
import { SIWC_INFERENCE } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { resolveConfiguredModelUse } from '#composition/core/model-use/index.js';
import { withConfiguredSiwc } from './connection.js';
/** Only a validated model-use lease selects another scope. The OAuth owner's scope and custody stay untouched. */
export async function withConfiguredSiwcModel<T>(root: string, profile: ModelInvocationProfile, actor: VerifiedPrincipal,
  options: ConfigLoadOptions, operation: 'lease' | 'inspect', work: Parameters<typeof withConfiguredSiwc<T>>[4], snapshot?: ModelInspectionSnapshot) {
  if (profile.adapter.id !== SIWC_INFERENCE.adapter.id) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  const use = await resolveConfiguredModelUse(root, profile, actor, options, operation === 'inspect' ? snapshot : undefined);
  if (!use) return withConfiguredSiwc(root, profile.scopeId, options, operation, work, {}, actor, operation === 'inspect' ? snapshot : undefined);
  // The source's verified actor retains the caller's class; a lease is never a person promotion.
  return withConfiguredSiwc(use.source.config.projectRoot, use.sourceProfile.scopeId, options, operation, work, {},
    { ...actor, scopeIds: [use.sourceProfile.scopeId] }, operation === 'inspect' ? snapshot : undefined);
}
