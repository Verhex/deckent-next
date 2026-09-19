import { createHash } from 'node:crypto';
import { identitySchema, immutableJsonObjectSchema } from '#domain/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '#platform/index.js';
import type { PreparedInstallation } from './application.js';
import type { InstallationEvidencePreview } from './evidence.js';
import { createInstallationRecovery, validateInstallationRecovery, type InstallationConsent } from './recovery.js';

export type InstallationResource = 'policy' | 'ledger' | 'config';
export interface InstallationPublishTarget {
  readonly resource: InstallationResource; readonly path: string; readonly content: string; readonly digest: string;
}
export interface InstallationPublicationPorts {
  /** Caller owns the fixed config lock for this whole application invocation. */
  readonly journal: {
    observe(): Promise<BootstrapObservation>;
    write(expected: BootstrapObservation, next: BootstrapJournalPayload): Promise<BootstrapObservation>;
  };
  inspectPreimage(target: InstallationPublishTarget): Promise<string | null>;
  publish(target: InstallationPublishTarget, transactionId: string): Promise<void>;
  verify(target: InstallationPublishTarget, transactionId: string): Promise<void>;
  revalidateEvidence(): Promise<InstallationEvidencePreview>;
  now(): number;
}
export class InstallationPublicationError extends Error {
  constructor(readonly code: 'INSTALLATION_PUBLICATION_INVALID' | 'INSTALLATION_PUBLICATION_CONFLICT'
    | 'INSTALLATION_PUBLICATION_CHANGED') { super(code); this.name = 'InstallationPublicationError'; }
}
function canonical(input: unknown): string {
  const result = immutableJsonObjectSchema.safeParse(input);
  if (!result.success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return JSON.stringify(result.data);
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return value;
}
export function installationPublishTargets(prepared: PreparedInstallation, evidence: InstallationEvidencePreview, transactionId: string) {
  const id = identitySchema.parse(transactionId);
  const material: Record<InstallationResource, unknown> = { config: prepared.material.configuration,
    policy: prepared.material.authoredProfile.policy,
    ledger: { ownership: { schemaVersion: 1, transactionId: id, planDigest: prepared.preview.planDigest,
      profileDigest: prepared.preview.profile.digest, proposalDigest: evidence.proposalDigest }, pool: prepared.preview.pool } };
  return Object.freeze((['policy', 'ledger', 'config'] as const).map(resource => {
    const path = prepared.material.paths[resource];
    if (!path) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const content = `${canonical(material[resource])}\n`;
    return Object.freeze({ resource, path, content, digest: createHash('sha256').update(content, 'utf8').digest('hex') });
  }));
}

/** Fresh installation and exact recovery share this sequence. This application never
 * overwrites a pre-existing unrelated resource, treats progress as proof of current bytes,
 * or converts custom local consent into publisher authenticity.
 */
export class InstallationPublicationApplication {
  constructor(private readonly ports: InstallationPublicationPorts) {}
  async apply(prepared: PreparedInstallation, evidence: InstallationEvidencePreview, consent: InstallationConsent) {
    const recovery = createInstallationRecovery(prepared, evidence, consent);
    const targets = installationPublishTargets(prepared, evidence, consent.id);
    let observed = await this.ports.journal.observe();
    if (observed.record) {
      if (observed.record.transactionId !== consent.id || observed.record.planDigest !== prepared.preview.planDigest
        || observed.record.profileDigest !== prepared.preview.profile.digest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
      validateInstallationRecovery(observed.record.recovery, prepared);
      if (canonical(observed.record.recovery) !== canonical(recovery)) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
      if (observed.record.resources.length !== targets.length || targets.some(target => !observed.record!.resources.some(resource =>
        resource.resource === target.resource && resource.path === target.path && resource.targetDigest === target.digest
        && (resource.preimageDigest === null || (target.resource !== 'ledger' && resource.preimageDigest === target.digest))))) {
        throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
      }
    } else {
      const preimages = new Map<InstallationResource, string | null>();
      for (const target of targets) {
        const preimage = await this.ports.inspectPreimage(target);
        if (preimage !== null && (target.resource === 'ledger' || preimage !== target.digest)) {
          throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
        }
        preimages.set(target.resource, preimage);
      }
      const now = timestamp(this.ports.now());
      const payload: BootstrapJournalPayload = { schemaVersion: 2, transactionId: consent.id,
        planDigest: prepared.preview.planDigest, profileDigest: prepared.preview.profile.digest,
        phase: 'pending', createdAtMs: now, updatedAtMs: now, blockers: ['INSTALLATION_NOT_APPLIED'],
        resources: targets.map(target => ({ resource: target.resource, path: target.path, preimageDigest: preimages.get(target.resource)!,
          targetDigest: target.digest, state: 'pending' })), recovery: immutableJsonObjectSchema.parse(recovery) };
      await this.assertEvidence(evidence);
      observed = await this.ports.journal.write(observed, payload);
    }
    if (!observed.record) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    await this.assertEvidence(evidence);
    if (observed.record.phase === 'committed') {
      for (const target of targets) await this.ports.verify(target, consent.id);
      await this.assertEvidence(evidence);
      return this.result(prepared, evidence, consent.id, 'replayed');
    }
    for (const target of targets) {
      // Even published progress must be re-observed: a prior process may have died after an effect.
      await this.ports.publish(target, consent.id);
      await this.ports.verify(target, consent.id);
      const { checksum: ignored, ...current } = observed.record!; void ignored;
      observed = await this.ports.journal.write(observed, { ...current, updatedAtMs: timestamp(this.ports.now()),
        resources: current.resources.map(resource => resource.resource === target.resource ? { ...resource, state: 'published' as const } : resource) });
    }
    for (const target of targets) await this.ports.verify(target, consent.id);
    await this.assertEvidence(evidence);
    const { checksum: ignored, ...current } = observed.record!; void ignored;
    await this.ports.journal.write(observed, { ...current, phase: 'committed', blockers: [], updatedAtMs: timestamp(this.ports.now()) });
    return this.result(prepared, evidence, consent.id, 'installed');
  }
  private async assertEvidence(expected: InstallationEvidencePreview) {
    if (canonical(await this.ports.revalidateEvidence()) !== canonical(expected)) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
  }
  private result(prepared: PreparedInstallation, evidence: InstallationEvidencePreview, transactionId: string, status: 'installed' | 'replayed') {
    return Object.freeze({ schemaVersion: 1 as const, status, transactionId, planDigest: prepared.preview.planDigest,
      proposalDigest: evidence.proposalDigest, profile: prepared.preview.profile, paths: prepared.preview.paths,
      trust: Object.freeze({ mode: 'operator-custom' as const, publisherVerification: 'unverified' as const }) });
  }
}
