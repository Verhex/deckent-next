import { z } from 'zod';
import { attemptIdentitySchema, identitySchema } from '#domain/index.js';
import { artifactReceiptSchema, type ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { WorkspacePatchApplication } from './application.js';
import { patchDigest, WorkspacePatchError, type WorkspacePatch } from './contract.js';
export const integrationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, replacesCommandId: identitySchema.optional(), proposal: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{20}$/) }).strict().readonly();
export type IntegrationCommand = z.infer<typeof integrationCommandSchema>;
export interface IntegrationObservation { readonly digest: string; readonly source: string; readonly head: string }
export const integrationManifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('integration-candidate'),
  command: integrationCommandSchema, patch: artifactReceiptSchema, observation: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: z.string().min(1), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  application: z.literal('candidate-only') }).strict().readonly();
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export const integrationIntentSchema = z.object({ schemaVersion: z.literal(1), command: integrationCommandSchema,
  patch: artifactReceiptSchema, observation: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict() }).strict().readonly();
export type IntegrationIntent = z.infer<typeof integrationIntentSchema>;
export interface IntegrationRecord { readonly intent: IntegrationIntent; readonly manifest: z.infer<typeof artifactReceiptSchema> | null }
export interface IntegrationStore {
  claimIntegration(intent: IntegrationIntent): Promise<{ readonly acquired: boolean; readonly record: IntegrationRecord }>;
  finishIntegration(intent: IntegrationIntent, manifest: z.infer<typeof artifactReceiptSchema>): Promise<void>;
}
export interface IntegrationTarget {
  observe(patch: WorkspacePatch): Promise<IntegrationObservation>;
  prepare(intent: IntegrationIntent, patch: WorkspacePatch): Promise<IntegrationManifest>;
  verify(manifest: IntegrationManifest, patch: WorkspacePatch): Promise<void>;
}
function proposalCode(value: unknown) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const hash = BigInt('0x' + patchDigest(JSON.stringify(value)));
  return Array.from({ length: 20 }, (_, index) => alphabet[Number((hash >> BigInt(index * 5)) & 31n)]).join('');
}
/** Candidate preparation has its own authority and durable intent; it never accepts a Task. */
export class WorkspaceIntegrationApplication {
  constructor(private readonly patches: WorkspacePatchApplication, private readonly target: IntegrationTarget,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization,
    private readonly artifacts: ArtifactStore, private readonly maxBytes: number) {}
  async check(input: unknown, credential?: unknown) {
    const preview = await this.patches.preview(input, credential);
    const observation = await this.target.observe(preview.patch);
    return Object.freeze({ schemaVersion: 1 as const, identity: preview.patch.identity, patch: preview.receipt, observation,
      proposal: proposalCode({ identity: preview.patch.identity, patch: preview.receipt, observation }), application: 'not-applied' as const });
  }
  async prepare(input: unknown, store: IntegrationStore, credential?: unknown) {
    const command = integrationCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('prepare-integration', command.identity, principal);
    await authorize();
    const checked = await this.check(command.identity, credential);
    if (checked.proposal !== command.proposal) throw new WorkspacePatchError('PATCH_CONFLICT');
    const intent = integrationIntentSchema.parse({ schemaVersion: 1, command, patch: checked.patch, observation: checked.observation.digest,
      actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
    const claim = await store.claimIntegration(intent);
    const preview = await this.patches.preview(command.identity, credential);
    let manifest: IntegrationManifest;
    if (!claim.acquired) {
      // An interrupted writer is not silently resumed or stolen. Its candidate stays held.
      if (!claim.record.manifest) throw new WorkspacePatchError('PATCH_INTEGRATION_PENDING');
      if (claim.record.manifest.byteLength > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
      try { manifest = integrationManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        await this.artifacts.read(command.identity.scopeId, claim.record.manifest)))); }
      catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
      if (JSON.stringify(manifest.command) !== JSON.stringify(command) || JSON.stringify(manifest.patch) !== JSON.stringify(intent.patch)
        || manifest.observation !== intent.observation) throw new WorkspacePatchError('PATCH_CORRUPT');
    } else {
      await authorize();
      manifest = integrationManifestSchema.parse(await this.target.prepare(intent, preview.patch));
    }
    await this.target.verify(manifest, preview.patch);
    if ((await this.check(command.identity, credential)).proposal !== command.proposal) throw new WorkspacePatchError('PATCH_CONFLICT');
    await authorize();
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const receipt = claim.record.manifest ?? await this.artifacts.put(command.identity.scopeId, bytes);
    if (claim.acquired) await store.finishIntegration(intent, receipt);
    return Object.freeze({ schemaVersion: 1 as const, status: 'candidate-prepared' as const, manifest, receipt });
  }
}
