import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { isSecretName, isSecretValue, type SecretStore } from './port.js';

/** Who asks to change which secret in which scope. The principal is the verified caller, never an input of the request body. */
export interface SecretChangeRequest {
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly scopeId: string;
  readonly name: string;
}
/**
 * The authority decision for one change (the governance checkpoint of SECRET-K1: which policy cell decides it is chosen by composition).
 * Resolves with the policy revision it decided on; a refusal throws its own typed error.
 */
export type SecretChangeAuthorization = (request: SecretChangeRequest & { readonly action: 'set' | 'delete' }) => Promise<{ readonly policyRevision: string }>;
/** Persists one sealed audit event before the change; throws when it cannot (no record, no change). */
export type SecretChangeAudit = (event: AuditEvent) => void | Promise<void>;

/**
 * Governed secret changes (SECRET-K1): input is checked first (name grammar, value bound, a writable backend), then authority is asked,
 * then a `secret-change` audit event naming the action, the secret and the backend is recorded, and only then is the store written.
 * The value is passed straight to the store; it is never part of the request, the authorization input, the audit event or an error.
 * An audit that succeeded before a failed write records an intent that did not take effect (the permission-mode precedent: intent first).
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
    await this.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: request.scopeId,
      principal: { issuer: request.principal.issuer, subject: request.principal.subject }, policyRevision: decision.policyRevision, atMs: this.now(),
      subject: { kind: 'secret-change', action, name: request.name, backend: this.store.descriptor.id } });
  }
}
