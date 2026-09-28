import { createHash, randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, type AuditEvent } from '#domain/index.js';
import type { PermissionModeSnapshot } from './permission-mode-admin.js';

/**
 * One authority write (POLICY-ADMIN P2): the next policy.json and/or bindings.json document (null = that file does not change) and the
 * order the two renames happen in (I8; the planner verified both intermediate states). A document carries its chained revision.
 */
export interface AuthorityWrite { readonly policy: unknown | null; readonly bindings: unknown | null; readonly order: 'policy-first' | 'bindings-first' }
export type AuthorityLookup = { readonly status: 'applied'; readonly version: string } | { readonly status: 'absent' } | null;
/**
 * The installation's authority documents as one conditional, atomic write target — the single writer of policy.json and bindings.json
 * for every product path (`policy.administer`, `/mode`). `updateAuthority` reads both files under the source guards and, serialized with
 * every other authority write in this process, asks `work` (synchronously, inside the read-to-rename window: it may record audit
 * evidence; a throw writes nothing) what to write. Each file is replaced only if both files are still exactly the ones read
 * (`POLICY_CONFLICT` otherwise, nothing replaced by this call before the check). Every write is archived with the documents before and
 * after; a `key` (the C11 wire key) names the archive record so `lookupAuthority` can tell applied, absent or unknown after a crash.
 */
export interface AuthorityDocumentStore {
  updateAuthority<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: AuthorityWrite | null; readonly result: T }, key?: string): Promise<T>;
  lookupAuthority(key: string): Promise<AuthorityLookup>;
  /** Stable identity of the documents (the C11 target binding pins it). */
  identity(): string;
}
export class AuthorityChangeError extends Error {
  constructor(readonly code: 'POLICY_CONFLICT' | 'POLICY_DELEGATION_EXCEEDS', readonly detail: string | null = null) { super(code); this.name = 'AuthorityChangeError'; }
}
/**
 * The next revision of an authority document: `prefix-` + sha256(tag, previous revision, new body)[:40]. Chained, so returning to earlier
 * content never reuses a revision (no ABA for a stale conditional writer). `/mode` keeps its own tag and `m` prefix byte for byte.
 */
export function chainAuthorityRevision(tag: string, prefix: 'a' | 'm', previous: string, body: unknown): string {
  return `${prefix}-${createHash('sha256').update(`${tag}\0${previous}\0${JSON.stringify(body)}`).digest('hex').slice(0, 40)}`;
}

type Person = { readonly issuer: string; readonly subject: string };
/** The sealed-audit event of one applied `policy.administer` change (audit subject `authority-change`), recorded before any file changes. */
export function authorityChangeAuditEvent(input: { readonly scopeId: string; readonly requester: Person; readonly decider: Person; readonly atMs: number;
  readonly operation: { readonly id: string; readonly version: number }; readonly commandId: string; readonly approvalId: string; readonly inputDigest: string;
  readonly before: string; readonly after: string; readonly counts: { readonly grantsAdded: number; readonly grantsRemoved: number; readonly bindingsAdded: number; readonly bindingsRemoved: number } }): AuditEvent {
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: input.scopeId, principal: { issuer: input.requester.issuer, subject: input.requester.subject },
    policyRevision: input.before, atMs: input.atMs, subject: { kind: 'authority-change', operation: { id: input.operation.id, version: input.operation.version },
      commandId: input.commandId, approvalId: input.approvalId, decider: { issuer: input.decider.issuer, subject: input.decider.subject }, inputDigest: input.inputDigest,
      revision: { before: input.before, after: input.after }, counts: { ...input.counts } } };
}
