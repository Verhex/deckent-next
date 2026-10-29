import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FilePolicySource } from '#adapters/core/file-policy/index.js';
import { firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_VERSION, evaluatePolicy, resolvePolicyBindings } from '#domain/core/policy/index.js';
import { verifiedPrincipalSchema } from '#domain/core/principal/index.js';
import { FIRST_RUN_TOOL_NAMES } from '#engine/core/installation/index.js';
import { validateAuthorityWrite, type AuthorityRevision } from '#engine/core/policy/index.js';
import { CORE_SYSTEM_POLICY_ROWS, bindSystemPolicyRows, loadSystemPolicyRows, planSystemPolicyRows, reconcileSystemPolicyRows,
  type SystemPolicyRowsStore, type ReconcileSystemPolicyRowsInput } from '#engine/core/system-policy-rows/index.js';

const person = { issuer: 'local', subject: 'owner' }, target = { scopeId: 'scope', person };
const caller = verifiedPrincipalSchema.parse({ id: 'owner', ...person, assurance: 'os-user', scopeIds: ['scope'] });
const seed = () => structuredClone(firstRunPolicyTemplate({ ...target, principal: person, ...FIRST_RUN_TOOL_NAMES }));
type Snapshot = { policy: unknown; bindings: unknown };
const clone = <T>(value: T): T => structuredClone(value);
function fixture(initial: Snapshot = seed()) {
  let snapshot = clone(initial), writes = 0, auditFails = false;
  const history: AuthorityRevision[] = [], journal = new Map<string, string>(), order: string[] = [];
  const update = vi.fn();
  const updateAuthority: SystemPolicyRowsStore['updateAuthority'] = async (work, key) => {
    update();
    const outcome = work(clone(snapshot));
    if (outcome.write) {
      validateAuthorityWrite(snapshot, outcome.write);
      outcome.write.beforePublish?.();
      const next = { policy: outcome.write.policy ?? snapshot.policy, bindings: outcome.write.bindings ?? snapshot.bindings };
      const before = resolvePolicyBindings(snapshot.policy, snapshot.bindings), after = resolvePolicyBindings(next.policy, next.bindings);
      order.push('archive+publish'); writes++; snapshot = clone(next);
      history.push({ key: key ?? null, before, after });
      if (key) journal.set(key, after.revision);
    }
    return outcome.result;
  };
  const store: SystemPolicyRowsStore = { updateAuthority, identity: () => 'fixture-authority',
    lookupAuthority: vi.fn(async key => journal.has(key) ? { status: 'applied' as const, version: journal.get(key)! } : { status: 'absent' as const }),
    authorityHistory: vi.fn(async () => history) };
  const audit = vi.fn(() => { if (auditFails) throw new Error('AUDIT_FAILED'); order.push('audit'); });
  const input = (extra: Partial<ReconcileSystemPolicyRowsInput> = {}): ReconcileSystemPolicyRowsInput => ({ owner: true, caller, target,
    expect: resolvePolicyBindings(snapshot.policy, snapshot.bindings).revision, apply: true, action: 'apply', audit, now: () => 100, ...extra });
  return { store, update, input, audit, order, history, get snapshot() { return clone(snapshot); }, get writes() { return writes; },
    failAudit: () => { auditFails = true; }, change: (work: (value: Snapshot) => Snapshot) => { snapshot = work(clone(snapshot)); } };
}
const plan = (snapshot: Snapshot, action: 'apply' | 'rollback' = 'apply', history: readonly AuthorityRevision[] = []) =>
  planSystemPolicyRows({ data: CORE_SYSTEM_POLICY_ROWS.data, target, snapshot, history, action });

it('fresh install and existing v18 upgrade share the same delta, audit and replay without a template bump', async () => {
  expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(18);
  for (const f of [fixture(), fixture(seed())]) {
    const before = f.snapshot, preview = await reconcileSystemPolicyRows(f.store, f.input({ apply: false }));
    expect(preview.status).toBe('preview'); expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled();
    const applied = await reconcileSystemPolicyRows(f.store, f.input());
    expect(applied.status).toBe('applied'); expect(f.writes).toBe(1); expect(f.order).toEqual(['audit', 'archive+publish']);
    expect(f.history[0]?.key).toBe(applied.key);
    const after = f.snapshot;
    expect((after.policy as { grants: unknown }).grants).toEqual((before.policy as { grants: unknown }).grants);
    expect(f.audit.mock.calls[0]).toBeDefined();
    expect(await reconcileSystemPolicyRows(f.store, f.input())).toMatchObject({ status: 'replayed' });
    expect(f.writes).toBe(1); expect(f.audit).toHaveBeenCalledTimes(1); expect(f.snapshot).toEqual(after);
    expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(18);
  }
});

