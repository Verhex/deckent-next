import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, POLICY_ADMINISTER_OPERATION,
  type AuditEvent, type EffectCommand, type VerifiedPrincipal } from '#domain/index.js';
import { ApprovalApplication, AuditApplication, AuthorityDocumentTarget, EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization,
  PermissionModeApplication, PolicyAdministrationApplication } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// POLICY-ADMIN P3: `policy.administer@1` is a Core catalog operation over the C11 effect port. Every change opens a C12 approval (a card)
// even on an allow grant; the change is bounded by the decider's authority at the effect (I3); it is audited before the files change;
// the generic operation producer refuses it (`surface: 'authority'`); `/mode` writes through the same authority writer.
const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
type Actor = { issuer: string; subject: string };
const readTool = (id: string, principal: Actor) => ({ id, effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: [principal], resource: { kind: 'agent-tool', ids: ['read_file'] } });

async function fixture(grantsFor: (me: Actor) => unknown[], bindingsFor: (me: Actor) => unknown[], modes: (me: Actor) => unknown[] = () => []) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-admin-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
  const time = { wallMs: 1_000 };
  const clock = { sample: () => ({ wallMs: time.wallMs, monotonicMs: time.wallMs }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
  const { principal } = await sessions.verifySession(undefined);
  const me = { issuer: principal.issuer, subject: principal.subject };
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'audit', 'authority-revisions');
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p1', separationOfDuties: [], restrictions: [], grants: grantsFor(me),
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }] }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: bindingsFor(me), modes: modes(me) }), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 16_384 });
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const effects = await openSqliteAttemptStore(ledger, sqlite, 'forbid'); closers.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
  const auditStore = await openSqliteAuditStore(ledger, sqlite, 'forbid'); closers.push(() => auditStore.close());
  const audit = new AuditApplication(auditStore, integrity);
  const deps = { authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
    requestTtlMs: 60_000, audit: (event: AuditEvent) => { audit.record(event); } };
  const admin = new PolicyAdministrationApplication(deps);
  // Another local person decides through their own live session (a test witness with the session shape; the OS witness is the caller's).
  const witness = (decider: VerifiedPrincipal) => decider === principal ? sessions : { revoke: async () => undefined, isSessionActive: async () => true,
    verifySession: async () => ({ principal: decider, session: { schemaVersion: 1 as const, sessionId: `session-${decider.subject}`, authorityRef: `authority-${decider.subject}`,
      kind: 'os-user' as const, principalRef: { id: decider.id, issuer: decider.issuer, subject: decider.subject }, scopeIds: ['s'], authenticatedAt: 1_000, expiresAt: 10_000_000 } }) };
  const decide = (decider: VerifiedPrincipal, approvalId: string) => new ApprovalApplication(journal.store, { verify: async () => decider }, witness(decider) as typeof sessions, source, integrity, clock,
    'terminal', 10).decide({ schemaVersion: 1, scopeId: 's', approvalId, commandId: `decide-${approvalId}`, expectedRevision: 0, decision: 'allow', reason: 'Reviewed' });
  const command = (commandId: string, input: unknown, expectedVersion = 'p1+b1'): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 's',
    operation: POLICY_ADMINISTER_OPERATION.operation, target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input, expectedVersion });
  const files = async () => ({ policy: JSON.parse(await readFile(policyPath, 'utf8')), bindings: JSON.parse(await readFile(bindingsPath, 'utf8')) });
  const events = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event); }
    finally { db.close(); }
  };
  const person = (subject: string): VerifiedPrincipal => ({ id: `os:${subject}`, issuer: principal.issuer, subject, assurance: 'os-user', scopeIds: ['s'] }) as VerifiedPrincipal;
  return { root, me, principal, person, source, admin, deps, decide, command, files, events, journal, effects, clock, sessions, archive, integrity };
}
const addRead = (id: string, to: Actor) => ({ schemaVersion: 1, changes: [{ kind: 'grant.add', grant: readTool(id, to) }] });
const ownerRoot = (me: Actor) => [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }];

