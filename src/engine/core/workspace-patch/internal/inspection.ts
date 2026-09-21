import { z } from 'zod';
import { attemptIdentitySchema, identitySchema, sameAttemptIdentity } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { integrationManifestSchema, type IntegrationRecord, type IntegrationManifest } from './integration.js';
import { WorkspacePatchError } from './contract.js';
export const integrationQuerySchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  commandId: identitySchema }).strict().readonly();
export type IntegrationQuery = z.infer<typeof integrationQuerySchema>;
export interface IntegrationReader { loadIntegration(query: IntegrationQuery): Promise<IntegrationRecord | null> }
/** Historical custody inspection only: no Git, candidate writes or current-file verification. */
export class WorkspaceIntegrationInspection {
  constructor(private readonly reader: IntegrationReader, private readonly artifacts: ArtifactStore,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization,
    private readonly maxBytes: number) {}
  async inspect(input: unknown, credential?: unknown) {
    const query = integrationQuerySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, query.identity.scopeId);
    await this.authorization.authorizeIdentity('read-output', query.identity, principal);
    const record = await this.reader.loadIntegration(query);
    if (record && (!sameAttemptIdentity(record.intent.command.identity, query.identity) || record.intent.command.commandId !== query.commandId))
      throw new WorkspacePatchError('PATCH_CORRUPT');
    let manifest: IntegrationManifest | null = null;
    if (record?.manifest) {
      if (record.manifest.byteLength > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
      try { manifest = integrationManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        await this.artifacts.read(query.identity.scopeId, record.manifest)))); }
      catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
      if (JSON.stringify(manifest.command) !== JSON.stringify(record.intent.command)
        || JSON.stringify(manifest.patch) !== JSON.stringify(record.intent.patch) || manifest.observation !== record.intent.observation)
        throw new WorkspacePatchError('PATCH_CORRUPT');
    }
    const status = !record ? 'absent' : manifest ? 'manifest-recorded' : 'pending';
    return Object.freeze({ schemaVersion: 1 as const, query, status, intent: record?.intent ?? null,
      receipt: record?.manifest ?? null, manifest, candidateVerification: 'not-performed' as const });
  }
}