it('strict registry rejects duplicates, unknown fields, forged bindings, ceiling bypass and wrong digests', () => {
  const data = clone(CORE_SYSTEM_POLICY_ROWS.data);
  expect(() => loadSystemPolicyRows(data, '0'.repeat(64))).toThrow('SYSTEM_POLICY_ROWS_DIGEST');
  for (const invalid of [{ ...data, roles: [...data.roles, data.roles[0]] }, { ...data, path: '/host' },
    { ...data, bindings: [{ ...data.bindings[0], actor: 'owner' }] },
    { ...data, roles: [{ id: 'beuser-evaluator', permissions: [{ id: 'decide', effect: 'allow', actions: ['decide'], resource: { kind: 'approval', ids: 'all' } }] }] }]) {
    expect(() => loadSystemPolicyRows(invalid)).toThrow();
  }
});

it('AI, forged os-user, wrong scope, unnamed person and tampered data cannot publish grants', async () => {
  for (const extra of [{ owner: false }, { caller: { ...caller, issuer: 'local/beuser-evaluator' } },
    { caller: { ...caller, scopeIds: ['foreign'] } }, { target: { ...target, person: { issuer: 'local/beuser-evaluator', subject: 'owner' } } },
    { data: { ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 } }]) {
    const f = fixture();
    expect(await reconcileSystemPolicyRows(f.store, f.input(extra))).toMatchObject({ status: 'unavailable' });
    expect(f.update).not.toHaveBeenCalled(); expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect(await reconcileSystemPolicyRows(f.store, f.input({ target: { ...target, person: { ...person, subject: 'unnamed' } } }))).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
  expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled();
});

it('hand-built policy denies and customizations survive; a conflicting system id is never overwritten', async () => {
  const f = fixture();
  const data = bindSystemPolicyRows(CORE_SYSTEM_POLICY_ROWS.data, target);
  f.change(value => ({ ...value, policy: { ...(value.policy as object), revision: 'hand-built', grants: [
    { id: 'named-admin', effect: 'allow', principals: [person], scopes: ['scope'], actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } },
    { id: 'deny-evaluator', effect: 'deny', principals: 'all', scopes: ['scope'], actions: ['evaluate'], resource: { kind: 'attempt', ids: 'all' } }] } }));
  const before = f.snapshot;
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('applied');
  expect((f.snapshot.policy as { grants: unknown }).grants).toEqual((before.policy as { grants: unknown }).grants);
  expect(evaluatePolicy(resolvePolicyBindings(f.snapshot.policy, f.snapshot.bindings), { principal: { ...caller, issuer: 'local/beuser-evaluator', assurance: 'workload-verified' }, scopeId: 'scope', action: 'evaluate', resource: { kind: 'attempt', id: 'own-attempt' } })).toMatchObject({ decision: 'deny', reason: 'DENIED' });
  const g = fixture();
  g.change(value => ({ ...value, policy: { ...(value.policy as object), roles: [{ ...data.roles[0], permissions: [{ id: 'custom', effect: 'allow', actions: ['inspect'], resource: { kind: 'run', ids: ['mine'] } }] }] } }));
  const custom = g.snapshot;
  expect((await reconcileSystemPolicyRows(g.store, g.input())).status).toBe('conflict');
  expect(g.snapshot).toEqual(custom); expect(g.writes).toBe(0); expect(g.audit).not.toHaveBeenCalled();
  const h = fixture();
  expect((await reconcileSystemPolicyRows(h.store, h.input())).status).toBe('applied');
  h.change(value => {
    const policy = value.policy as { roles: { permissions: unknown[] }[] };
    return { ...value, policy: { ...policy, revision: 'extra-custom-permission', roles: policy.roles.map(role => ({ ...role,
      permissions: [...role.permissions, { id: 'custom-extra', effect: 'allow', actions: ['inspect'], resource: { kind: 'run', ids: ['custom'] } }] })) } };
  });
  const customized = h.snapshot, laterData = { ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 };
  expect((await reconcileSystemPolicyRows(h.store, h.input({ data: laterData, expectedDigest: loadSystemPolicyRows(laterData).digest }))).status).toBe('conflict');
  expect(h.snapshot).toEqual(customized); expect(h.writes).toBe(1); expect(h.audit).toHaveBeenCalledTimes(1);
});

it('a removed package permission is not re-granted by replay or a later data revision', async () => {
  const f = fixture();
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('applied');
  f.change(value => {
    const policy = value.policy as { roles: { id: string; permissions: { id: string }[] }[] };
    return { ...value, policy: { ...policy, revision: 'manual-revocation', roles: policy.roles.map(role => ({ ...role, permissions: role.permissions.filter(permission => permission.id !== 'own-evaluation') })) } };
  });
  const revoked = f.snapshot;
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('replayed');
  expect(f.snapshot).toEqual(revoked);
  const data = { ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 }, pack = loadSystemPolicyRows(data);
  const later = await reconcileSystemPolicyRows(f.store, f.input({ data, expectedDigest: pack.digest }));
  expect(later.status).toBe('current'); expect(later.plan?.withheld.some(id => id.endsWith('/own-evaluation'))).toBe(true);
  expect(f.snapshot).toEqual(revoked); expect(f.writes).toBe(1);
});

