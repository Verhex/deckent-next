import { createHash } from 'node:crypto';
import { commandEnvelopeSchema, encodeCommandProjection, evaluatePolicy, policyResources, type AuthorityDecisionSubject, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { SecretGrantStore } from './grant.js';
import { assertPublicSecretName } from './protection.js';
import { isSecretName } from './port.js';
import { SECRET_STORE_SWITCH_RESOURCE_ID } from './switch.js';
import { PROJECT_VAULT, type ProjectVaultAnchor, type SecretGrantFile } from './project.js';

export interface SecretGrantRequest {
  /** The verified caller (the CLI's own OS identity at a witnessed terminal), never an input field. */
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly name: string;
  readonly action: 'grant' | 'revoke';
  readonly source: 'card' | 'admin';
  /** A fresh id per request: one sealed decision per attempt. */
  readonly commandId: string;
}
export interface SecretGrantPorts {
  readonly anchor: ProjectVaultAnchor;
  /** The trusted policy snapshot (policy + bindings) of the scope. */
  readonly policy: unknown;
  /** Seals one `authority-decision` in the project's ledger and returns its record; throws when it cannot (no record, no grant). */
  record(subject: AuthorityDecisionSubject, atMs: number): { readonly event: { readonly eventId: string } };
  readonly store: SecretGrantStore;
  now(): number;
}
const hash = (tag: string, input: unknown) => createHash('sha256').update(encodeCommandProjection(tag, input)).digest('hex');
const ACTIONS = Object.freeze({ grant: 'secret-grant', revoke: 'secret-grant-revoke' });

/**
 * PRE-8 v2 (owner decision 4): lending main-vault key NAME to a project is decided on the EXISTING `secret`/`set` cell for NAME in the scope
 * ("who may write main key X may lend X"; policy template v13 stays) — the AI floor of that cell refuses every AI actor. The decision is
 * sealed as an `authority-decision` (action `secret-grant` | `secret-grant-revoke`, resource `secret`/NAME; no new audit kind) BEFORE the
 * grant record changes, for a refusal too; a grant carries that decision's event id. The caller has already passed the authority witness.
 */
export async function decideSecretGrant(request: SecretGrantRequest, ports: SecretGrantPorts): Promise<SecretGrantFile> {
  assertPublicSecretName(request.name);
  if (!isSecretName(request.name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
  const { principal, scopeId, name } = request;
  const verdict = evaluatePolicy(ports.policy, { principal, scopeId, action: 'set', resource: { kind: policyResources.secret.kind, id: name } });
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: request.commandId, scopeId,
    principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: hash('secret-grant-command:1', request.commandId) });
  const atMs = ports.now();
  const record = ports.record({ kind: 'authority-decision', schemaVersion: 1, envelope, action: ACTIONS[request.action], resource: { kind: policyResources.secret.kind, id: name },
    inputDigest: hash('secret-grant:1', { installationId: ports.anchor.installationId, projectId: ports.anchor.projectId, name, source: request.source, action: request.action }),
    basisDigest: null, policyDigest: hash('policy:1', ports.policy),
    verdict: { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason, ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }) } }, atMs);
  if (verdict.decision === 'require-approval') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
  if (verdict.decision !== 'allow') throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: 'set', name } });
  return ports.store.update(current => {
    const others = current.grants.filter(grant => grant.name !== name);
    return request.action === 'revoke' ? others : [...others, { name, scopeId, by: { issuer: principal.issuer, subject: principal.subject }, atMs,
      source: request.source, decisionEventId: record.event.eventId }];
  });
}
/** `secret list --all` lists every project vault of the main vault (names only): the main vault's administration, the existing `secret`/`switch` cell. */
export function authorizeSecretInventoryAll(policy: unknown, principal: VerifiedPrincipal, scopeId: string): void {
  const verdict = evaluatePolicy(policy, { principal, scopeId, action: 'switch', resource: { kind: policyResources.secret.kind, id: SECRET_STORE_SWITCH_RESOURCE_ID } });
  if (verdict.decision !== 'allow') throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: 'switch', name: SECRET_STORE_SWITCH_RESOURCE_ID } });
}

export interface ProjectVaultHandoverPorts {
  /** The vault's recorded owner and the anchor that takes it over. */
  readonly from: ProjectVaultAnchor; readonly to: ProjectVaultAnchor;
  readonly policy: unknown;
  record(subject: AuthorityDecisionSubject, atMs: number): { readonly event: { readonly eventId: string } };
  now(): number;
}
/**
 * Astra REVISE 2704 A: moving a project vault to a moved project is decided on the EXISTING `secret`/`set` cell for the vault resource
 * (`project-vault`, registry data) in the scope and sealed as an `authority-decision` (`secret-vault-handover`) BEFORE the binding changes — a refusal is
 * sealed too, and an unrecordable decision changes nothing. The caller has passed the terminal witness and the adapter's move check (original gone).
 */
export function decideProjectVaultHandover(request: Omit<SecretGrantRequest, 'name' | 'action' | 'source'>, ports: ProjectVaultHandoverPorts): void {
  const { principal, scopeId } = request, resource = { kind: policyResources.secret.kind, id: PROJECT_VAULT.handoverResourceId };
  const verdict = evaluatePolicy(ports.policy, { principal, scopeId, action: 'set', resource });
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: request.commandId, scopeId,
    principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: hash('secret-vault-handover-command:1', request.commandId) });
  ports.record({ kind: 'authority-decision', schemaVersion: 1, envelope, action: 'secret-vault-handover', resource,
    inputDigest: hash('secret-vault-handover:1', { installationId: ports.to.installationId, projectId: ports.to.projectId, from: ports.from.binding, to: ports.to.binding }),
    basisDigest: null, policyDigest: hash('policy:1', ports.policy),
    verdict: { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason, ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }) } }, ports.now());
  if (verdict.decision === 'require-approval') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
  if (verdict.decision !== 'allow') throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: 'set', name: PROJECT_VAULT.handoverResourceId } });
}
