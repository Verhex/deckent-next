import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, evaluatePolicy, policyResources, type AuditEvent, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { SecretStore } from './port.js';
import type { SecretChangeAudit, SecretChangeDecision } from './administration.js';

/** The policy resource id of a store switch: one installation store, so one fixed id; a rule for every secret name (`all`) covers it. */
export const SECRET_STORE_SWITCH_RESOURCE_ID = 'secret-store';
/** The environment backend's id (the selection an absent `secrets` section means). */
const ENVIRONMENT_STORE = 'core.secret-store.env@1';
/** Core stores by custody strength: a move to a lower rank is a downgrade; a store outside this list (Enterprise/custom) always asks. */
const CORE_STORE_RANK: Readonly<Record<string, number>> = Object.freeze({ 'core.secret-store.env@1': 1, 'core.secret-store.file@1': 2,
  'core.secret-store.encrypted-file@1': 3 });

/** The installation's store selection (`secrets.store` of the installation config): `store` null = no selection (the environment backend). */
export interface SecretStoreSelectionPort {
  read(): Promise<Readonly<{ store: string | null; digest: string | null }>>;
  /** Publishes the selection when the document is still the one read (`expectDigest`); otherwise a typed concurrent-change refusal. */
  publish(store: string, expectDigest: string | null): Promise<void>;
}
export interface SecretStoreSwitchPorts {
  readonly has: (id: string) => boolean;
  readonly open: (id: string) => SecretStore;
  readonly selection: SecretStoreSelectionPort;
  readonly authorize: (request: SecretStoreSwitchRequest) => Promise<SecretChangeDecision>;
  readonly audit: SecretChangeAudit;
  readonly now: () => number;
}
export interface SecretStoreSwitchRequest {
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly scopeId: string;
  readonly to: string;
  /** A move toward a weaker store (encrypted → file/env, or to/from a store Core cannot rank) runs only with this explicit confirmation. */
  readonly confirmDowngrade: boolean;
}
/** `switched`: entries moved and the selection published; `current`: the target was already selected (leftover identical copies cleaned). */
export interface SecretStoreSwitchResult {
  readonly schemaVersion: 1; readonly scopeId: string; readonly status: 'switched' | 'current';
  readonly from: string; readonly to: string; readonly entries: number; readonly downgrade: boolean;
  /** Whether no copy of a moved secret is left in another store (false: a later run of the same switch finishes the cleanup). */
  readonly cleaned: boolean;
}

/** `secret`/`switch` for the verified principal in the request's scope (the caller passes the socket peer; anyone else is refused). */
export function policySecretStoreSwitchAuthorization(policy: unknown, principal: VerifiedPrincipal) {
  return async (request: SecretStoreSwitchRequest): Promise<SecretChangeDecision> => {
    if (request.principal.issuer !== principal.issuer || request.principal.subject !== principal.subject) {
      throw ErrorRegistry.createError('SECRET_STORE_SWITCH_DENIED', { params: { to: request.to } });
    }
    const decision = evaluatePolicy(policy, { principal, scopeId: request.scopeId, action: 'switch',
      resource: { kind: policyResources.secret.kind, id: SECRET_STORE_SWITCH_RESOURCE_ID } });
    return Object.freeze({ policyRevision: decision.revision, effect: decision.decision, ruleId: decision.ruleId ?? null });
  };
}

/** Whether a move from one store to another lowers custody (both ranked by Core and the target ranks at least as high: not a downgrade). */
export function isSecretStoreDowngrade(from: string, to: string): boolean {
  const source = CORE_STORE_RANK[from], target = CORE_STORE_RANK[to];
  return source === undefined || target === undefined || target < source;
}

/**
 * SECRET-STORE-SWITCH (owner 2026-10-08, option B, Jev a0284b73): one governed operation moves every secret into another registered store
 * and selects it. Order (crash-safe; the owner's intent, with the selection published before the old copy goes): input checks (known
 * target, downgrade confirmed, a writable target when something moves) → the `secret`/`switch` decision → a `secret-store-switch` audit event
 * (a refusal is recorded too; no record of an allowed switch, no switch) → copy every name → read every copy back and compare → publish the
 * selection on the document that was read → delete each moved name from the old store. A crash before publication leaves the old selection
 * and its secrets whole; a crash after it leaves secrets reachable with an old copy behind (`cleaned` false), which a run of the same switch
 * removes: when the target is already selected, a copy elsewhere that is identical to the selected one is deleted. A secret set on the old
 * store between the copy and the publication is not moved (open limit: secret changes are not serialized against a switch).
 */
