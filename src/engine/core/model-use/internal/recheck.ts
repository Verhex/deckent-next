import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationProfile, VerifiedPrincipal } from '#domain/index.js';
import { attachmentFailure } from '#engine/core/project-attachment/index.js';
import { modelInvocationProfileDigest } from '#engine/core/model-invocation/index.js';
import type { inspectModelUse } from './read.js';

/** Trusted admission evidence only, never an ingress capability or a substitute for fresh authorization. Contains no login material. */
export interface ModelUsePin {
  readonly schemaVersion: 1;
  readonly scopeId: string; readonly installationId: string; readonly projectId: string; readonly companyId: string;
  readonly principal: Readonly<{ id: string; issuer: string; subject: string; assurance: VerifiedPrincipal['assurance'] }>;
  readonly profileDigest: string;
  readonly lease: Readonly<{ leaseId: string; sourceProjectId: string; sourceScopeId: string; sourceDigest: string }> | null;
}
/** Pin the exact snapshot already authorized by the shared resolver; never reload an unauthorised context. */
export function pinModelUse(profile: ModelInvocationProfile, actor: VerifiedPrincipal,
  { use, target }: NonNullable<Awaited<ReturnType<typeof inspectModelUse>>>): ModelUsePin {
  if (!target.installationId || !target.projectId) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  return Object.freeze({ schemaVersion: 1, scopeId: profile.scopeId, installationId: target.installationId, projectId: target.projectId,
    companyId: target.config.company.id, principal: Object.freeze({ id: actor.id, issuer: actor.issuer, subject: actor.subject, assurance: actor.assurance }),
    profileDigest: modelInvocationProfileDigest(profile), lease: use ? Object.freeze({ leaseId: use.lease.leaseId, sourceProjectId: use.source.projectId!,
      sourceScopeId: use.sourceProfile.scopeId, sourceDigest: modelInvocationProfileDigest(use.sourceProfile) }) : null });
}
/** Restore, queue exit, tool admission and spawn retain the admission pin rather than silently repinning. */
export function recheckModelUse(current: ModelUsePin | null, pin: ModelUsePin): void {
  if (!current || !isDeepStrictEqual(current, pin)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
}
