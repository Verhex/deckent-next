import { createHash, randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, bindingsFileSchema, evaluatePolicy, parsePermissionModeCommand, parsePermissionModeQuery, permissionModeView, policyResources,
  policySchema, resolvePolicyBindings, withPrincipalPermissionMode, type AuditEvent, type PermissionModeChange, type PermissionModeView,
  type PolicyDecision, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError } from './authorize.js';
import { AuthorityChangeError, chainAuthorityRevision, type AuthorityDocumentStore } from './authority.js';

export class PermissionModeError extends Error {
  /** `mode` names the refused target for `PERMISSION_MODE_DENIED` (the message says which grant is missing). */
  constructor(readonly code: 'PERMISSION_MODE_CONFLICT' | 'PERMISSION_MODE_UNSUPPORTED' | 'PERMISSION_MODE_INVALID' | 'PERMISSION_MODE_DENIED', readonly mode?: string) {
    super(code); this.name = 'PermissionModeError';
  }
}
/** One guarded read of the authority files: the policy document and — for a v2 policy — the raw bindings document (null for v1). */
export interface PermissionModeSnapshot { readonly policy: unknown; readonly bindings: unknown }
/**
 * The bindings file as a conditional, atomic write target (T-L4 slice 4c). `update` reads policy + bindings under the store's file
 * guards and, serialized with every other update of the same file, asks `work` what to write. A document to write replaces the file
 * atomically and only if both authority files — the bindings and the policy that authorized the change — are still exactly the ones
 * read; a replacement of either in between is `PERMISSION_MODE_CONFLICT` and nothing is written. `work` runs synchronously inside that window (it may record audit evidence; a throw writes nothing).
 */
export interface PermissionModeBindingsStore {
  update<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: unknown; readonly result: T }): Promise<T>;
}
/** Persists one sealed audit event before the change it records; throws (typically `AuditError`) when it cannot. */
export type PermissionModeAudit = (event: AuditEvent) => void;

/** The caller's own mode in the queried scope over the request's trusted policy snapshot (the scope was admitted by the caller). */
export function inspectPermissionMode(policy: unknown, principal: VerifiedPrincipal, input: unknown): PermissionModeView {
  let query;
  try { query = parsePermissionModeQuery(input); } catch { throw new PermissionModeError('PERMISSION_MODE_INVALID'); }
  return permissionModeView(policySchema.parse(policy), principal, query.scopeId);
}
/**
 * A person sets their own terminal permission mode in one scope (T-L4 slice 4c, owner q7; MODES-3). The principal is the verified caller —
 * never an input — and only that exact issuer + subject's `modes` entries change. The change is conditional on the effective revision
 * (`policy+bindings`) the caller read, needs a company `permission-mode`/`set` grant for `full-auto` or `full-access` (the latter stored only
 * as the person's start mode; require-approval has no broker here: `POLICY_APPROVAL_UNSUPPORTED`); `standart` — the default — and the
 * "ask for edits too" preference need none (owner R4), and every decision is audited; an allowed change is recorded before the file is
 * replaced (no record, no change). Every write is bindings v3 (a v1/v2 file is upgraded on its first write; the authority writer archives
 * the document before and after). The mode itself grants nothing: lowering stays the decision function's, on company-eligible rules only.
 */
export class PermissionModeApplication {
  /** The store is the installation's one authority writer (POLICY-ADMIN P3: the same `updateAuthority` path `policy.administer` uses). */
  constructor(private readonly store: AuthorityDocumentStore, private readonly audit: PermissionModeAudit, private readonly now: () => number) {}

  async set(principal: VerifiedPrincipal, input: unknown): Promise<PermissionModeChange> {
    let command;
    try { command = parsePermissionModeCommand(input); } catch { throw new PermissionModeError('PERMISSION_MODE_INVALID'); }
    try { return await this.write(principal, command); }
    catch (error) { throw error instanceof AuthorityChangeError && error.code === 'POLICY_CONFLICT' ? new PermissionModeError('PERMISSION_MODE_CONFLICT') : error; }
  }

  private write(principal: VerifiedPrincipal, command: ReturnType<typeof parsePermissionModeCommand>): Promise<PermissionModeChange> {
    const actor = { issuer: principal.issuer, subject: principal.subject };
    return this.store.updateAuthority<PermissionModeChange>(snapshot => {
      const policy = snapshot.bindings === null ? policySchema.parse(snapshot.policy) : resolvePolicyBindings(snapshot.policy, snapshot.bindings);
      if (policy.revision !== command.expectedRevision) throw new PermissionModeError('PERMISSION_MODE_CONFLICT');
      if (policy.schemaVersion === 1) throw new PermissionModeError('PERMISSION_MODE_UNSUPPORTED');
      const bindings = bindingsFileSchema.parse(snapshot.bindings);
      const before = permissionModeView(policy, principal, command.scopeId);
      const askEdits = command.askEdits ?? before.askEdits;
      const evaluated = evaluatePolicy(policy, { principal, scopeId: command.scopeId, action: policyResources.permissionMode.actions[0],
        resource: { kind: policyResources.permissionMode.kind, id: command.mode } });
      // Owner R4 (2026-09-27), MODES-3: `standart` — the most restrictive mode, the absence of an entry — and the edits preference need no set
      // grant, and a company deny cannot keep a person in a relaxed mode. The scope boundary still holds. Audited as `allow` with no rule id: a
      // grant always names its rule, so a null rule records that no grant was required.
      const decision: Pick<PolicyDecision, 'decision' | 'ruleId'> = command.mode === 'standart' && evaluated.reason !== 'SCOPE' ? { decision: 'allow' } : evaluated;
      const record = (after: string | null) => this.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: actor, policyRevision: policy.revision, atMs: this.now(), subject: { kind: 'permission-mode-change', requested: command.mode, previous: before.mode,
          decision: { effect: decision.decision, ruleId: decision.ruleId ?? null }, bindingsRevision: { before: bindings.revision, after },
          askEdits: { requested: askEdits, previous: before.askEdits } } });
      if (decision.decision !== 'allow') {
        // A refusal is recorded when possible; an unrecordable refusal is still a refusal.
        try { record(null); } catch { /* refused either way */ }
        // A refused mode is its own typed answer (which mode, which grant is missing), not the generic denial.
        throw decision.decision === 'require-approval' ? new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED') : new PermissionModeError('PERMISSION_MODE_DENIED', command.mode);
      }
      const modes = withPrincipalPermissionMode(bindings, actor, command.scopeId, command.mode, askEdits,
        `m-${createHash('sha256').update(`permission-mode-entry:1\0${actor.issuer}\0${actor.subject}\0${command.mode}`).digest('hex').slice(0, 16)}`);
      if (modes === null) {
        record(null);
        return { write: null, result: Object.freeze({ ...before, previous: before.mode, changed: false }) };
      }
      // The new revision chains the previous one, so returning to earlier content never reuses a revision (no ABA for a stale writer).
      const body = { bindings: bindings.bindings, modes };
      const next = bindingsFileSchema.parse({ schemaVersion: 3, revision: chainAuthorityRevision('permission-mode-bindings:1', 'm', bindings.revision, body), ...body });
      const after = permissionModeView(resolvePolicyBindings(snapshot.policy, next), principal, command.scopeId);
      // No record, no change: the audit event is durable before the file is replaced.
      record(next.revision);
      return { write: { policy: null, bindings: next, order: 'policy-first' as const }, result: Object.freeze({ ...after, previous: before.mode, changed: true }) };
    });
  }
}
