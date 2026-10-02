import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, POLICY_ADMINISTER_OPERATION,
  type AuditEvent, type EffectCommand, type VerifiedPrincipal } from '#domain/index.js';
import { ApprovalApplication, AuditApplication, PolicyAdministrationApplication } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

// POLICY-HARDEN (P3-R) shares the POLICY-ADMIN P3 fixture. Original:
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
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
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
  const catalog = { async resolve(ref: { id: string; version: number }) { return ref.id === 'policy.administer' && ref.version === 1 ? POLICY_ADMINISTER_OPERATION : null; } };
  const restriction = (surface?: 'authority') => ({ catalog, ...(surface ? { surface } : {}), refused: (event: AuditEvent) => { audit.record(event); } });
  /** A general surface (SDK/CLI/MCP/terminal card) or, with `surface`, the authority decider (the future `/policy`). */
  const decideOn = (decider: VerifiedPrincipal, approvalId: string, decision: 'allow' | 'deny' = 'allow', surface?: 'authority') => new ApprovalApplication(journal.store,
    { verify: async () => decider }, witness(decider) as typeof sessions, source, integrity, clock, 'terminal', 10, undefined, restriction(surface))
    .decide({ schemaVersion: 1, scopeId: 's', approvalId, commandId: `decide-${decision}-${approvalId}`, expectedRevision: 0, decision, reason: 'Reviewed' });
  const decide = (decider: VerifiedPrincipal, approvalId: string) => decideOn(decider, approvalId, 'allow', 'authority');
  const command = (commandId: string, input: unknown, expectedVersion = 'p1+b1'): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 's',
    operation: POLICY_ADMINISTER_OPERATION.operation, target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input, expectedVersion });
  const files = async () => ({ policy: JSON.parse(await readFile(policyPath, 'utf8')), bindings: JSON.parse(await readFile(bindingsPath, 'utf8')) });
  const events = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event); }
    finally { db.close(); }
  };
  const person = (subject: string): VerifiedPrincipal => ({ id: `os:${subject}`, issuer: principal.issuer, subject, assurance: 'os-user', scopeIds: ['s'] }) as VerifiedPrincipal;
  return { decideOn, root, me, principal, person, source, admin, deps, decide, command, files, events, journal, effects, clock, sessions, archive, integrity };
}
const addRead = (id: string, to: Actor) => ({ schemaVersion: 1, changes: [{ kind: 'grant.add', grant: readTool(id, to) }] });
const ownerRoot = (me: Actor) => [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }];


const refusals = (events: readonly AuditEvent[]) => events.filter(event => event.subject.kind === 'authority-refusal').map(event => event.subject);

