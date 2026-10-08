import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, evaluatePolicy, policySchema, resolvePolicyBindings, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry, DeckentError, sha256 } from '#platform/index.js';
import { backupCommandSchema, type BackupAuthority, type BackupAudit, type BackupAuthorization, type BackupStoragePort } from './contract.js';
/** The single governed application for human and AI backup callers. Policy and audit never see the passphrase. */
export class BackupApplication {
  constructor(private readonly storage: BackupStoragePort, private readonly authorize: BackupAuthorization,
    private readonly audit: BackupAudit, private readonly authority: BackupAuthority, private readonly now: () => number = Date.now) {}
  async execute(input: unknown, passphrase: string) {
    const parsed = backupCommandSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('BACKUP_INPUT_INVALID');
    const command = parsed.data, operationId = randomUUID(), decision = await this.authorize(command, this.authority);
    const event = (phase: 'intent' | 'succeeded' | 'refused' | 'failed' | 'uncertain', code: string | null, ledgerDigest: string | null = null): AuditEvent => ({
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
      principal: { issuer: this.authority.principal.issuer, subject: this.authority.principal.subject },
      policyRevision: decision.policyRevision, atMs: this.now(), subject: { kind: 'backup-operation' as const, operationId,
        action: command.action, installationId: this.authority.installationId, setPathDigest: sha256(command.set), targetPathDigest: command.action === 'restore' ? sha256(command.target) : null, ledgerDigest, phase, code,
        decision: { effect: decision.effect, ruleId: decision.ruleId } },
    });
    if (decision.effect !== 'allow') {
      await this.audit(event('refused', 'BACKUP_POLICY_DENIED'), this.authority.integrity);
      throw ErrorRegistry.createError(decision.effect === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'BACKUP_POLICY_DENIED');
    }
    await this.audit(event('intent', null), this.authority.integrity);
    let applied = false;
    try {
      if (!passphrase || Buffer.byteLength(passphrase) > 65536) throw ErrorRegistry.createError('BACKUP_PASSPHRASE_INVALID');
      const result = await this.storage.execute(command, passphrase);
      applied = true;
      await this.audit(event('succeeded', null, result.ledgerDigest), this.authority.integrity);
      return result;
    } catch (error) {
      const failure = error instanceof DeckentError && error.code.startsWith('BACKUP_') ? error : ErrorRegistry.createError('BACKUP_IO');
      await this.audit(event(applied || failure.code === 'BACKUP_RESTORE_INCOMPLETE' ? 'uncertain' : 'failed', failure.code), this.authority.integrity);
      throw failure;
    }
  }
}

/** A whole-installation backup needs an explicit all-scopes grant; scoped grants cannot export another company's state. */
export function policyBackupAuthorization(input: unknown): import('./contract.js').BackupAuthorization {
  const document = policySchema.parse(input);
  return async (request, authority) => {
    const decision = evaluatePolicy(document, { principal: authority.principal, scopeId: request.scopeId, action: request.action,
      resource: { kind: 'backup', id: authority.installationId } });
    const grant = document.grants.find(rule => rule.id === decision.ruleId);
    return { policyRevision: decision.revision, effect: decision.decision === 'allow' && grant?.scopes !== 'all' ? 'deny' : decision.decision,
      ruleId: decision.ruleId ?? null };
  };
}

export const resolveBackupPolicyDocuments = (policy: unknown, bindings: unknown) => resolvePolicyBindings(policy, bindings);
