import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, mcpPrincipalRef, resolvePolicyBindings, standingPattern,
  type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, AuditApplication, FIRST_RUN_TOOL_NAMES, PersistentStanding, PolicyAdministrationApplication, STANDING_GRANTS_LIST as bounds, StandingGrantsInspection, type AuthorityChangeHistory } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// CA-1 (owner 2026-10-19, "every visibility is a named, grantable action"): everyone's standing approvals in one scope, only when policy grants the
// caller `policy` / `inspect-standing-grants` (v13 first-run: the founding admin). A refusal reads nothing beyond the policy it decided on; pages are
// bounded by registry data and a cursor; patterns are redacted; the start time is the sealed authority change that made the grant.
const person = { issuer: 'host', subject: 'owner' };
const colleagueRef = { issuer: 'host', subject: 'colleague' };
const mcpRef = mcpPrincipalRef(person);
const owner = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation'] };
const colleague = { ...owner, id: 'colleague', ...colleagueRef };
const mcp = { ...owner, ...mcpRef, assurance: 'workload-verified' as const };
const built = firstRunPolicyTemplate({ scopeId: 'installation', principal: person, ...FIRST_RUN_TOOL_NAMES });
const standing = (id: string, who: { issuer: string; subject: string }, key: string, scopes: 'all' | string[] = ['installation']): PolicyGrant =>
  ({ id, effect: 'allow', actions: ['invoke'], scopes, principals: [who], resource: { kind: 'agent-tool-call', ids: [key] } });
const policyWith = (grants: readonly PolicyGrant[], drop: readonly string[] = []) =>
  resolvePolicyBindings({ ...built.policy, grants: [...built.policy.grants.filter(rule => !drop.includes(rule.id)), ...grants] }, built.bindings);
const spyHistory = (rows: readonly { sequence: number; atMs: number; inputDigest: string }[] = []) => {
  const opened: string[] = [];
  const history: AuthorityChangeHistory = { open: async scopeId => { opened.push(scopeId); return { page: (after, limit) => rows.filter(row => row.sequence > after).slice(0, limit), close: () => undefined }; } };
  return { history, opened };
};
const query = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 'installation', ...extra });
const grants = [standing('standing-b', colleagueRef, 'v1:run_shell:command:make'), standing('standing-a', person, 'v1:run_shell:command:npm test'),
  standing('standing-c', person, 'v1:edit_file:directory:src/*'), standing('standing-other', person, 'v1:run_shell:command:ls', ['other']),
  { id: 'company-tool-call', effect: 'allow' as const, actions: ['invoke'], scopes: ['installation'], principals: [person], resource: { kind: 'agent-tool-call', ids: 'all' as const } }];

