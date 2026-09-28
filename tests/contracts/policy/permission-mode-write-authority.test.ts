import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { AuditApplication, PermissionModeApplication } from '#engine/index.js';
import type { AuditEvent } from '#domain/index.js';
import { resolveProductLayout } from '#platform/index.js';

// Astra 2139 R1 and owner R4 (2026-09-27) on the real engine application, file policy source and sealed SQLite audit store.
// R1: the conditional write covers the policy that authorized it, not only the bindings file — a policy replaced after the audit record
// and before the rename is a typed conflict and nothing is written. R4: tightening one's own mode to `ask` needs no set grant; relaxing
// (`auto-edit`, `full-auto`) still does, and every decision is audited.
const actor = { issuer: 'host', subject: '1000' };
const principal = { ...actor, id: 'os:1000', assurance: 'os-user' as const, scopeIds: ['scope'] };
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
type Grant = Readonly<{ id: string; effect: 'allow' | 'deny' | 'require-approval'; modes: readonly string[] }>;
const policy = (revision: string, grants: readonly Grant[]) => ({ schemaVersion: 2, revision, roles: [], restrictions: [], separationOfDuties: [],
  grants: grants.map(grant => ({ id: grant.id, effect: grant.effect, actions: ['set'], scopes: ['scope'], principals: [actor],
    resource: { kind: 'permission-mode', ids: grant.modes } })) });
const mine = (mode: string) => ({ id: 'mine', principal: actor, scopes: ['scope'], mode });
const theirs = { id: 'theirs', principal: { issuer: 'host', subject: '2000' }, scopes: ['scope'], mode: 'full-auto' };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(grants: readonly Grant[], modes: readonly unknown[] = [], afterAudit: (root: string) => void = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mode-authority-'));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, 'ledger.db');
  openSqliteLedger(ledger, sqlite).close();
  const store = await openSqliteAuditStore(ledger, sqlite, 'forbid');
  closers.push(async () => { store.close(); });
  const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const audit = new AuditApplication(store, await openLocalIntegrityAuthority(resolveProductLayout({ projectRoot: root, root: data }), 'authority.key', true));
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json');
  await writeFile(policyPath, JSON.stringify(policy('p1', grants)), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [], modes }), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, ownerUid: process.getuid!(), maxBytes: 4096 });
  const app = new PermissionModeApplication(source, event => { audit.record(event); afterAudit(root); }, Date.now);
  const set = (mode: 'ask' | 'auto-edit' | 'full-auto', expectedRevision = 'p1+b1') => app.set(principal, { schemaVersion: 1, scopeId: 'scope', mode, expectedRevision })
    .then(result => ({ result }), (error: { code?: string; mode?: string }) => ({ code: error.code, ...(error.mode === undefined ? {} : { mode: error.mode }) }));
  const bindings = async () => JSON.parse(await readFile(bindingsPath, 'utf8')) as { revision: string; modes: unknown[] };
  const events = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event); }
    finally { db.close(); }
  };
  return { root, source, set, bindings, events, bindingsPath };
}