it('rollback removes only its matching additions and preserves customized content and v18 grants', async () => {
  const f = fixture(), originalGrants = (f.snapshot.policy as { grants: unknown }).grants;
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('applied');
  f.change(value => {
    const policy = value.policy as { roles: { id: string; permissions: { id: string; resource: unknown }[] }[] };
    return { ...value, policy: { ...policy, revision: 'customized', roles: policy.roles.map(role => ({ ...role, permissions: role.permissions.map(permission =>
      permission.id === 'own-run' ? { ...permission, resource: { kind: 'run', ids: ['custom'] } } : permission) })) } };
  });
  const result = await reconcileSystemPolicyRows(f.store, f.input({ action: 'rollback' }));
  expect(result.status).toBe('rolled-back');
  const after = resolvePolicyBindings(f.snapshot.policy, f.snapshot.bindings);
  expect(after.grants).toEqual(originalGrants);
  if (after.schemaVersion !== 2) throw new Error('expected v2');
  expect(after.roles).toHaveLength(1); expect(after.roles[0]?.permissions).toEqual([expect.objectContaining({ id: 'own-run', resource: { kind: 'run', ids: ['custom'] } })]);
  expect(after.bindings.entries).toHaveLength(0);
  expect((await reconcileSystemPolicyRows(f.store, f.input({ action: 'rollback' }))).status).toBe('replayed');
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('replayed');
  expect(f.writes).toBe(2);
});

it('revision conflict, uncertain journal and failed audit produce no publication', async () => {
  const f = fixture();
  expect((await reconcileSystemPolicyRows(f.store, f.input({ expect: 'stale' }))).status).toBe('conflict');
  expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled();
  vi.mocked(f.store.lookupAuthority).mockResolvedValueOnce(null);
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('unknown');
  f.failAudit();
  await expect(reconcileSystemPolicyRows(f.store, f.input())).rejects.toThrow('AUDIT_FAILED');
  expect(f.writes).toBe(0); expect(f.history).toEqual([]);
});

it('a write arriving after preview is refused under the authority lock before audit or publication', async () => {
  const f = fixture(), original = f.store.updateAuthority;
  let count = 0;
  f.store.updateAuthority = async (work, key) => {
    if (++count === 2) f.change(value => ({ ...value, policy: { ...(value.policy as object), revision: 'concurrent' } }));
    return original(work, key);
  };
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('conflict');
  expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled(); expect(f.history).toEqual([]);
});

it('a revoked whole role and binding stay absent on the next data revision', async () => {
  const f = fixture();
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('applied');
  f.change(value => ({ policy: { ...(value.policy as object), revision: 'revoked-role', roles: [] },
    bindings: { ...(value.bindings as object), revision: 'revoked-binding', bindings: [] } }));
  const revoked = f.snapshot, data = { ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 };
  const result = await reconcileSystemPolicyRows(f.store, f.input({ data, expectedDigest: loadSystemPolicyRows(data).digest }));
  expect(result.status).toBe('current'); expect(result.plan?.withheld).toHaveLength(2);
  expect(f.snapshot).toEqual(revoked); expect(f.writes).toBe(1);
});

it('a partial policy-first publication cannot be completed blindly under a different data revision', async () => {
  const f = fixture(), bound = bindSystemPolicyRows(CORE_SYSTEM_POLICY_ROWS.data, target);
  f.change(value => ({ ...value, policy: { ...(value.policy as object), revision: 'partial-policy-first', roles: bound.roles } }));
  const partial = f.snapshot, data = { ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 };
  expect((await reconcileSystemPolicyRows(f.store, f.input({ data, expectedDigest: loadSystemPolicyRows(data).digest }))).status).toBe('conflict');
  expect(f.snapshot).toEqual(partial); expect(f.writes).toBe(0); expect(f.audit).not.toHaveBeenCalled();
});

it('scope-person binding has isolated ids and the pure preview never changes input', () => {
  const initial = seed(), saved = clone(initial);
  const planned = plan(initial);
  expect(planned.status).toBe('preview'); expect(initial).toEqual(saved);
  const mine = bindSystemPolicyRows(CORE_SYSTEM_POLICY_ROWS.data, target);
  const other = bindSystemPolicyRows(CORE_SYSTEM_POLICY_ROWS.data, { ...target, scopeId: 'other' });
  expect(mine.key).not.toBe(other.key); expect(mine.roles[0]?.id).not.toBe(other.roles[0]?.id);
});

