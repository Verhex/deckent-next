import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, evaluatePolicy, policyResources, type AuditEvent, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { isSecretName, isSecretValue, type SecretStore } from './port.js';

/** Who asks to change which secret in which scope. The principal is the verified caller, never an input of the request body. */
export interface SecretChangeRequest {
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly scopeId: string;
  readonly name: string;
}
/** One decision on the `secret`/`set|delete` policy cell, with the policy revision it was made on (`ruleId` null: no rule matched). */
export interface SecretChangeDecision {
  readonly policyRevision: string;
  readonly effect: 'allow' | 'deny' | 'require-approval';
  readonly ruleId: string | null;
}
/**
 * The authority decision for one change. A decision (allow or refusal) is returned and recorded; a failure to decide at all (an unreadable
 * policy) throws its own typed error and nothing is recorded or written.
 */
export type SecretChangeAuthorization = (request: SecretChangeRequest & { readonly action: 'set' | 'delete' }) => Promise<SecretChangeDecision>;
/** Persists one sealed audit event before the change; throws when it cannot (no record, no change). */
export type SecretChangeAudit = (event: AuditEvent) => void | Promise<void>;

/**
 * SECRET-WRITE (owner 2026-09-29 option A): the policy cell of a secret change is resource kind `secret`, action `set|delete`, id = the
 * secret's name, for the verified principal in the request's scope. The request must name that same principal (the service passes the
 * socket peer); anything else is refused, never evaluated for someone else.
 */
export function policySecretChangeAuthorization(policy: unknown, principal: VerifiedPrincipal): SecretChangeAuthorization {
  return async request => {
    if (request.principal.issuer !== principal.issuer || request.principal.subject !== principal.subject) {
      throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: request.action, name: request.name } });
    }
    const decision = evaluatePolicy(policy, { principal, scopeId: request.scopeId, action: request.action,
      resource: { kind: policyResources.secret.kind, id: request.name } });
    return Object.freeze({ policyRevision: decision.revision, effect: decision.decision, ruleId: decision.ruleId ?? null });
  };
}

/**
 * Governed secret changes (SECRET-K1, SECRET-WRITE): input is checked first (name grammar, value bound, a writable backend), then authority
 * decides, then a `secret-change` audit event naming the action, the secret, the backend and the decision is recorded — for a refusal too —
 * and only an allowed change writes the store. No record of an allowed change, no change; a refusal that cannot be recorded is still a
 * refusal (the permission-mode rule). The value is passed straight to the store; it is never part of the request, the authorization input,
 * the audit event or an error. An audit that succeeded before a failed write records an intent that did not take effect (intent first).
 */
export class SecretStoreAdministration {
  constructor(private readonly store: SecretStore, private readonly authorize: SecretChangeAuthorization, private readonly audit: SecretChangeAudit,
    private readonly now: () => number) {}

  async set(request: SecretChangeRequest, value: string): Promise<void> {
    this.check(request);
    if (!isSecretValue(value)) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
    await this.record(request, 'set');
    await this.store.set(request.name, value);
  }

  async delete(request: SecretChangeRequest): Promise<boolean> {
    this.check(request);
    await this.record(request, 'delete');
    return this.store.delete(request.name);
  }

  private check(request: SecretChangeRequest): void {
    if (!isSecretName(request.name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
    if (!this.store.descriptor.writable) throw ErrorRegistry.createError('SECRET_STORE_READ_ONLY', { params: { backend: this.store.descriptor.id } });
  }

  private async record(request: SecretChangeRequest, action: 'set' | 'delete'): Promise<void> {
    const decision = await this.authorize({ principal: request.principal, scopeId: request.scopeId, name: request.name, action });
    const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: request.scopeId,
      principal: { issuer: request.principal.issuer, subject: request.principal.subject }, policyRevision: decision.policyRevision, atMs: this.now(),
      subject: { kind: 'secret-change', action, name: request.name, backend: this.store.descriptor.id,
        decision: { effect: decision.effect, ruleId: decision.ruleId } } };
    if (decision.effect === 'allow') { await this.audit(event); return; }
    try { await this.audit(event); } catch { /* an unrecordable refusal is still a refusal */ }
    if (decision.effect === 'require-approval') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
    throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action, name: request.name } });
  }
}
