import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore,
  openSqliteInventoryReader, openSqliteLedger } from '#adapters/index.js';
import { encodeIdentityProfile, evaluatePolicy, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID,
  type AuditEvent } from '#domain/index.js';
import { ApprovalApplication, AuditApplication, IdentityProfileDistributionApplication, IdentityProfileRegistry, PolicyAdministrationApplication,
  type IdentityDistributionPreview, type IdentityDistributionSource } from '#engine/index.js';
import { createHmacIntegrity, sha256 } from '#platform/index.js';

const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of close.splice(0).reverse()) await clean(); });
async function fixture(owner = true, auditFailure = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-identity-distribution-')); close.push(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1000 }) }, sessions = await LocalOsSessionAuthority.create(['s'], 600000, clock);
  const { principal } = await sessions.verifySession(undefined), me = { issuer: principal.issuer, subject: principal.subject };
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'authority');
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p1', separationOfDuties: [], restrictions: [],
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(item => item.kind)) }],
    grants: [{ id: 'observe', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [me], resource: { kind: 'scope', ids: ['s'] } }] }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 3, revision: 'b1', modes: [], bindings: [{ id: 'root',
    roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all', principals: [owner ? me : { issuer: me.issuer, subject: 'other-owner' }] }] }), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 65536 });
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); close.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); close.push(() => journal.close());
  const auditStore = await openSqliteAuditStore(ledger, sqlite, 'forbid'); close.push(() => auditStore.close());
  const audit = new AuditApplication(auditStore, integrity), administration = new PolicyAdministrationApplication({ authority: source, policy: source,
    effects, approvals: journal.store, integrity, sessions, clock, requestTtlMs: 60000,
    audit: event => { if (auditFailure) throw new Error('audit unavailable'); audit.record(event); } });
  const member = { issuer: 'fixture-directory', subject: 'selected-member' };
  const catalog: IdentityDistributionSource = { async load() { return { companyId: 'default', principal, policy: await source.load(), projectScopeIds: ['s'],
    principals: [{ id: 'self', label: 'OS caller', kind: 'human', principal: me }, { id: 'member', label: 'Directory fixture member', kind: 'human', principal: member }] }; } };
  const registry = new IdentityProfileRegistry(), deps = { administration, effects };
  const app = new IdentityProfileDistributionApplication(registry, catalog, deps);
  const decide = async (pending: Awaited<ReturnType<typeof app.submit>>) => {
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    await new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source, integrity, clock, 'terminal', 10)
      .decide({ schemaVersion: 1, scopeId: 's', approvalId: pending.approval.approvalId, commandId: `decide-${pending.approval.approvalId}`,
        expectedRevision: pending.approval.revision, decision: 'allow', reason: 'Reviewed exact profile card' });
  };
  const approve = async (prepared: IdentityDistributionPreview, application = app) => {
    const pending = await application.submit(prepared.submission, prepared.digest);
    expect(pending.status).toBe('approval-pending'); await decide(pending); return pending;
  };
  const files = async () => ({ policy: await readFile(policyPath, 'utf8'), bindings: await readFile(bindingsPath, 'utf8') });
  const events = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event);
  } finally { db.close(); } };
  return { root, ledger, app, registry, source, catalog, principal, member, me, approve, decide, files, events, effects, journal, deps, policyPath, bindingsPath, archive };
}
const selection = (id = 'core:team') => ({ schemaVersion: 1, profile: { id, version: 1 }, scopeId: 's',
  assignments: [{ principalId: 'member', roleId: 'profile-reader', scopeIds: ['s'] }], removeBindingIds: [] });