it('the real guarded authority archive persists apply/replay/rollback custody with audit before publication', async () => {
  if (process.platform === 'win32') {
    expect(() => new FilePolicySource({ path: join(tmpdir(), 'unsupported'), ownerUid: 0, maxBytes: 1000000 })).toThrow('POLICY_FILE_UNSUPPORTED');
    console.info('verify-not-run: POSIX authority archive positive path on Windows'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'system-policy-rows-'));
  try {
    const initial = seed(), policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archivePath = join(root, 'archive');
    await writeFile(policyPath, JSON.stringify(initial.policy), { mode: 0o600 });
    await writeFile(bindingsPath, JSON.stringify(initial.bindings), { mode: 0o600 });
    const store = new FilePolicySource({ path: policyPath, bindingsPath, archivePath, ownerUid: userInfo().uid, maxBytes: 4000000 });
    const events: unknown[] = [], input = (expect: string, action: 'apply' | 'rollback' = 'apply'): ReconcileSystemPolicyRowsInput => ({ owner: true,
      caller, target, apply: true, action, expect, now: () => 100, audit: event => { expectBeforeAudit(); events.push(event); } });
    let preimage = await readFile(policyPath, 'utf8');
    const expectBeforeAudit = () => { expect(readFileSync(policyPath, 'utf8')).toBe(preimage); };
    const first = await reconcileSystemPolicyRows(store, input((await store.load()).revision));
    expect(first.status).toBe('applied'); expect(await readFile(policyPath, 'utf8')).not.toBe(preimage);
    expect(events).toHaveLength(1); expect(await store.lookupAuthority(first.key!)).toMatchObject({ status: 'applied' });
    expect((await reconcileSystemPolicyRows(store, input((await store.load()).revision))).status).toBe('replayed');
    expect(await readdir(archivePath)).toHaveLength(1);
    preimage = await readFile(policyPath, 'utf8');
    expect((await reconcileSystemPolicyRows(store, input((await store.load()).revision, 'rollback'))).status).toBe('rolled-back');
    expect(events).toHaveLength(2); expect(await readdir(archivePath)).toHaveLength(2);
    expect((await store.load()).grants).toEqual(initial.policy.grants);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('publishes a new data revision inside the witnessed upgrade plan and seals it before the single authority write', async () => {
  const f = fixture();
  expect((await reconcileSystemPolicyRows(f.store, f.input())).status).toBe('applied');
  const data = loadSystemPolicyRows({ ...CORE_SYSTEM_POLICY_ROWS.data, revision: 2 }).data;
  const input = { scopeId: target.scopeId, principal: person, toolNames: FIRST_RUN_TOOL_NAMES, owner: true, peopleLimit: 100,
    apply: false, now: () => 200, audit: f.audit, systemRows: { data, history: f.history, lookup: f.store.lookupAuthority } };
  const { upgradePolicyTemplate } = await import('#engine/core/installation/index.js');
  const preview = await upgradePolicyTemplate(f.store, input);
  expect(preview).toMatchObject({ status: 'preview', systemRows: { packageDigest: loadSystemPolicyRows(data).digest } });
  expect(f.writes).toBe(1);
  f.failAudit();
  await expect(upgradePolicyTemplate(f.store, { ...input, apply: true })).rejects.toThrow('AUDIT_FAILED');
  expect(f.writes).toBe(1);
  const g = fixture();
  expect((await reconcileSystemPolicyRows(g.store, g.input())).status).toBe('applied');
  g.change(value => {
    const policy = value.policy as { roles: { id: string; permissions: { id: string }[] }[] };
    return { ...value, policy: { ...policy, revision: 'revoked-before-upgrade', roles: policy.roles.map(role => ({ ...role, permissions: role.permissions.filter(permission => permission.id !== 'own-evaluation') })) } };
  });
  expect(await upgradePolicyTemplate(g.store, { ...input, apply: true, audit: g.audit, systemRows: { data, history: g.history, lookup: g.store.lookupAuthority } })).toMatchObject({ status: 'upgraded' });
  expect((g.snapshot.policy as { roles: { permissions: { id: string }[] }[] }).roles.flatMap(role => role.permissions).some(permission => permission.id === 'own-evaluation')).toBe(false);
  expect(g.history.at(-1)?.key).toBe(bindSystemPolicyRows(data, target).key);
  expect(g.order.slice(-3)).toEqual(['audit', 'audit', 'archive+publish']);
  expect(await upgradePolicyTemplate(g.store, { ...input, apply: true, audit: g.audit, systemRows: { data, history: g.history, lookup: g.store.lookupAuthority } })).toMatchObject({ status: 'current' });
  expect(g.writes).toBe(2);
});
