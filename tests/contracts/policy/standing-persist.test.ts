import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, standingPattern, STANDING_GRANTS_MAX, type AuditEvent } from '#domain/index.js';
import { ApprovalApplication, AuditApplication, decideAgentToolCall, PersistentStanding, PolicyAdministrationApplication, SessionStanding, StandingApprovalError } from '#engine/index.js';
import { snapshotKnownSecrets, type KnownSecretSnapshot, createHmacIntegrity } from '#platform/index.js';

// PERSISTENT-APPROVALS G6: "in this project always" is the person's OWN grant written through policy.administer@1 — same approval chain,
// delegation bound, audit and archive; no second card; a person cannot persist what they do not hold; the company's separation of duties applies.
const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
type Actor = { issuer: string; subject: string };
const shell = (command: string) => { const result = standingPattern({ tool: 'run_shell', cell: 'shell-narrow-mutating', path: null, command }); if (!result.ok) throw new Error('pattern'); return result.pattern; };

async function fixture(options: { grants?: (me: Actor) => unknown[]; bindings?: (me: Actor) => unknown[]; separation?: boolean; v1?: boolean; knownSecrets?: KnownSecretSnapshot } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-standing-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
  const { principal } = await sessions.verifySession(undefined);
  const me = { issuer: principal.issuer, subject: principal.subject };
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'audit', 'authority-revisions');
  if (options.v1) await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [] }), { mode: 0o600 });
  else await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p1', roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }],
    separationOfDuties: options.separation ? [{ id: 'sod', rule: 'requester-cannot-approve', scopes: 'all' }] : [], restrictions: [], grants: options.grants?.(me) ?? [] }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: options.bindings?.(me) ?? [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }], modes: [] }), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 65_536 });
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
  const auditStore = await openSqliteAuditStore(ledger, sqlite, 'forbid'); closers.push(() => auditStore.close());
  const audit = new AuditApplication(auditStore, integrity);
  const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock, requestTtlMs: 60_000,
    audit: (event: AuditEvent) => { audit.record(event); } });
  const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source,
    integrity, clock, 'local-runtime', 10).decide({ schemaVersion: 1, scopeId: 's', approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
  const standing = new PersistentStanding({ administration, approve, policy: source, ...(options.knownSecrets ? { knownSecrets: options.knownSecrets } : {}) });
  const files = async () => JSON.parse(await readFile(policyPath, 'utf8'));
  const events = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event); }
    finally { db.close(); }
  };
  const decide = async (cell: 'shell-narrow-mutating' | 'shell-destructive', key: string | null, session = false) => decideAgentToolCall(await source.load(),
    { principal, scopeId: 's', tool: { name: 'run_shell' }, operation: { id: 'host.shell.run' }, cell, standing: key ? { key, session } : null });
  return { root, me, principal, source, standing, files, events, archive, decide, journal, policyPath };
}
const owned = (me: Actor) => [{ id: 't', effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: [me], resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'o', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['host.shell.run'] } }];