describe.skipIf(process.platform !== 'linux')('identity profile distribution (real local session, temporary SQLite/authority)', () => {
  it.each(['core:solo', 'core:team', 'core:enterprise'])('previews and applies %s only after approving its exact card; audits and replays once', async id => {
    const f = await fixture(), before = await f.files(), prepared = await f.app.preview(selection(id));
    expect(prepared.preview.draft.grantsAuthority).toBe(false);
    expect(await f.files()).toEqual(before); expect(f.journal.store.list('s', null, 10)).toEqual([]);
    const pending = await f.app.submit(prepared.submission, prepared.digest);
    expect(pending.status).toBe('approval-pending'); expect(await f.files()).toEqual(before);
    await f.approve(prepared);
    const settled = await f.app.submit(prepared.submission, prepared.digest);
    expect(settled).toMatchObject({ status: 'settled', version: expect.stringMatching(/^a-[a-f0-9]{40}\+a-[a-f0-9]{40}$/) });
    const current = await f.source.load();
    expect(evaluatePolicy(current, { principal: { ...f.principal, ...f.member }, scopeId: 's', action: 'inspect', resource: { kind: 'run', id: 'run1' } }).decision).toBe('allow');
    const events = f.events().filter(event => event.subject.kind === 'authority-change');
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ principal: f.me, policyRevision: 'p1+b1',
      subject: { commandId: prepared.submission.command.commandId, decider: f.me, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), counts: { bindingsAdded: 1 } } });
    expect((await f.effects.loadEffect('s', prepared.submission.command.commandId))?.intent.command.input).toMatchObject({ schemaVersion: 2, profile: { id, digest: prepared.preview.draft.profile.digest } });
    expect((await readdir(f.archive)).filter(name => name.startsWith('k-'))).toHaveLength(1);
    const after = await f.files();
    const restarted = new IdentityProfileDistributionApplication(new IdentityProfileRegistry(), f.catalog, f.deps);
    expect(await restarted.submit(JSON.parse(JSON.stringify(prepared.submission)), prepared.digest)).toEqual(settled);
    expect(await f.files()).toEqual(after); expect(f.events().filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
    const reader = await openSqliteInventoryReader(f.ledger, { busyTimeoutMs: 1000 });
    try { expect((await reader.loadEffect('s', prepared.submission.command.commandId))?.state).toBe('settled'); } finally { reader.close(); }
  });
  it('uses an installed custom catalog definition through the same writer', async () => {
    const f = await fixture(), definition = { ...f.registry.resolve({ id: 'core:solo', version: 1 }).definition, id: 'acme:custom', labelKey: 'acme.custom' };
    const registry = new IdentityProfileRegistry([{ schemaVersion: 1, namespace: 'acme', source: 'fixture', definition,
      digest: sha256(encodeIdentityProfile(definition)), labels: { en: 'Custom', tr: 'Özel' } }]);
    const app = new IdentityProfileDistributionApplication(registry, f.catalog, f.deps), prepared = await app.preview(selection('acme:custom'));
    await f.approve(prepared, app);
    expect(await app.submit(prepared.submission, prepared.digest)).toMatchObject({ status: 'settled' });
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
  });
  it('refuses a stale expect after card approval; the exact effect and authority stay unchanged', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()); await f.approve(prepared);
    const before = await f.files();
    await expect(f.app.submit(prepared.submission, '0'.repeat(64))).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
    expect(await f.files()).toEqual(before); expect(await f.effects.loadEffect('s', prepared.submission.command.commandId)).toBeNull();
    expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
  });
  it('refuses a changed policy snapshot after approval without replacing the requested role with a safe alternative', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()); await f.approve(prepared);
    const file = JSON.parse((await f.files()).policy);
    await writeFile(f.policyPath, JSON.stringify({ ...file, revision: 'p2', restrictions: [{ id: 'block-share', actions: ['inspect'], scopes: ['s'], principals: [f.me], resource: { kind: 'run', ids: 'all' } }] }), { mode: 0o600 });
    const before = await f.files();
    await expect(f.app.submit(prepared.submission, prepared.digest)).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
    expect(await f.files()).toEqual(before); expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
  });
  it('refuses revision drift with unchanged authority after approving the exact card', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()); await f.approve(prepared);
    const file = JSON.parse((await f.files()).bindings);
    await writeFile(f.bindingsPath, JSON.stringify({ ...file, revision: 'b2' }), { mode: 0o600 });
    const before = await f.files();
    await expect(f.app.submit(prepared.submission, prepared.digest)).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
    expect(await f.files()).toEqual(before);
  });
  it('audit failure after approving the card refuses before publication', async () => {
    const f = await fixture(true, true), prepared = await f.app.preview(selection()), before = await f.files(); await f.approve(prepared);
    await expect(f.app.submit(prepared.submission, prepared.digest)).rejects.toMatchObject({ code: 'EFFECT_REJECTED' });
    expect(await f.files()).toEqual(before); expect(await f.effects.loadEffect('s', prepared.submission.command.commandId)).toMatchObject({ state: 'refused' });
  });
  it('refuses a non-admin and rejects handwritten principals, role permissions and personas', async () => {
    const f = await fixture(false), before = await f.files();
    await expect(f.app.preview(selection())).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
    for (const extra of [{ persona: 'admin' }, { principal: f.member }, { permissions: ['all'] }]) {
      await expect(f.app.preview({ ...selection(), ...extra })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_INVALID' });
    }
    expect(await f.files()).toEqual(before); expect(f.journal.store.list('s', null, 10)).toEqual([]);
  });
  it('refuses unknown principal or role choices, foreign scopes and removal of the last owner', async () => {
    const f = await fixture(), before = await f.files();
    for (const assignments of [[{ principalId: 'invented', roleId: 'profile-reader', scopeIds: ['s'] }],
      [{ principalId: 'member', roleId: INSTALLATION_OWNER_ROLE_ID, scopeIds: ['s'] }], [{ principalId: 'member', roleId: 'profile-reader', scopeIds: ['foreign'] }]]) {
      await expect(f.app.preview({ ...selection(), assignments })).rejects.toBeDefined();
    }
    await expect(f.app.preview({ ...selection(), assignments: [], removeBindingIds: ['root'] })).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_SCOPE_DENIED' });
    expect(await f.files()).toEqual(before);
  });
  it('rejects a modified exact command even with a recomputed outer digest after approval', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()); await f.approve(prepared);
    const tampered = { ...prepared.submission, command: { ...prepared.submission.command, expectedVersion: 'p2+b2' } };
    await expect(f.app.submit(tampered, sha256(encodeIdentityProfile(tampered)))).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
    expect(await f.effects.loadEffect('s', prepared.submission.command.commandId)).toBeNull();
  });
  it('the governed writer refuses last-owner removal even after approval of that exact v2 card', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()), before = await f.files();
    const change = prepared.submission.command.input as { schemaVersion: number; profile: unknown };
    const command = { ...prepared.submission.command, commandId: 'remove-last-owner', idempotencyKey: 'remove-last-owner',
      input: { ...change, changes: [{ kind: 'binding.remove', id: 'root' }] } };
    const pending = await f.deps.administration.submit(command); await f.decide(pending);
    await expect(f.deps.administration.submit(command)).rejects.toMatchObject({ code: 'POLICY_CHANGE_INVALID' });
    expect(await f.files()).toEqual(before); expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
    expect(f.events().filter(event => event.subject.kind === 'authority-refusal')).toHaveLength(1);
  });
  it('preserves an existing second-person rule; its exact pending card cannot be self-approved', async () => {
    const f = await fixture(), file = JSON.parse((await f.files()).policy);
    await writeFile(f.policyPath, JSON.stringify({ ...file, separationOfDuties: [{ id: 'two-people', rule: 'requester-cannot-approve', scopes: ['s'] }] }), { mode: 0o600 });
    const prepared = await f.app.preview(selection()), before = await f.files(), pending = await f.app.submit(prepared.submission, prepared.digest);
    expect(prepared.preview.draft.currentSeparationOfDuties).toHaveLength(1);
    await expect(f.decide(pending)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(await f.files()).toEqual(before); expect(f.events().filter(event => event.subject.kind === 'authority-change')).toEqual([]);
  });
  it('registry or selected-principal drift invalidates the reviewed envelope after its card was approved', async () => {
    const f = await fixture(), prepared = await f.app.preview(selection()); await f.approve(prepared);
    const definition = { ...f.registry.resolve({ id: 'core:solo', version: 1 }).definition, id: 'acme:extra', labelKey: 'acme.extra' };
    const registry = new IdentityProfileRegistry([{ schemaVersion: 1, namespace: 'acme', source: 'fixture', definition,
      digest: sha256(encodeIdentityProfile(definition)), labels: { en: 'Extra', tr: 'Ek' } }]);
    await expect(new IdentityProfileDistributionApplication(registry, f.catalog, f.deps).submit(prepared.submission, prepared.digest)).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
    const changed: IdentityDistributionSource = { async load(scopes) {
      const snapshot = await f.catalog.load(scopes);
      return { ...snapshot, principals: snapshot.principals.map(choice => choice.id === 'member' ? { ...choice, principal: { ...choice.principal, subject: 'different' } } : choice) };
    } };
    await expect(new IdentityProfileDistributionApplication(f.registry, changed, f.deps).submit(prepared.submission, prepared.digest)).rejects.toMatchObject({ code: 'IDENTITY_PREVIEW_CONFLICT' });
    expect(await f.effects.loadEffect('s', prepared.submission.command.commandId)).toBeNull();
  });
});