describe('policy grants --all: the inspection (CA-1)', () => {
  it('the founding admin of a v13 installation sees every person\'s standing grants of the scope, ordered by person, redacted, nothing else', async () => {
    const { history, opened } = spyHistory();
    const page = await new StandingGrantsInspection({ policy: { load: async () => policyWith(grants) }, history }).list(query(), owner);
    expect(page.rows.map(row => [row.principals, row.id])).toEqual([[[colleagueRef], 'standing-b'], [[person], 'standing-a'], [[person], 'standing-c']]);
    expect(page.rows[1]).toEqual({ id: 'standing-a', principals: [person], tool: 'run_shell', kind: 'command', pattern: 'npm test', scopes: ['installation'], sinceMs: null });
    expect(page.rows[2]).toMatchObject({ tool: 'edit_file', kind: 'directory', pattern: 'src/*' });
    expect(page).toMatchObject({ schemaVersion: 1, scopeId: 'installation', next: null, since: 'complete' });
    expect(opened).toEqual(['installation']);
    // A pattern that looks like a secret is masked; the raw key is never returned.
    const secret = `ghp_${'a'.repeat(36)}`;
    const masked = await new StandingGrantsInspection({ policy: { load: async () => policyWith([standing('standing-s', colleagueRef, `v1:run_shell:command:curl -H token=${secret}`)]) } }).list(query(), owner);
    expect(JSON.stringify(masked)).not.toContain(secret); expect(masked.rows[0]!.pattern).toContain('[REDACTED]'); expect(masked.since).toBe('unavailable');
  });

  it('refuses a person, the MCP actor and a revoked rule before anything else is read; a policy may grant it to the MCP actor explicitly', async () => {
    for (const [who, policy] of [[colleague, policyWith(grants)], [mcp, policyWith(grants)], [owner, policyWith(grants, ['first-run-standing-grants-all'])]] as const) {
      const { history, opened } = spyHistory();
      await expect(new StandingGrantsInspection({ policy: { load: async () => policy }, history }).list(query(), who)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(opened).toEqual([]);
    }
    // Another scope is not the installed one: the v13 rule does not reach it.
    await expect(new StandingGrantsInspection({ policy: { load: async () => policyWith(grants) } }).list(query({ scopeId: 'other' }), { ...owner, scopeIds: ['other'] }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // An unreadable policy is a refusal too (never an empty list).
    await expect(new StandingGrantsInspection({ policy: { load: async () => { throw new Error('gone'); } } }).list(query(), owner)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    // The template grants no AI actor; only an explicit policy rule naming the MCP actor allows it (visibility is policy data, not a role check).
    const explicit = { id: 'mcp-standing-read', effect: 'allow' as const, actions: ['inspect-standing-grants'], scopes: ['installation'], principals: [mcpRef], resource: { kind: 'policy', ids: 'all' as const } };
    expect((await new StandingGrantsInspection({ policy: { load: async () => policyWith([...grants, explicit]) } }).list(query(), mcp)).rows).toHaveLength(3);
  });

  it('pages are bounded by the registry and continue by cursor without overlap, also when a listed grant is removed between pages', async () => {
    const many = Array.from({ length: 7 }, (_, index) => standing(`standing-${index}`, index % 2 ? colleagueRef : person, `v1:run_shell:command:echo ${index}`));
    const source = { current: policyWith(many) };
    const inspection = new StandingGrantsInspection({ policy: { load: async () => source.current } });
    const first = await inspection.list(query({ limit: 3 }), owner);
    expect(first.rows).toHaveLength(3); expect(first.next).not.toBeNull();
    source.current = policyWith(many.filter(grant => grant.id !== first.rows[2]!.id));
    const second = await inspection.list(query({ limit: 3, after: first.next }), owner);
    const third = await inspection.list(query({ limit: 3, after: second.next }), owner);
    expect(third.next).toBeNull();
    const ids = [...first.rows, ...second.rows, ...third.rows].map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length); expect(ids).toHaveLength(7);
    // Default page size is the registry's; a larger limit or a forged cursor is refused before the policy is read.
    expect(bounds.pageDefault).toBeLessThanOrEqual(bounds.pageMax);
    let loads = 0;
    const counted = new StandingGrantsInspection({ policy: { load: async () => { loads++; return source.current; } } });
    await expect(counted.list(query({ limit: bounds.pageMax + 1 }), owner)).rejects.toBeInstanceOf(ZodError);
    await expect(counted.list(query({ after: 'not a cursor!' }), owner)).rejects.toBeInstanceOf(ZodError);
    expect(loads).toBe(0);
  });

  it('since: the bounded history scan says partial when the registry bound is reached, unavailable when the audit cannot be read', async () => {
    const full = Array.from({ length: bounds.historyPage * bounds.historyPagesMax + 1 }, (_, index) => ({ sequence: index + 1, atMs: index, inputDigest: 'x' }));
    const { history } = spyHistory(full);
    expect((await new StandingGrantsInspection({ policy: { load: async () => policyWith(grants) }, history }).list(query(), owner)).since).toBe('partial');
    const broken: AuthorityChangeHistory = { open: async () => { throw new Error('AUDIT_UNAVAILABLE'); } };
    const page = await new StandingGrantsInspection({ policy: { load: async () => policyWith(grants) }, history: broken }).list(query(), owner);
    expect(page.since).toBe('unavailable'); expect(page.rows).toHaveLength(3); expect(page.rows.every(row => row.sinceMs === null)).toBe(true);
  });
});

// The start time against the real chain: a grant persisted through policy.administer@1 (sealed audit, real ledger) is matched to its audited change.
const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
describe.skipIf(process.platform !== 'linux')('policy grants --all: start time from the sealed audit (CA-1)', () => {
  it('[requires Linux live OS session /proc identity] a persisted grant shows when its audited change happened; a hand-written one shows none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-standing-all-')); closers.push(() => rm(root, { recursive: true, force: true }));
    const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
    const clock = { sample: () => ({ wallMs: 1_700_000_000_000, monotonicMs: 1 }) };
    const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
    const { principal } = await sessions.verifySession(undefined);
    const me = { issuer: principal.issuer, subject: principal.subject };
    const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
    const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json');
    await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p1', roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }], separationOfDuties: [], restrictions: [],
      grants: [{ id: 't', effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: [me], resource: { kind: 'agent-tool', ids: ['run_shell'] } },
        { id: 'o', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['host.shell.run'] } },
        { ...standing('standing-hand', colleagueRef, 'v1:run_shell:command:make'), scopes: ['s'] }] }), { mode: 0o600 });
    await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }], modes: [] }), { mode: 0o600 });
    const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: join(root, 'audit', 'authority-revisions'), ownerUid: process.getuid!(), maxBytes: 65_536 });
    const integrity = createHmacIntegrity('key', randomBytes(32));
    const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
    const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
    const auditStore = await openSqliteAuditStore(ledger, sqlite, 'forbid'); closers.push(() => auditStore.close());
    const audit = new AuditApplication(auditStore, integrity);
    const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock, requestTtlMs: 60_000,
      audit: (event: AuditEvent) => { audit.record(event); } });
    const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source,
      integrity, clock, 'local-runtime', 10, undefined, undefined, { interactive: async () => true }).decide({ schemaVersion: 1, scopeId: 's', approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
    const pattern = standingPattern({ tool: 'run_shell', cell: 'shell-narrow-mutating', path: null, command: 'npm test' });
    if (!pattern.ok) throw new Error('pattern');
    const view = await new PersistentStanding({ administration, approve, policy: source }).persist({ scopeId: 's', principal, pattern: pattern.pattern, sourceApprovalId: 'card-1' });
    // The owner role covers `policy` (every vocabulary kind), so the installation owner may inspect; the history is the verified kind page.
    const history: AuthorityChangeHistory = { open: async scopeId => ({ page: (after, limit) => audit.listKind(scopeId, 'authority-change', after, limit).map(({ sequence, event }) =>
      ({ sequence, atMs: event.atMs, inputDigest: event.subject.kind === 'authority-change' ? event.subject.inputDigest : '' })), close: () => undefined }) };
    const page = await new StandingGrantsInspection({ policy: source, history }).list({ schemaVersion: 1, scopeId: 's' }, principal);
    expect(page.since).toBe('complete');
    expect(page.rows.find(row => row.id === view.id)).toMatchObject({ principals: [me], pattern: 'npm test', sinceMs: 1_700_000_000_000 });
    expect(page.rows.find(row => row.id === 'standing-hand')).toMatchObject({ principals: [colleagueRef], sinceMs: null });
    // The kind page verifies seals: a record sealed with another key is refused, which the inspection reports as unavailable (rows still complete).
    const foreign = new AuditApplication(auditStore, createHmacIntegrity('other', randomBytes(32)));
    const forged: AuthorityChangeHistory = { open: async scopeId => ({ page: (after, limit) => foreign.listKind(scopeId, 'authority-change', after, limit).map(({ sequence, event }) =>
      ({ sequence, atMs: event.atMs, inputDigest: '' })), close: () => undefined }) };
    const unverified = await new StandingGrantsInspection({ policy: source, history: forged }).list({ schemaVersion: 1, scopeId: 's' }, principal);
    expect(unverified.since).toBe('unavailable'); expect(unverified.rows).toHaveLength(2);
  });
});