export class SecretStoreSwitch {
  constructor(private readonly ports: SecretStoreSwitchPorts) {}

  async switch(request: SecretStoreSwitchRequest): Promise<SecretStoreSwitchResult> {
    if (!this.ports.has(request.to)) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: request.to } });
    const selection = await this.ports.selection.read(), from = selection.store ?? ENVIRONMENT_STORE;
    if (from === request.to) return this.finish(request, from);
    const source = this.ports.open(from), target = this.ports.open(request.to);
    // The environment backend (and any store that cannot list) has nothing Deckent can move: only the selection changes.
    const names = source.descriptor.enumerable ? [...await source.listNames()] : [];
    const downgrade = isSecretStoreDowngrade(from, request.to);
    if (downgrade && !request.confirmDowngrade) throw ErrorRegistry.createError('SECRET_STORE_DOWNGRADE_UNCONFIRMED', { params: { from, to: request.to } });
    if (names.length && !target.descriptor.writable) throw ErrorRegistry.createError('SECRET_STORE_READ_ONLY', { params: { backend: request.to } });
    await this.record(request, from, names.length, downgrade);
    const values = new Map<string, string>();
    for (const name of names) {
      const value = await source.get(name);
      if (value !== undefined) values.set(name, value);
    }
    for (const [name, value] of values) await target.set(name, value);
    for (const [name, value] of values) {
      if (await target.get(name) !== value) throw ErrorRegistry.createError('SECRET_STORE_SWITCH_UNVERIFIED', { params: { to: request.to } });
    }
    await this.ports.selection.publish(request.to, selection.digest);
    let cleaned = true;
    for (const name of values.keys()) {
      try { await source.delete(name); } catch { cleaned = false; }
    }
    values.clear();
    return Object.freeze({ schemaVersion: 1, scopeId: request.scopeId, status: 'switched', from, to: request.to, entries: names.length, downgrade, cleaned });
  }

  /** The target is already selected: finish an interrupted switch by deleting copies elsewhere that are identical to the selected ones. The
   * deletions are a switch decision too: with something to remove, the `secret`/`switch` cell decides and `secret-store-switch` records it
   * (`entries` = copies removed) before anything is deleted; with nothing to remove, nothing changes and nothing is recorded. */
  private async finish(request: SecretStoreSwitchRequest, selected: string): Promise<SecretStoreSwitchResult> {
    const target = this.ports.open(selected), result = (cleaned: boolean): SecretStoreSwitchResult => Object.freeze({ schemaVersion: 1,
      scopeId: request.scopeId, status: 'current', from: selected, to: selected, entries: 0, downgrade: false, cleaned });
    // A selection Deckent cannot list (the environment) proves no copy elsewhere redundant: nothing is cleaned against it.
    if (!target.descriptor.enumerable) return result(true);
    let cleaned = true;
    const candidates: { readonly store: SecretStore; readonly name: string }[] = [];
    for (const other of Object.keys(CORE_STORE_RANK)) {
      if (other === selected || !this.ports.has(other)) continue;
      const store = this.ports.open(other);
      if (!store.descriptor.enumerable || !store.descriptor.writable) continue;
      let names: readonly string[];
      try { names = await store.listNames(); } catch { continue; }
      for (const name of names) {
        try {
          const kept = await target.get(name);
          if (kept !== undefined && kept === await store.get(name)) candidates.push({ store, name }); else cleaned = false;
        } catch { cleaned = false; }
      }
    }
    if (!candidates.length) return result(cleaned);
    await this.record(request, selected, candidates.length, false);
    for (const { store, name } of candidates) {
      try { await store.delete(name); } catch { cleaned = false; }
    }
    return Object.freeze({ ...result(cleaned), entries: candidates.length });
  }

  private async record(request: SecretStoreSwitchRequest, from: string, entries: number, downgrade: boolean): Promise<void> {
    const decision = await this.ports.authorize(request);
    const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: request.scopeId,
      principal: { issuer: request.principal.issuer, subject: request.principal.subject }, policyRevision: decision.policyRevision, atMs: this.ports.now(),
      subject: { kind: 'secret-store-switch', from, to: request.to, entries, downgrade, decision: { effect: decision.effect, ruleId: decision.ruleId } } };
    if (decision.effect === 'allow') { await this.ports.audit(event); return; }
    try { await this.ports.audit(event); } catch { /* an unrecordable refusal is still a refusal */ }
    if (decision.effect === 'require-approval') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
    throw ErrorRegistry.createError('SECRET_STORE_SWITCH_DENIED', { params: { to: request.to } });
  }
}
