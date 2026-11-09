import { createHash } from 'node:crypto';
import { commandEnvelopeSchema, encodeCommandProjection, policyResources, type AuthorityDecisionSubject, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { evaluateSecretCell, secretVerdictRefusal } from './administration.js';
import type { SecretGrantStore } from './grant.js';
import { assertPublicSecretName } from './protection.js';
import { isSecretName } from './port.js';
import { SECRET_STORE_SWITCH_RESOURCE_ID } from './switch.js';
import { PROJECT_VAULT, type ProjectVaultAnchor, type SecretGrantFile } from './project.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface SecretGrantRequest {
  /** The verified caller (the CLI's own OS identity at a witnessed terminal), never an input field. */
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly name: string;
  readonly action: 'grant' | 'revoke';
  readonly source: 'card' | 'admin';
  /** A fresh id per request: one sealed decision per attempt. */
  readonly commandId: string;
}
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface SecretGrantPorts {
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
 * KG12 F3 pair 2: one `authority-decision` on the `secret`/`set` cell of `id`, sealed before anything changes — a refusal too; when it cannot be
 * recorded it throws and nothing changes. `tag` versions the command and input digests (`<tag>-command:1`, `<tag>:1`).
 */
function sealSecretDecision(request: Pick<SecretGrantRequest, 'principal' | 'scopeId' | 'commandId'>, ports: Pick<SecretGrantPorts, 'policy' | 'record' | 'now'>,
  action: string, id: string, tag: string, input: unknown): { readonly atMs: number; readonly eventId: string } {
  const { principal, scopeId } = request;
  const verdict = evaluateSecretCell(ports.policy, principal, scopeId, 'set', id);
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: request.commandId, scopeId,
    principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: hash(`${tag}-command:1`, request.commandId) });
  const atMs = ports.now();
  const record = ports.record({ kind: 'authority-decision', schemaVersion: 1, envelope, action, resource: { kind: policyResources.secret.kind, id },
    inputDigest: hash(`${tag}:1`, input), basisDigest: null, policyDigest: hash('policy:1', ports.policy),
    verdict: { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason, ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }) } }, atMs);
  const refusal = secretVerdictRefusal(verdict.decision, 'SECRET_CHANGE_DENIED', { action: 'set', name: id });
  if (refusal) throw refusal;
  return { atMs, eventId: record.event.eventId };
}

/**
 * PRE-8 v2 (owner decision 4): lending main-vault key NAME to a project is decided on the EXISTING `secret`/`set` cell for NAME in the scope
 * ("who may write main key X may lend X"; policy template v13 stays) — the AI floor of that cell refuses every AI actor. The decision is
 * sealed as an `authority-decision` (action `secret-grant` | `secret-grant-revoke`, resource `secret`/NAME; no new audit kind) BEFORE the
 * grant record changes, for a refusal too; a grant carries that decision's event id. The caller has already passed the authority witness.
 * A grant lends NAME to the whole project (owner B1-6): `--scope` names the scope the decision is made and recorded in, it does not narrow the
 * grant; use finds a grant by name and never compares its `scopeId`.
 */
export async function decideSecretGrant(request: SecretGrantRequest, ports: SecretGrantPorts): Promise<SecretGrantFile> {
  assertPublicSecretName(request.name);
  if (!isSecretName(request.name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
  const { principal, scopeId, name } = request;
  const { atMs, eventId } = sealSecretDecision(request, ports, ACTIONS[request.action], name, 'secret-grant',
    { installationId: ports.anchor.installationId, projectId: ports.anchor.projectId, name, source: request.source, action: request.action });
  return ports.store.update(current => {
    const others = current.grants.filter(grant => grant.name !== name);
    return request.action === 'revoke' ? others : [...others, { name, scopeId, by: { issuer: principal.issuer, subject: principal.subject }, atMs,
      source: request.source, decisionEventId: eventId }];
  });
}
/** `secret list --all` lists every project vault of the main vault (names only): the main vault's administration, the existing `secret`/`switch` cell. */
export function authorizeSecretInventoryAll(policy: unknown, principal: VerifiedPrincipal, scopeId: string): void {
  if (evaluateSecretCell(policy, principal, scopeId, 'switch', SECRET_STORE_SWITCH_RESOURCE_ID).decision !== 'allow') throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: 'switch', name: SECRET_STORE_SWITCH_RESOURCE_ID } });
}

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface ProjectVaultHandoverPorts {
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
  sealSecretDecision(request, ports, 'secret-vault-handover', PROJECT_VAULT.handoverResourceId, 'secret-vault-handover',
    { installationId: ports.to.installationId, projectId: ports.to.projectId, from: ports.from.binding, to: ports.to.binding });
}
