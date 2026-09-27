import { createHash, randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, bindingsFileSchema, evaluatePolicy, parsePermissionModeCommand, parsePermissionModeQuery, permissionModeView, policyResources,
  policySchema, resolvePolicyBindings, withPrincipalPermissionMode, type AuditEvent, type PermissionModeChange, type PermissionModeView,
  type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError } from './authorize.js';

export class PermissionModeError extends Error {
  constructor(readonly code: 'PERMISSION_MODE_CONFLICT' | 'PERMISSION_MODE_UNSUPPORTED' | 'PERMISSION_MODE_INVALID') { super(code); this.name = 'PermissionModeError'; }
}
/** One guarded read of the authority files: the policy document and — for a v2 policy — the raw bindings document (null for v1). */
export interface PermissionModeSnapshot { readonly policy: unknown; readonly bindings: unknown }
/**
 * The bindings file as a conditional, atomic write target (T-L4 slice 4c). `update` reads policy + bindings under the store's file
 * guards and, serialized with every other update of the same file, asks `work` what to write. A document to write replaces the file
 * atomically and only if the file is still exactly the one read; a replacement in between is `PERMISSION_MODE_CONFLICT` and nothing
 * is written. `work` runs synchronously inside that window (it may record audit evidence; a throw writes nothing).
 */
export interface PermissionModeBindingsStore {
  update<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: unknown; readonly result: T }): Promise<T>;
}
/** Persists one sealed audit event before the change it records; throws (typically `AuditError`) when it cannot. */
export type PermissionModeAudit = (event: AuditEvent) => void;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The caller's own mode in the queried scope over the request's trusted policy snapshot (the scope was admitted by the caller). */
export function inspectPermissionMode(policy: unknown, principal: VerifiedPrincipal, input: unknown): PermissionModeView {
  let query;
  try { query = parsePermissionModeQuery(input); } catch { throw new PermissionModeError('PERMISSION_MODE_INVALID'); }
  return permissionModeView(policySchema.parse(policy), { issuer: principal.issuer, subject: principal.subject }, query.scopeId);
}
/**
 * A person sets their own terminal permission mode in one scope (T-L4 slice 4c, owner q7). The principal is the verified caller —
 * never an input — and only that exact issuer + subject's `modes` entries change. The change is conditional on the effective revision
 * (`policy+bindings`) the caller read, needs a company `permission-mode`/`set` grant for the target mode (require-approval has no broker
 * here: `POLICY_APPROVAL_UNSUPPORTED`), and every decision is audited; an allowed change is recorded before the file is replaced
 * (no record, no change). The mode itself grants nothing: lowering stays the decision function's, on company-eligible rules only.
 */
export class PermissionModeApplication {
  constructor(private readonly store: PermissionModeBindingsStore, private readonly audit: PermissionModeAudit, private readonly now: () => number) {}

  async set(principal: VerifiedPrincipal, input: unknown): Promise<PermissionModeChange> {
    let command;
    try { command = parsePermissionModeCommand(input); } catch { throw new PermissionModeError('PERMISSION_MODE_INVALID'); }
    const actor = { issuer: principal.issuer, subject: principal.subject };
    return this.store.update<PermissionModeChange>(snapshot => {
      const policy = snapshot.bindings === null ? policySchema.parse(snapshot.policy) : resolvePolicyBindings(snapshot.policy, snapshot.bindings);
      if (policy.revision !== command.expectedRevision) throw new PermissionModeError('PERMISSION_MODE_CONFLICT');
      if (policy.schemaVersion === 1) throw new PermissionModeError('PERMISSION_MODE_UNSUPPORTED');
      const bindings = bindingsFileSchema.parse(snapshot.bindings);
      const before = permissionModeView(policy, actor, command.scopeId);
      const decision = evaluatePolicy(policy, { principal, scopeId: command.scopeId, action: policyResources.permissionMode.actions[0],
        resource: { kind: policyResources.permissionMode.kind, id: command.mode } });
      const record = (after: string | null) => this.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: actor, policyRevision: policy.revision, atMs: this.now(), subject: { kind: 'permission-mode-change', requested: command.mode, previous: before.mode,
          decision: { effect: decision.decision, ruleId: decision.ruleId ?? null }, bindingsRevision: { before: bindings.revision, after } } });
      if (decision.decision !== 'allow') {
        // A refusal is recorded when possible; an unrecordable refusal is still a refusal.
        try { record(null); } catch { /* refused either way */ }
        throw new PolicyAuthorizationError(decision.decision === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED');
      }
      const modes = withPrincipalPermissionMode(bindings, actor, command.scopeId, command.mode,
        `m-${sha256(`permission-mode-entry:1\0${actor.issuer}\0${actor.subject}\0${command.mode}`).slice(0, 16)}`);
      if (modes === null) {
        record(null);
        return { write: null, result: Object.freeze({ ...before, previous: before.mode, changed: false }) };
      }
      // The new revision chains the previous one, so returning to earlier content never reuses a revision (no ABA for a stale writer).
      const body = { bindings: bindings.bindings, modes };
      const next = bindingsFileSchema.parse({ schemaVersion: 2, revision: `m-${sha256(`permission-mode-bindings:1\0${bindings.revision}\0${JSON.stringify(body)}`).slice(0, 40)}`, ...body });
      const after = permissionModeView(resolvePolicyBindings(snapshot.policy, next), actor, command.scopeId);
      // No record, no change: the audit event is durable before the file is replaced.
      record(next.revision);
      return { write: next, result: Object.freeze({ ...after, previous: before.mode, changed: true }) };
    });
  }
}
