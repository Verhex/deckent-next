import type { ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { integrationCommandSchema, integrationManifestSchema, integrationIntentSchema, type IntegrationTarget, type IntegrationManifest, type IntegrationStore, patchDigest, WorkspacePatchError } from '#engine/core/workspace-patch-contract/index.js';
import { WorkspacePatchApplication } from './application.js';
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
  async check(input: unknown, credential?: unknown, reuse = false) {
    const preview = await this.patches.preview(input, credential, reuse);
    const observation = await this.target.observe(preview.patch);
    // The scope classification is reported, not hashed into the proposal: the mode is configuration and may change between check and prepare.
    return Object.freeze({ schemaVersion: 1 as const, identity: preview.patch.identity, patch: preview.receipt, observation, scope: preview.scope,
      proposal: proposalCode({ identity: preview.patch.identity, patch: preview.receipt, observation }), application: 'not-applied' as const });
  }
  async prepare(input: unknown, store: IntegrationStore, credential?: unknown) {
    const command = integrationCommandSchema.parse(input), principal = await authenticate(this.verifier, credential, command.identity.scopeId);
    const authorize = () => this.authorization.authorizeIdentity('prepare-integration', command.identity, principal);
    await authorize();
    const checked = await this.check(command.identity, credential, true);
    if (checked.proposal !== command.proposal) throw new WorkspacePatchError('PATCH_CONFLICT');
    this.patches.assertScope(checked.scope); // K6 enforce: refused before the integration intent or any candidate file is written
    const intent = integrationIntentSchema.parse({ schemaVersion: 1, command, patch: checked.patch, observation: checked.observation.digest,
      actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
    const claim = await store.claimIntegration(intent), preview = await this.patches.preview(command.identity, credential, true);
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
    const bytes = Buffer.from(JSON.stringify(manifest)); if (bytes.length > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const receipt = claim.record.manifest ?? await this.artifacts.put(command.identity.scopeId, bytes); if (claim.acquired) await store.finishIntegration(intent, receipt);
    return Object.freeze({ schemaVersion: 1 as const, status: 'candidate-prepared' as const, manifest, receipt });
  }
}