describe.skipIf(process.platform === 'win32')('policy.administer@1 (POLICY-ADMIN P3)', () => {
  it('never applies silently: even the owner root with an allow grant and a full-auto mode gets a pending card; after the allow the change settles once, audited and archived', async () => {
    const f = await fixture(() => [], ownerRoot, me => [{ id: 'fa', principal: me, scopes: ['s'], mode: 'full-auto' }]);
    const other = { issuer: f.me.issuer, subject: '424242' };
    const first = await f.admin.submit(f.command('c1', addRead('share', other)));
    expect(first).toMatchObject({ status: 'approval-pending', operation: { id: 'policy.administer', version: 1 } });
    expect((await f.files()).policy.revision).toBe('p1');
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
    if (first.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(f.principal, first.approval.approvalId);
    const settled = await f.admin.submit(f.command('c1', addRead('share', other)));
    expect(settled).toMatchObject({ status: 'settled', version: expect.stringMatching(/^a-[0-9a-f]{40}\+b1$/) });
    const after = await f.files();
    expect(after.policy.grants.map((grant: { id: string }) => grant.id)).toEqual(['share']);
    expect(after.policy.revision).toMatch(/^a-[0-9a-f]{40}$/);
    expect((await f.source.load()).revision).toBe(settled.status === 'settled' ? settled.version : null);
    const changes = f.events().filter(event => event.subject.kind === 'authority-change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ principal: f.me, scopeId: 's', policyRevision: 'p1+b1', subject: { kind: 'authority-change',
      operation: { id: 'policy.administer', version: 1 }, commandId: 'c1', approvalId: first.approval.approvalId, decider: f.me,
      revision: { before: 'p1+b1', after: settled.status === 'settled' ? settled.version : '' }, counts: { grantsAdded: 1, grantsRemoved: 0, bindingsAdded: 0, bindingsRemoved: 0 } } });
    expect((await readdir(f.archive)).filter(name => name.startsWith('k-'))).toHaveLength(1);
    // Replay of the same command answers the settled outcome; nothing changes twice.
    expect(await f.admin.submit(f.command('c1', addRead('share', other)))).toEqual(settled);
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
  });

  it('bounds the change by the decider\'s authority (I3): a member may request, a decider without the authority cannot admit it, the owner can', async () => {
    // The caller holds only the request right (operation policy.administer) and read_file; two other persons may decide approvals.
    const f = await fixture(me => [{ id: 'request', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['policy.administer'] } },
      readTool('mine', me), { id: 'decide', effect: 'allow', actions: 'all', scopes: ['s'], principals: 'all', resource: { kind: 'approval', ids: 'all' } }],
    () => [{ id: 'root', principals: [{ issuer: 'placeholder', subject: '1' }], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }]);
    // Rebind the owner root to a separate person on the same host (the fixture wrote a placeholder).
    const owner = f.person('7001'), weak = f.person('7002');
    const bindings = (await f.files()).bindings;
    await writeFile(join(f.root, 'bindings.json'), JSON.stringify({ ...bindings, revision: 'b2', bindings: [{ ...bindings.bindings[0], principals: [{ issuer: owner.issuer, subject: owner.subject }] }] }), { mode: 0o600 });
    const wide = { schemaVersion: 1, changes: [{ kind: 'grant.add', grant: { ...readTool('edit', f.me), resource: { kind: 'agent-tool', ids: ['edit_file'] } } }] };
    const pending = await f.admin.submit(f.command('m1', wide, 'p1+b2'));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(weak, pending.approval.approvalId);
    await expect(f.admin.submit(f.command('m1', wide, 'p1+b2'))).rejects.toMatchObject({ code: 'POLICY_DELEGATION_EXCEEDS' });
    expect((await f.files()).policy.grants.map((grant: { id: string }) => grant.id)).toEqual(['request', 'mine', 'decide']);
    const again = await f.admin.submit(f.command('m2', wide, 'p1+b2'));
    if (again.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(owner, again.approval.approvalId);
    expect(await f.admin.submit(f.command('m2', wide, 'p1+b2'))).toMatchObject({ status: 'settled' });
    expect((await f.files()).policy.grants.map((grant: { id: string }) => grant.id)).toEqual(['request', 'mine', 'decide', 'edit']);
    expect(f.events().filter(event => event.subject.kind === 'authority-change')[0]).toMatchObject({ principal: f.me,
      subject: { decider: { issuer: owner.issuer, subject: owner.subject }, commandId: 'm2' } });
  });

  it('refuses a stale revision at the effect (conditional write): nothing is written and the record is not settled', async () => {
    const f = await fixture(() => [], ownerRoot);
    const pending = await f.admin.submit(f.command('s1', addRead('share', f.me)));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(f.principal, pending.approval.approvalId);
    const bindings = (await f.files()).bindings;
    await writeFile(join(f.root, 'bindings.json'), JSON.stringify({ ...bindings, revision: 'b9' }), { mode: 0o600 });
    await expect(f.admin.submit(f.command('s1', addRead('share', f.me)))).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    expect((await f.files()).policy.grants).toEqual([]);
  });

  it('refuses a change that lands between the observation and the write, inside the write lock: terminal refusal, nothing written', async () => {
    const f = await fixture(() => [], ownerRoot);
    const pending = await f.admin.submit(f.command('w1', addRead('share', f.me)));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(f.principal, pending.approval.approvalId);
    // Another writer replaces bindings after the C11 observation passed and before this write takes the store's window.
    const racing = { load: () => f.source.load(), identity: () => f.source.identity(), lookupAuthority: (key: string) => f.source.lookupAuthority(key),
      updateAuthority: async <T>(work: Parameters<typeof f.source.updateAuthority<T>>[0], key?: string) => {
        const bindings = (await f.files()).bindings;
        await writeFile(join(f.root, 'bindings.json'), JSON.stringify({ ...bindings, revision: 'b-race' }), { mode: 0o600 });
        return f.source.updateAuthority(work, key);
      } };
    const raced = new PolicyAdministrationApplication({ ...f.deps, authority: racing });
    await expect(raced.submit(f.command('w1', addRead('share', f.me)))).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    expect((await f.files()).policy.grants).toEqual([]);
    expect(await f.effects.loadEffect('s', 'w1')).toMatchObject({ state: 'refused', refusal: 'EFFECT_PRECONDITION_CHANGED' });
  });

  it('is refused by the generic operation producer before any approval, ledger or file access (surface: authority), even with a reachable target', async () => {
    const f = await fixture(() => [], ownerRoot);
    const target = new AuthorityDocumentTarget(f.source, { bound: () => undefined, audit: () => undefined });
    const generic = new EffectApplication({ async resolve(ref) { return ref.id === 'policy.administer' ? POLICY_ADMINISTER_OPERATION : null; } },
      { resolve: kind => kind === AUTHORITY_DOCUMENT_TARGET_KIND ? target : null }, f.effects,
      new OperationApprovalBroker(f.journal.store, f.integrity, f.source, f.clock, { requestTtlMs: 60_000, defaultAdmitWithinMs: 60_000 }), f.sessions,
      new OperationPolicyAuthorization(f.source), f.clock);
    await expect(generic.submit('execute', f.command('g1', addRead('share', f.me)))).rejects.toMatchObject({ code: 'OPERATION_SURFACE_RESTRICTED' });
    expect(f.journal.store.list('s', null, 10)).toEqual([]);
    expect(await f.effects.loadEffect('s', 'g1')).toBeNull();
    expect((await f.files()).policy.revision).toBe('p1');
  });

  it('routes /mode through the same authority writer: the mode write is archived and keeps its own audit event and view', async () => {
    const f = await fixture(me => [{ id: 'set-mode', effect: 'allow', actions: ['set'], scopes: ['s'], principals: [me], resource: { kind: 'permission-mode', ids: 'all' } }], ownerRoot);
    const modes = new PermissionModeApplication(f.source, () => undefined, () => 5);
    expect(await modes.set(f.principal, { schemaVersion: 1, scopeId: 's', mode: 'auto-edit', expectedRevision: 'p1+b1' })).toMatchObject({ mode: 'auto-edit', changed: true });
    expect((await f.files()).bindings.revision).toMatch(/^m-[0-9a-f]{40}$/);
    expect((await readdir(f.archive)).filter(name => name.startsWith('r-'))).toHaveLength(1);
  });
});