describe.skipIf(process.platform === 'win32')('policy.administer@1 hardening (POLICY-HARDEN P3-R)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] K3: a general approval surface cannot allow an authority-surface approval (the request stays pending, the refusal is audited); a deny is not an authority', async () => {
    const f = await fixture(() => [], ownerRoot);
    const pending = await f.admin.submit(f.command('k1', addRead('share', f.me)));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await expect(f.decideOn(f.principal, pending.approval.approvalId)).rejects.toMatchObject({ code: 'APPROVAL_SURFACE_RESTRICTED' });
    expect(f.journal.store.load('s', pending.approval.approvalId)).toMatchObject({ status: 'pending', decision: null });
    expect(refusals(f.events())).toEqual([expect.objectContaining({ stage: 'decide', code: 'APPROVAL_SURFACE_RESTRICTED', commandId: 'k1', approvalId: pending.approval.approvalId,
      operation: { id: 'policy.administer', version: 1 } })]);
    expect(f.events().find(event => event.subject.kind === 'authority-refusal')).toMatchObject({ principal: f.me });
    // The authority decider (the future /policy surface) still decides; the same command then settles once.
    await f.decide(f.principal, pending.approval.approvalId);
    expect(await f.admin.submit(f.command('k1', addRead('share', f.me)))).toMatchObject({ status: 'settled' });
    // A deny through a general surface only withdraws the request: it grants nothing and is allowed.
    const second = await f.admin.submit(f.command('k2', addRead('other', f.me), (await f.source.load()).revision));
    if (second.status !== 'approval-pending') throw new Error('pending expected');
    await expect(f.decideOn(f.principal, second.approval.approvalId, 'deny')).resolves.toMatchObject({ status: 'decided', decision: { decision: 'deny' } });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a claimed intent whose grant was withdrawn before the effect is refused terminally: the authority record is not left busy, a later change is admitted, the refusal is audited', async () => {
    const f = await fixture(() => [], ownerRoot);
    const revoked = { load: async () => { const now = await f.effects.loadEffect('s', 'lost'); const policy = await f.source.load(); return now ? { ...policy, grants: [], bindings: { ...policy.bindings, entries: [] } } : policy; },
      identity: () => f.source.identity() };
    const app = new PolicyAdministrationApplication({ ...f.deps, policy: revoked as never });
    const pending = await app.submit(f.command('lost', addRead('share', f.me)));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(f.principal, pending.approval.approvalId);
    await expect(app.submit(f.command('lost', addRead('share', f.me)))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await f.effects.loadEffect('s', 'lost')).toMatchObject({ state: 'refused', refusal: 'EFFECT_REJECTED' });
    expect((await f.files()).policy.grants).toEqual([]);
    // Replay answers the same terminal refusal (no second audit event); the authority record is free for the next change.
    await expect(f.admin.submit(f.command('lost', addRead('share', f.me)))).rejects.toMatchObject({ code: 'EFFECT_REJECTED' });
    expect(refusals(f.events())).toEqual([expect.objectContaining({ stage: 'settle', code: 'POLICY_DENIED', commandId: 'lost' })]);
    expect(await f.admin.submit(f.command('next', addRead('share', f.me)))).toMatchObject({ status: 'approval-pending' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] audits refusals: an exceeded delegation bound and an invalid change set are recorded with stage, code and command (no grants inside)', async () => {
    const f = await fixture(me => [{ id: 'request', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [me], resource: { kind: 'operation', ids: ['policy.administer'] } },
      readTool('mine', me), { id: 'decide', effect: 'allow', actions: 'all', scopes: ['s'], principals: 'all', resource: { kind: 'approval', ids: 'all' } }],
    () => [{ id: 'root', principals: [{ issuer: 'placeholder', subject: '1' }], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }]);
    const weak = f.person('7002');
    const wide = { schemaVersion: 1, changes: [{ kind: 'grant.add', grant: { ...readTool('edit', f.me), resource: { kind: 'agent-tool', ids: ['edit_file'] } } }] };
    const pending = await f.admin.submit(f.command('x1', wide));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await f.decide(weak, pending.approval.approvalId);
    await expect(f.admin.submit(f.command('x1', wide))).rejects.toMatchObject({ code: 'POLICY_DELEGATION_EXCEEDS' });
    await expect(f.admin.submit(f.command('x2', 'garbage'))).rejects.toMatchObject({ code: 'POLICY_CHANGE_INVALID' });
    expect(refusals(f.events())).toEqual([
      expect.objectContaining({ stage: 'submit', code: 'POLICY_DELEGATION_EXCEEDS', commandId: 'x1', approvalId: pending.approval.approvalId }),
      expect.objectContaining({ stage: 'submit', code: 'POLICY_CHANGE_INVALID', commandId: 'x2', approvalId: null }),
    ]);
    expect(JSON.stringify(f.events())).not.toContain('edit_file');
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] the approval card carries a bounded, redacted, human-readable diff instead of a hex digest', async () => {
    const f = await fixture(() => [], ownerRoot);
    const nasty = { schemaVersion: 1, changes: [{ kind: 'grant.add', grant: { ...readTool('share', f.me), resource: { kind: 'agent-tool', ids: ['read_file\u202ex\u009b1m'] } } },
      { kind: 'binding.remove', id: 'root' }] };
    const pending = await f.admin.submit(f.command('d1', nasty));
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    const { summary } = pending.approval;
    expect(summary.length).toBeLessThanOrEqual(2048);
    expect(summary).toContain('policy.administer@1 · 2 changes');
    expect(summary).toMatch(/\+ grant share: allow agent-tool\[read_file\?x\?1m\] actions\[invoke\] scopes\[s\] principals \[/);
    expect(summary).toMatch(/- binding root: roles\[installation-owner\] principals/);
    expect(/[\u009b\u202e]/.test(summary)).toBe(false);
    expect(f.journal.store.load('s', pending.approval.approvalId)!.request).toMatchObject({ summary });
    // Many long changes stay inside the bound and say how many were left out.
    const many = { schemaVersion: 1, changes: Array.from({ length: 32 }, (_, index) => ({ kind: 'grant.add', grant: { ...readTool(`g${index}`, f.me),
      resource: { kind: 'agent-tool', ids: Array.from({ length: 6 }, (_, at) => `tool_${index}_${'x'.repeat(40)}_${at}`) } } })) };
    const big = await f.admin.submit(f.command('d2', many));
    if (big.status !== 'approval-pending') throw new Error('pending expected');
    expect(big.approval.summary.length).toBeLessThanOrEqual(2048);
    // APPROVAL-SURFACE §B (B1 card): the binding line comes first, so the cut description can never push it off the card.
    expect(big.approval.summary).toMatch(/^policy\.administer@1 · authority-document\/installation · [0-9a-f]{12}\n/);
    expect(big.approval.summary).toMatch(/… \+\d+ more$/);
    expect(big.approval.summary).toContain('policy.administer@1 · 32 changes');
  });
});
