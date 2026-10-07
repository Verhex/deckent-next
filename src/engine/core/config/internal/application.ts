import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, CONFIG_CHANGE_DISPLAY_MAX, encodeCommandProjection, identitySchema, verifiedPrincipalSchema, type AuditEvent } from '#domain/index.js';
import { digestText, serializeJsonDocument, sha256 } from '#platform/index.js';
import { ConfigApplicationError, type ConfigApprovalPort, type ConfigAuthorityPort, type ConfigChangeOutcome, type ConfigChangeSubject, type ConfigDocumentPort,
  type ConfigSnapshot, type ConfigWriteInput, type ConfigWritePermission } from './contract.js';
import { allConfigKeys, atConfigPath, configDisplayText, configFieldView, configPath, definitionFor } from './registry.js';
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
  /**
   * T3 L4 `/config` locks: what the principal's current policy says of a write of each key on each layer — one policy read for all of them
   * when the approval port can batch. A display read only: nothing is written, planned or admitted, and every `submit` decides again.
   * `secrets.*` is `refused` (no write reaches it); without an approval port there is no decision to read (null).
   */
  async permissions(input: { readonly principal: ConfigWriteInput['principal']; readonly scopeId: string; readonly keys: readonly string[];
    readonly layers: readonly ('project' | 'global')[] }): Promise<readonly ConfigWritePermission[] | null> {
    const approvals = this.authority.approvals;
    if (!approvals) return null;
    const pairs = input.keys.flatMap(keyPath => input.layers.map(layer => ({ keyPath, layer })));
    const asked = pairs.filter(pair => configPath(pair.keyPath)[0] !== 'secrets');
    const writes = asked.map(pair => ({ keyPath: pair.keyPath, layer: pair.layer, principal: input.principal, scopeId: input.scopeId, commandId: randomUUID() }));
    const decided = approvals.evaluateMany ? await approvals.evaluateMany(writes) : await Promise.all(writes.map(write => approvals.evaluate(write)
      .then(value => ({ decision: value.decision, ruleId: value.ruleId }), (error: unknown) => {
        if ((error as { code?: unknown })?.code === 'POLICY_DENIED') return { decision: 'deny' as const, ruleId: null };
        throw error;
      })));
    const byPair = new Map(asked.map((pair, index) => [`${pair.layer}:${pair.keyPath}`, decided[index]!]));
    return pairs.map(pair => {
      const found = byPair.get(`${pair.layer}:${pair.keyPath}`);
      return Object.freeze({ keyPath: pair.keyPath, layer: pair.layer, decision: found?.decision ?? 'refused', ruleId: found?.ruleId ?? null });
    });
  }
  /** Allow-only write (unchanged contract): a policy `require-approval` is `POLICY_APPROVAL_UNSUPPORTED`. */
  async set(input: ConfigWriteInput) { return this.change(input, false); }
  async unset(input: ConfigWriteInput) { return this.change(input, true); }
  /**
   * The approval-aware write of every human surface (T3 L2 CONFIG-APPROVAL, Jev 9181d2be). `allow`: the same write as `set`/`unset`.
   * `require-approval`: the value is planned and validated, then a `config-change` approval for exactly this command, layer, key, value and
   * previewed layer digest is opened (or found) and reported pending — nothing is written. The same command submitted again after an `allow`
   * applies once, under the layer lock, only if the layer digest is still the previewed one (else `CONFIG_APPROVAL_STALE`: preview again) and
   * the current policy still permits it; the write is audited like every config write. Deny and expiry are the broker's typed refusals.
   */
  async submit(action: 'set' | 'unset', input: ConfigWriteInput): Promise<ConfigChangeOutcome> {
    const unset = action === 'unset', approvals = this.authority.approvals;
    this.admitInput(input);
    if (!approvals) return { status: 'applied', result: await this.change(input, unset), approvalId: null };
    if ((await approvals.evaluate(input)).decision === 'allow') return { status: 'applied', result: await this.write(input, unset, approvals, null), approvalId: null };
    const preview = await this.documents.snapshot(input.layer ?? 'project');
    if (input.expect !== undefined && input.expect !== preview.digest) throw new ConfigApplicationError('CONFIG_APPROVAL_STALE');
    validateConfigLayers(preview, planConfigChange(preview.document, input.keyPath, input.value, unset));
    // Re-evaluated on the previewed state: the rule that asks is the one the card names.
    const authorization = await approvals.evaluate(input);
    if (authorization.decision === 'allow') return { status: 'applied', result: await this.write(input, unset, approvals, null), approvalId: null };
    const subject = configChangeSubject(preview, input, unset, authorization.ruleId ?? 'policy');
    const admission = await approvals.admit(input, subject, authorization);
    if ('pending' in admission) return { status: 'approval-pending', commandId: input.commandId, expect: preview.digest, keyPath: input.keyPath, layer: preview.layer, approval: admission.pending };
    return { status: 'applied', result: await this.write(input, unset, approvals, subject), approvalId: admission.approved.approvalId };
  }
  private admitInput(input: ConfigWriteInput) {
    identitySchema.parse(input.commandId); identitySchema.parse(input.scopeId); verifiedPrincipalSchema.parse(input.principal);
    if (input.layer !== undefined && input.layer !== 'project' && input.layer !== 'global') throw new ConfigApplicationError('CONFIG_LAYER_INVALID');
    if (input.expect !== undefined && input.expect !== null && !/^[a-f0-9]{64}$/.test(input.expect)) throw new ConfigApplicationError('CONFIG_DIGEST_INVALID');
    // Pure admission checks happen before authority/IO; never inspect or log secret values.
    if (configPath(input.keyPath)[0] === 'secrets') throw new ConfigApplicationError('CONFIG_SECRET_SECTION_REFUSED');
    definitionFor(input.keyPath);
  }
  private async change(input: ConfigWriteInput, unset: boolean) {
    this.admitInput(input);
    await this.authority.authorize(input);
    return this.write(input, unset, null, null);
  }
  /**
   * The one write under the layer lock. `approved` (a config-change subject whose approval was found allowed): the layer must still be at its
   * previewed digest, and the current policy must still permit the write — an `allow`, or a `require-approval` whose stored allow of this exact
   * change is still within its admission window. Without an approval port the allow-only authorization decides, as before.
   */
  private write(input: ConfigWriteInput, unset: boolean, approvals: ConfigApprovalPort | null, approved: ConfigChangeSubject | null) {
    return this.documents.publish(input, async snapshot => {
      if (approved && snapshot.digest !== approved.expectDigest) throw new ConfigApplicationError('CONFIG_APPROVAL_STALE');
      if (input.expect !== undefined && input.expect !== snapshot.digest) throw new ConfigApplicationError('CONFIG_CONCURRENT_REVISION_HOLD');
      const document = planConfigChange(snapshot.document, input.keyPath, input.value, unset); validateConfigLayers(snapshot, document);
      let revision: string, approvalId: string | null = null;
      if (!approvals) revision = await this.authority.authorize(input);
      else {
        const current = await approvals.evaluate(input);
        if (current.decision === 'require-approval') {
          if (!approved) throw new ConfigApplicationError('CONFIG_APPROVAL_REQUIRED');
          const admission = await approvals.admit(input, approved, current);
          if (!('approved' in admission)) throw new ConfigApplicationError('CONFIG_APPROVAL_REQUIRED');
          approvalId = admission.approved.approvalId;
        }
        revision = current.revision;
      }
      const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId,
        principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: revision, atMs: Date.now(),
        subject: { kind: 'config-change' as const, action: unset ? 'unset' as const : 'set' as const, layer: snapshot.layer,
          keyPath: input.keyPath, commandId: input.commandId, beforeDigest: snapshot.digest, afterDigest: digestText(serializeJsonDocument(document)),
          ...(approvalId === null ? {} : { approvalId }) } };
      await this.authority.audit(event); return { document, event };
    });
  }
}
/** The approval subject of one previewed change: display copies are redacted and bounded; the exact value is bound by its digest only. */
function configChangeSubject(snapshot: ConfigSnapshot, input: ConfigWriteInput, unset: boolean, ruleId: string): ConfigChangeSubject {
  const path = configPath(input.keyPath);
  return Object.freeze({ kind: 'config-change' as const, commandId: input.commandId, action: unset ? 'unset' as const : 'set' as const, layer: snapshot.layer,
    keyPath: input.keyPath, before: configDisplayText(snapshot, input.keyPath, atConfigPath(snapshot.effective, path), CONFIG_CHANGE_DISPLAY_MAX),
    after: unset ? null : configDisplayText(snapshot, input.keyPath, input.value, CONFIG_CHANGE_DISPLAY_MAX), expectDigest: snapshot.digest,
    valueDigest: unset ? null : sha256(encodeCommandProjection('config-change-value:1', { value: input.value ?? null })), ruleId });
}