describe.skipIf(process.platform === 'win32')('permission mode write authority (Astra 2139 R1, owner R4)', () => {
  it('Astra 2137/2139 R1: a policy replaced after the audit record and before the final identity check invalidates the write', async () => {
    // Controlled external authority replacement after the audit record, before the adapter creates/writes its temporary file and
    // checks target identity (reviewer repro, astra-2137-policy-change.test.ts.txt): p1 allows full-auto, p2 denies it.
    const f = await fixture([{ id: 'set-mode', effect: 'allow', modes: ['full-auto'] }], [], root => {
      writeFileSync(join(root, 'new-policy'), JSON.stringify(policy('p2', [{ id: 'set-mode', effect: 'deny', modes: ['full-auto'] }])), { mode: 0o600 });
      renameSync(join(root, 'new-policy'), join(root, 'policy.json'));
    });
    const before = await readFile(f.bindingsPath, 'utf8');
    const outcome = await f.set('full-auto');
    expect(outcome).toEqual({ code: 'PERMISSION_MODE_CONFLICT' });
    expect(await readFile(f.bindingsPath, 'utf8')).toBe(before);
    expect((await f.bindings()).modes).toEqual([]);
    expect((await f.source.load()).revision).toBe('p2+b1');
    // No temporary file is left behind; the allow record stays as the documented unwritten intent.
    expect((await readdir(f.root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(f.events().map(event => event.subject)).toEqual([expect.objectContaining({ kind: 'permission-mode-change', requested: 'full-auto',
      decision: { effect: 'allow', ruleId: 'set-mode' } })]);
  });

  it('R4: tightening one\'s own mode to ask needs no set grant, keeps other people\'s entries and is audited as allowed without a rule', async () => {
    const f = await fixture([], [mine('full-auto'), theirs]);
    const outcome = await f.set('ask');
    expect(outcome).toMatchObject({ result: { mode: 'ask', previous: 'full-auto', changed: true } });
    const file = await f.bindings();
    expect(file.modes).toEqual([theirs]);
    expect(f.events().map(event => event.subject)).toEqual([{ kind: 'permission-mode-change', requested: 'ask', previous: 'full-auto',
      decision: { effect: 'allow', ruleId: null }, bindingsRevision: { before: 'b1', after: file.revision } }]);
  });

  it('R4: a company deny on set does not keep a person in a relaxed mode — ask is still allowed; relaxing stays refused', async () => {
    const f = await fixture([{ id: 'no-modes', effect: 'deny', modes: ['ask', 'auto-edit', 'full-auto'] }], [mine('auto-edit')]);
    expect(await f.set('ask')).toMatchObject({ result: { mode: 'ask', previous: 'auto-edit', changed: true } });
    const revision = `p1+${(await f.bindings()).revision}`;
    expect(await f.set('auto-edit', revision)).toEqual({ code: 'PERMISSION_MODE_DENIED', mode: 'auto-edit' });
    expect((await f.bindings()).modes).toEqual([]);
    expect(f.events().map(event => (event.subject as { decision: unknown }).decision)).toEqual([{ effect: 'allow', ruleId: null }, { effect: 'deny', ruleId: 'no-modes' }]);
  });

  it('R4: relaxing without a set grant is still POLICY_DENIED (and require-approval unsupported), audited, nothing written', async () => {
    const f = await fixture([]);
    const before = await readFile(f.bindingsPath, 'utf8');
    expect(await f.set('auto-edit')).toEqual({ code: 'PERMISSION_MODE_DENIED', mode: 'auto-edit' });
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED', mode: 'full-auto' });
    expect(await readFile(f.bindingsPath, 'utf8')).toBe(before);
    const g = await fixture([{ id: 'ask-first', effect: 'require-approval', modes: ['auto-edit'] }]);
    expect(await g.set('auto-edit')).toEqual({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(f.events().map(event => (event.subject as { decision: unknown }).decision)).toEqual([{ effect: 'deny', ruleId: null }, { effect: 'deny', ruleId: null }]);
  });

  it('R4: ask keeps the revision condition and audit-before-write — a stale revision conflicts, already-ask writes nothing', async () => {
    const f = await fixture([], [mine('full-auto')]);
    const before = await readFile(f.bindingsPath, 'utf8');
    expect(await f.set('ask', 'p0+b0')).toEqual({ code: 'PERMISSION_MODE_CONFLICT' });
    expect(await readFile(f.bindingsPath, 'utf8')).toBe(before);
    const g = await fixture([]);
    const unchanged = await readFile(g.bindingsPath, 'utf8');
    expect(await g.set('ask')).toMatchObject({ result: { mode: 'ask', previous: 'ask', changed: false } });
    expect(await readFile(g.bindingsPath, 'utf8')).toBe(unchanged);
    expect(g.events().map(event => event.subject)).toEqual([expect.objectContaining({ requested: 'ask', decision: { effect: 'allow', ruleId: null },
      bindingsRevision: { before: 'b1', after: null } })]);
    // No record, no change: an unrecordable ask is not applied either.
    const h = await fixture([], [mine('full-auto')]);
    const kept = await readFile(h.bindingsPath, 'utf8');
    const refusing = new PermissionModeApplication(h.source, () => { throw Object.assign(new Error('AUDIT_UNAVAILABLE'), { code: 'AUDIT_UNAVAILABLE' }); }, Date.now);
    await expect(refusing.set(principal, { schemaVersion: 1, scopeId: 'scope', mode: 'ask', expectedRevision: 'p1+b1' })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await readFile(h.bindingsPath, 'utf8')).toBe(kept);
  });
});
