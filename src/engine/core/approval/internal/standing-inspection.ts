import { z } from 'zod';
import { STANDING_GRANT_KIND, evaluatePolicy, identitySchema, isStandingGrantId, policyResources, policySchema, standingGrantChange, type VerifiedPrincipal } from '#domain/index.js';
import { redactForRecord } from '#platform/index.js';
import { PolicyAuthorizationError, type PolicySource } from '#engine/core/policy/index.js';
import { effectInputDigest } from '#engine/core/effect/index.js';
import bounds from './standing-list.json' with { type: 'json' };

/** CA-1 (owner 2026-10-19): everyone's standing approvals in one scope, one bounded page; the bounds are registry data (`standing-list.json`). */
export const STANDING_GRANTS_LIST = Object.freeze({ ...bounds });
const markOf = (key: string) => Buffer.from(key, 'utf8').toString('base64url');
/** A page mark (`after`) is the last row's sort key (principal, then id), so a grant removed between pages never shifts the next page. */
const markKey = (mark: string) => { const key = Buffer.from(mark, 'base64url').toString('utf8'); return markOf(key) === mark && key.split('\0').length === 3 ? key : null; };
export const standingGrantsQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  after: z.string().min(1).max(2048).refine(mark => markKey(mark) !== null, 'STANDING_PAGE_MARK_INVALID').optional(),
  limit: z.number().int().min(1).max(bounds.pageMax).optional() }).strict();
export interface StandingGrantEntry { readonly id: string; readonly principals: readonly { readonly issuer: string; readonly subject: string }[]; readonly tool: string;
  readonly kind: 'command' | 'directory' | 'unknown'; readonly pattern: string; readonly scopes: 'all' | readonly string[]; readonly sinceMs: number | null }
/** `since`: `complete` = every audited change of the scope was read; `partial` = the scan bound was reached; `unavailable` = no readable audit. */
export interface StandingGrantsPage { readonly schemaVersion: 1; readonly scopeId: string; readonly revision: string; readonly rows: readonly StandingGrantEntry[];
  readonly next: string | null; readonly since: 'complete' | 'partial' | 'unavailable' }
/** Sealed `authority-change` records of one scope, oldest first (composition: the verified audit reader); opened only after the decision allowed. */
export interface AuthorityChangeHistory {
  open(scopeId: string): Promise<{ page(afterSequence: number, limit: number): readonly { readonly sequence: number; readonly atMs: number; readonly inputDigest: string }[]; close(): void }>;
}
const sortKey = (grant: { readonly id: string; readonly principals: 'all' | readonly { readonly issuer: string; readonly subject: string }[] }) =>
  grant.principals === 'all' ? `\0\0${grant.id}` : `${grant.principals[0]!.issuer}\0${grant.principals[0]!.subject}\0${grant.id}`;
const parseKey = (key: string) => {
  const match = /^v1:([^:]+):(command|directory):([\s\S]*)$/u.exec(key);
  return match ? { tool: match[1]!, kind: match[2] as 'command' | 'directory', pattern: redactForRecord(match[3]!) } : { tool: '?', kind: 'unknown' as const, pattern: redactForRecord(key) };
};

/**
 * Read-only inspection of every principal's persisted standing approvals (`deckent policy grants --all`). Visibility is a named, grantable
 * action (`policy` / `inspect-standing-grants`, v13 first-run: the founding admin only), never a role check: the policy is loaded once, the
 * decision is taken on it, and only an `allow` lists rows or opens the audit history. Patterns are redacted; no value or secret is returned.
 */
export class StandingGrantsInspection {
  constructor(private readonly deps: { readonly policy: PolicySource; readonly history?: AuthorityChangeHistory }) {}
  async list(input: unknown, principal: VerifiedPrincipal): Promise<StandingGrantsPage> {
    const query = standingGrantsQuerySchema.parse(input), limit = query.limit ?? bounds.pageDefault;
    const after = query.after === undefined ? null : markKey(query.after);
    let loaded: unknown, decision;
    try {
      loaded = await this.deps.policy.load();
      decision = evaluatePolicy(loaded, { principal, scopeId: query.scopeId, action: policyResources.policy.actions[0], resource: { kind: policyResources.policy.kind, id: query.scopeId } });
    } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow') throw new PolicyAuthorizationError('POLICY_DENIED');
    const policy = policySchema.parse(loaded);
    const standing = policy.grants.filter(grant => grant.resource.kind === STANDING_GRANT_KIND && isStandingGrantId(grant.id) && (grant.scopes === 'all' || grant.scopes.includes(query.scopeId)))
      .map(grant => ({ grant, key: sortKey(grant) })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const remaining = after === null ? standing : standing.filter(entry => entry.key > after);
    const page = remaining.slice(0, limit);
    // The audited change that created a grant is the one whose input is exactly the governed standing change (same digest the intent pinned).
    const digests = new Map<string, string>();
    for (const { grant } of page) {
      if (grant.principals === 'all' || grant.principals.length !== 1 || grant.scopes === 'all' || grant.scopes.length !== 1 || grant.resource.ids === 'all' || grant.resource.ids.length !== 1) continue;
      digests.set(effectInputDigest(standingGrantChange({ id: grant.id, principal: grant.principals[0]!, scopeId: grant.scopes[0]!, key: grant.resource.ids[0]! })), grant.id);
    }
    const found = new Map<string, number>();
    const since = page.length === 0 ? 'complete' as const : await this.since(query.scopeId, digests, found);
    const rows = page.map(({ grant }) => Object.freeze({ id: grant.id, principals: grant.principals === 'all' ? Object.freeze([]) : Object.freeze(grant.principals.map(item => Object.freeze({ issuer: item.issuer, subject: item.subject }))),
      ...parseKey(grant.resource.ids === 'all' ? '*' : grant.resource.ids[0]!), scopes: grant.scopes, sinceMs: found.get(grant.id) ?? null }));
    return Object.freeze({ schemaVersion: 1 as const, scopeId: query.scopeId, revision: policy.revision, rows: Object.freeze(rows),
      next: remaining.length > limit ? markOf(page[page.length - 1]!.key) : null, since });
  }
  /** Bounded scan of the scope's sealed authority changes (registry page × pages); the latest matching change is when the grant began. */
  private async since(scopeId: string, digests: ReadonlyMap<string, string>, found: Map<string, number>): Promise<'complete' | 'partial' | 'unavailable'> {
    if (!this.deps.history) return 'unavailable';
    let reader;
    try { reader = await this.deps.history.open(scopeId); } catch { return 'unavailable'; }
    try {
      let afterSequence = 0;
      for (let pages = 0; pages < bounds.historyPagesMax; pages++) {
        const rows = reader.page(afterSequence, bounds.historyPage);
        for (const row of rows) { const id = digests.get(row.inputDigest); if (id !== undefined) found.set(id, row.atMs); }
        if (rows.length < bounds.historyPage) return 'complete';
        afterSequence = rows[rows.length - 1]!.sequence;
      }
      return 'partial';
    } catch { found.clear(); return 'unavailable'; }
    finally { reader.close(); }
  }
}
