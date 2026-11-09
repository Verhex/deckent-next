import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, evaluatePolicy, policyResources, samePrincipalRef, type AuditEvent, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, type DeckentError } from '#platform/index.js';
import { policyVerdictRefusal } from '#engine/core/policy/index.js';
import { isSecretName, isSecretValue, type SecretCustody, type SecretStore } from './port.js';
import { assertPublicSecretName, assertSecretStorageProtection } from './protection.js';

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

/** The one `secret` policy cell table (KG12 F3): `set|delete` of a name, `switch` of the installation store, `set` of the vault handover. */
export const evaluateSecretCell = (policy: unknown, principal: VerifiedPrincipal, scopeId: string, action: 'set' | 'delete' | 'switch', id: string) =>
  evaluatePolicy(policy, { principal, scopeId, action, resource: { kind: policyResources.secret.kind, id } });
/** A refused verdict as its typed error: require-approval is `POLICY_APPROVAL_UNSUPPORTED` without params, deny is `deny`; allow is null. */
export function secretVerdictRefusal(verdict: SecretChangeDecision['effect'], deny: string, params: Readonly<Record<string, string>>): DeckentError | null {
  const refusal = policyVerdictRefusal(verdict, { deny });
  return refusal === null ? null : ErrorRegistry.createError(refusal, refusal === 'POLICY_APPROVAL_UNSUPPORTED' ? {} : { params });
}
/** The verified caller's decision on one `secret` cell; a request naming another principal is `refused()`, never evaluated for someone else
 * (X4: the strict reference comparison over issuer and subject). */
export function decideSecretCell(policy: unknown, verified: VerifiedPrincipal, requested: SecretChangeRequest['principal'], scopeId: string,
  action: 'set' | 'delete' | 'switch', id: string, refused: () => DeckentError): SecretChangeDecision {
  if (!samePrincipalRef({ issuer: requested.issuer, subject: requested.subject }, { issuer: verified.issuer, subject: verified.subject })) throw refused();
  const decision = evaluateSecretCell(policy, verified, scopeId, action, id);
  return Object.freeze({ policyRevision: decision.revision, effect: decision.decision, ruleId: decision.ruleId ?? null });
}
/** Records one decision (KG12 F3 pair 1): no record of an allowed change, no change; a refusal that cannot be recorded is still a refusal
 * (the permission-mode rule) and is thrown typed. */
export async function recordSecretDecision(decision: SecretChangeDecision, event: AuditEvent, audit: SecretChangeAudit, deny: string,
  params: Readonly<Record<string, string>>): Promise<void> {
  if (decision.effect === 'allow') { await audit(event); return; }
  try { await audit(event); } catch { /* an unrecordable refusal is still a refusal */ }
  throw secretVerdictRefusal(decision.effect, deny, params)!;
}

/**
 * SECRET-WRITE (owner 2026-09-29 option A): the policy cell of a secret change is resource kind `secret`, action `set|delete`, id = the
 * secret's name, for the verified principal in the request's scope. The request must name that same principal (the service passes the
 * socket peer); anything else is refused, never evaluated for someone else.
 */
export function policySecretChangeAuthorization(policy: unknown, principal: VerifiedPrincipal): SecretChangeAuthorization {
  return async request => decideSecretCell(policy, principal, request.principal, request.scopeId, request.action, request.name,
    () => ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: request.action, name: request.name } }));
}

/**
 * Governed secret changes (SECRET-K1, SECRET-WRITE): input is checked first (name grammar, value bound, a writable backend), then authority
 * decides, then a `secret-change` audit event naming the action, the secret, the backend and the decision is recorded — for a refusal too —
 * and only an allowed change writes the store. No record of an allowed change, no change; a refusal that cannot be recorded is still a
 * refusal (the permission-mode rule). The value is passed straight to the store; it is never part of the request, the authorization input,
 * the audit event or an error. An audit that succeeded before a failed write records an intent that did not take effect (intent first).
 * The decision, the record and the write run inside the installation's custody section (Astra 2456 P1-1): the store this change opened must
 * still be the selected one there, else `SECRET_STORE_CHANGED` and nothing is decided, recorded or written (a store switch ran meanwhile).
 */
export class SecretStoreAdministration {
  constructor(private readonly store: SecretStore, private readonly authorize: SecretChangeAuthorization, private readonly audit: SecretChangeAudit,
    private readonly now: () => number, private readonly custody: SecretCustody) {}

  async set(request: SecretChangeRequest, value: string): Promise<void> {
    this.check(request);
    assertSecretStorageProtection(request.name, this.store.descriptor);
    if (!isSecretValue(value)) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
    await this.custody.exclusive(async () => {
      await this.selected();
      await this.record(request, 'set');
      await this.store.set(request.name, value);
    });
  }

  async delete(request: SecretChangeRequest): Promise<boolean> {
    this.check(request);
    return this.custody.exclusive(async () => {
      await this.selected();
      await this.record(request, 'delete');
      return this.store.delete(request.name);
    });
  }

  private async selected(): Promise<void> {
    if (await this.custody.selected() !== this.store.descriptor.id) {
      throw ErrorRegistry.createError('SECRET_STORE_CHANGED', { params: { backend: this.store.descriptor.id } });
    }
  }

  private check(request: SecretChangeRequest): void {
    assertPublicSecretName(request.name);
    if (!isSecretName(request.name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
    if (!this.store.descriptor.writable) throw ErrorRegistry.createError('SECRET_STORE_READ_ONLY', { params: { backend: this.store.descriptor.id } });
  }

  private async record(request: SecretChangeRequest, action: 'set' | 'delete'): Promise<void> {
    const decision = await this.authorize({ principal: request.principal, scopeId: request.scopeId, name: request.name, action });
    const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: request.scopeId,
      principal: { issuer: request.principal.issuer, subject: request.principal.subject }, policyRevision: decision.policyRevision, atMs: this.now(),
      subject: { kind: 'secret-change', action, name: request.name, backend: this.store.descriptor.id,
        decision: { effect: decision.effect, ruleId: decision.ruleId } } };
    await recordSecretDecision(decision, event, this.audit, 'SECRET_CHANGE_DENIED', { action, name: request.name });
  }
}