describe.skipIf(process.platform === 'win32')('persistent standing approvals (G6)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] persists the pattern as the person\'s own grant through policy.administer: one settled change, audited, archived, no second card', async () => {
    const f = await fixture({ grants: owned });
    const test = shell('npm test');
    expect(await f.standing.offer('s', f.me, test)).toEqual({ available: true });
    // Before: the floor raise asks for the narrow mutating command.
    expect((await f.decide('shell-narrow-mutating', test.key)).decision).toBe('require-approval');
    const view = await f.standing.persist({ scopeId: 's', principal: f.principal, pattern: test, sourceApprovalId: 'card-1' });
    expect(view).toMatchObject({ key: test.key, tool: 'run_shell', kind: 'command', text: 'npm test' });
    const policy = await f.files();
    const grant = policy.grants.find((entry: { id: string }) => entry.id === view.id);
    expect(grant).toMatchObject({ effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: [f.me], resource: { kind: 'agent-tool-call', ids: [test.key] } });
    // One approval exists (the operation approval the engine decided for the person); the audit names the decider; the archive holds the write.
    expect(f.journal.store.list('s', null, 10)).toHaveLength(1);
    const changes = f.events().filter(event => event.subject.kind === 'authority-change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ principal: f.me, subject: { decider: f.me, counts: { grantsAdded: 1 } } });
    expect((await readdir(f.archive)).filter(name => name.startsWith('k-'))).toHaveLength(1);
    // After: the same pattern no longer asks, a different one does; the grant lists as the person's own.
    expect(await f.decide('shell-narrow-mutating', test.key)).toMatchObject({ decision: 'allow', standing: { source: 'grant', grantId: view.id } });
    expect((await f.decide('shell-narrow-mutating', shell('npm run other').key)).decision).toBe('require-approval');
    expect((await f.decide('shell-destructive', test.key)).decision).toBe('require-approval');
    expect(await f.standing.list('s', f.me)).toEqual([view]);
    // Persisting the same pattern again is the same grant: no new change, no new approval.
    expect(await f.standing.persist({ scopeId: 's', principal: f.principal, pattern: test, sourceApprovalId: 'card-2' })).toEqual(view);
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
    expect(f.journal.store.list('s', null, 10)).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a person cannot persist what they do not hold (delegation bound): typed refusal, files unchanged, and the card would not offer it', async () => {
    // Only the request right and a read tool; no `agent-tool-call` authority and no owner root.
    const f = await fixture({ grants: me => [{ id: 'request', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['policy.administer'] } },
      { id: 'approve', effect: 'allow', actions: 'all', scopes: ['s'], principals: [me], resource: { kind: 'approval', ids: 'all' } }], bindings: () => [] });
    const before = await readFile(f.policyPath, 'utf8');
    const pattern = shell('npm test');
    expect(await f.standing.offer('s', f.me, pattern)).toEqual({ available: false, reason: 'delegation' });
    await expect(f.standing.persist({ scopeId: 's', principal: f.principal, pattern, sourceApprovalId: 'card' })).rejects.toMatchObject({ code: 'STANDING_DELEGATION' });
    expect(await readFile(f.policyPath, 'utf8')).toBe(before);
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
    // Holding exactly one key lets the person persist exactly that key.
    const g = await fixture({ grants: me => [...owned(me), { id: 'request', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['policy.administer'] } },
      { id: 'approve', effect: 'allow', actions: 'all', scopes: ['s'], principals: [me], resource: { kind: 'approval', ids: 'all' } },
      { id: 'mine', effect: 'allow', actions: ['invoke'], scopes: ['s'], principals: [me], resource: { kind: 'agent-tool-call', ids: [pattern.key] } }], bindings: () => [] });
    expect(await g.standing.offer('s', g.me, shell('npm run other'))).toEqual({ available: false, reason: 'delegation' });
    await expect(g.standing.persist({ scopeId: 's', principal: g.principal, pattern: shell('npm run other'), sourceApprovalId: 'card' })).rejects.toMatchObject({ code: 'STANDING_DELEGATION' });
    expect(await g.standing.offer('s', g.me, pattern)).toEqual({ available: true });
    await expect(g.standing.persist({ scopeId: 's', principal: g.principal, pattern, sourceApprovalId: 'card' })).resolves.toMatchObject({ key: pattern.key });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] the company\'s separation of duties applies to the engine\'s decision too: a person who may not approve their own request cannot persist', async () => {
    const f = await fixture({ grants: owned, separation: true });
    const before = await readFile(f.policyPath, 'utf8');
    await expect(f.standing.persist({ scopeId: 's', principal: f.principal, pattern: shell('npm test'), sourceApprovalId: 'card' })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(await readFile(f.policyPath, 'utf8')).toBe(before);
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a v1 policy is typed unsupported (never a crash, never offered); the person\'s persisted grants are bounded', async () => {
    const v1 = await fixture({ v1: true });
    expect(await v1.standing.offer('s', v1.me, shell('npm test'))).toEqual({ available: false, reason: 'unsupported' });
    await expect(v1.standing.persist({ scopeId: 's', principal: v1.principal, pattern: shell('npm test'), sourceApprovalId: 'card' })).rejects.toBeInstanceOf(StandingApprovalError);
    const full = await fixture({ grants: me => [...owned(me), ...Array.from({ length: STANDING_GRANTS_MAX }, (_, index) => ({ id: `standing-${index}`, effect: 'allow', actions: ['invoke'], scopes: ['s'],
      principals: [me], resource: { kind: 'agent-tool-call', ids: [`v1:run_shell:command:c${index}`] } }))] });
    expect(await full.standing.offer('s', full.me, shell('npm test'))).toEqual({ available: false, reason: 'limit' });
    await expect(full.standing.persist({ scopeId: 's', principal: full.principal, pattern: shell('npm test'), sourceApprovalId: 'card' })).rejects.toMatchObject({ code: 'STANDING_LIMIT' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] revoke removes only the person\'s own standing grant by the same operation, audited; the pattern asks again', async () => {
    const f = await fixture({ grants: owned });
    const test = shell('npm test');
    const view = await f.standing.persist({ scopeId: 's', principal: f.principal, pattern: test, sourceApprovalId: 'card' });
    await expect(f.standing.revoke({ scopeId: 's', principal: f.principal, id: 'owned', reason: 'x' })).rejects.toMatchObject({ code: 'STANDING_NOT_FOUND' });
    await f.standing.revoke({ scopeId: 's', principal: f.principal, id: view.id, reason: 'Revoked at the CLI' });
    expect(await f.standing.list('s', f.me)).toEqual([]);
    expect((await f.decide('shell-narrow-mutating', test.key)).decision).toBe('require-approval');
    expect(f.events().filter(event => event.subject.kind === 'authority-change').map(event => (event.subject as { counts: { grantsAdded: number; grantsRemoved: number } }).counts))
      .toEqual([expect.objectContaining({ grantsAdded: 1 }), expect.objectContaining({ grantsRemoved: 1 })]);
    // Persisting it again after the revoke is a new change (the command names the revision).
    await expect(f.standing.persist({ scopeId: 's', principal: f.principal, pattern: test, sourceApprovalId: 'card-3' })).resolves.toMatchObject({ key: test.key });
    expect((await f.decide('shell-narrow-mutating', test.key)).decision).toBe('allow');
  });
});

describe('this session\'s memory (G6)', () => {
  const me = { issuer: 'host', subject: '1' };
  it('is per scope, person and conversation, bounded, and empty after a restart', () => {
    const memory = new SessionStanding(2);
    const a = SessionStanding.sessionKey('s', me, 'conv-1'), b = SessionStanding.sessionKey('s', me, 'conv-2'), c = SessionStanding.sessionKey('s', { ...me, subject: '2' }, 'conv-1'), d = SessionStanding.sessionKey('t', me, 'conv-1');
    memory.remember(a, 'k1');
    expect(memory.has(a, 'k1')).toBe(true);
    for (const other of [b, c, d]) expect(memory.has(other, 'k1')).toBe(false);
    memory.remember(a, 'k2'); memory.remember(a, 'k3');
    expect([memory.has(a, 'k1'), memory.has(a, 'k2'), memory.has(a, 'k3')]).toEqual([false, true, true]);
    memory.forget(a);
    expect(memory.has(a, 'k2')).toBe(false);
    memory.remember(a, 'k1');
    // A restarted service is a new instance: nothing is written anywhere.
    expect(new SessionStanding().has(a, 'k1')).toBe(false);
  });
});

describe('B7 standing refusal before persistence or policy lookup', () => {
  it('refuses known and pattern secrets before any durable approval, policy or audit change', async () => {
    const knownSecrets = snapshotKnownSecrets([{ name: 'B7_TEST', value: 'fictitious-opaque-value' }]);
    const f = await fixture({ knownSecrets });
    const before = JSON.stringify(await f.files()), events = f.events().length;
    for (const command of ['echo fictitious-opaque-value', 'echo API_KEY=fictitious', 'echo Bearer fictitious-bearer-0123456789',
      ...[';', '$', '&', '(', ')'].map(delimiter => `printf '%s' 'https://user:fictitious${delimiter}tail@example.invalid/p'`)]) {
      const pattern = shell(command);
      expect(await f.standing.offer('s', f.me, pattern)).toEqual({ available: false, reason: 'unsupported' });
      await expect(f.standing.persist({ scopeId: 's', principal: f.principal, pattern, sourceApprovalId: 'fixture-card' })).rejects.toMatchObject({ code: 'STANDING_UNSUPPORTED', detail: 'unsafe-target' });
    }
    expect(JSON.stringify(await f.files())).toBe(before);
    expect(f.events()).toHaveLength(events);
    expect(await f.standing.list('s', f.me)).toEqual([]);
    expect(await f.standing.offer('s', f.me, shell('mkdir reports'))).toEqual({ available: true });
  });
});
