import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, identitySchema, verifiedPrincipalSchema, type AuditEvent } from '#domain/index.js';
import { digestText, serializeJsonDocument } from '#platform/index.js';
import { ConfigApplicationError, type ConfigAuthorityPort, type ConfigDocumentPort, type ConfigWriteInput } from './contract.js';
import { allConfigKeys, configFieldView, configPath, definitionFor } from './registry.js';
import { planConfigChange, validateConfigLayers } from './planner.js';
/** One configuration application contract shared by every surface; no filesystem or policy document ownership here. */
export class ConfigApplication {
  constructor(private readonly documents: ConfigDocumentPort, private readonly authority: ConfigAuthorityPort) {}
  async inspect(input: { readonly keyPath?: string; readonly layer?: 'project' | 'global' } = {}) {
    const snapshot = await this.documents.snapshot(input.layer ?? 'project');
    const keys = input.keyPath === undefined ? allConfigKeys(snapshot) : [input.keyPath];
    return { schemaVersion: 1 as const, digest: snapshot.digest, layer: snapshot.layer, fields: keys.map(key => configFieldView(snapshot, key)) };
  }
  async explain(input: { readonly keyPath: string }) { const snapshot = await this.documents.snapshot('project'); return configFieldView(snapshot, input.keyPath); }
  async validate() { validateConfigLayers(await this.documents.snapshot('project')); return { valid: true as const }; }
  async set(input: ConfigWriteInput) { return this.change(input, false); }
  async unset(input: ConfigWriteInput) { return this.change(input, true); }
  private async change(input: ConfigWriteInput, unset: boolean) {
    identitySchema.parse(input.commandId); identitySchema.parse(input.scopeId); verifiedPrincipalSchema.parse(input.principal);
    if (input.layer !== undefined && input.layer !== 'project' && input.layer !== 'global') throw new ConfigApplicationError('CONFIG_LAYER_INVALID');
    if (input.expect !== undefined && input.expect !== null && !/^[a-f0-9]{64}$/.test(input.expect)) throw new ConfigApplicationError('CONFIG_DIGEST_INVALID');
    // Pure admission checks happen before authority/IO; never inspect or log secret values.
    if (configPath(input.keyPath)[0] === 'secrets') throw new ConfigApplicationError('CONFIG_SECRET_SECTION_REFUSED');
    definitionFor(input.keyPath);
    await this.authority.authorize(input);
    return this.documents.publish(input, async snapshot => {
      if (input.expect !== undefined && input.expect !== snapshot.digest) throw new ConfigApplicationError('CONFIG_CONCURRENT_REVISION_HOLD');
      const document = planConfigChange(snapshot.document, input.keyPath, input.value, unset); validateConfigLayers(snapshot, document);
      const revision = await this.authority.authorize(input);
      const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId,
        principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: revision, atMs: Date.now(),
        subject: { kind: 'config-change' as const, action: unset ? 'unset' as const : 'set' as const, layer: snapshot.layer,
          keyPath: input.keyPath, commandId: input.commandId, beforeDigest: snapshot.digest, afterDigest: digestText(serializeJsonDocument(document)) } };
      await this.authority.audit(event); return { document, event };
    });
  }
}
