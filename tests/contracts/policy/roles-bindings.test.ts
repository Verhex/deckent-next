import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluatePolicy, policyDeclaredScopes, policyHasResourceRules, policyScopeGrants, policySchema, resolvePolicyBindings } from '#domain/index.js';
import { FilePolicySource } from '#adapters/index.js';
import { DispatchInventoryPolicyAuthorization, RunPolicyAuthorization, resolvePolicyScopeMembership, type ScopeRegistry } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { createLayoutPolicySource } from '../../../src/composition/core/policy/index.js';

// H34 S2: policy v2 roles (data) + a separate bindings resource (principal → roles, scope-bounded). v1 stays byte-identical.
const alice = { issuer: 'host', subject: '1000' }, bob = { issuer: 'host', subject: '1001' };
const principal = (who: { issuer: string; subject: string }, scopeIds = ['proj']) => ({ id: `${who.subject}@${who.issuer}`, ...who, assurance: 'os-user' as const, scopeIds });
const inspectRun = (who = alice, scopeId = 'proj') => ({ principal: principal(who, [scopeId]), scopeId, action: 'inspect', resource: { kind: 'run', id: 'run-1' } });
const role = (id: string, ...permissions: unknown[]) => ({ id, permissions });
const permission = (id: string, effect: string, actions: string[] | 'all', kind = 'run', ids: string[] | 'all' = 'all') => ({ id, effect, actions, resource: { kind, ids } });
const policyV2 = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 2, revision: 'p1', grants: [], restrictions: [], separationOfDuties: [],
  roles: [role('viewer', permission('inspect-runs', 'allow', ['inspect'])), role('auditor', permission('no-cancel', 'deny', ['inspect', 'cancel']))], ...extra });
const binding = (id: string, roles: string[], scopes: string[] | 'all' = ['proj'], principals = [alice]) => ({ id, principals, roles, scopes });
const bindings = (...entries: unknown[]) => ({ schemaVersion: 1, revision: 'b1', bindings: entries });
const effective = (policy: unknown = policyV2(), bound: unknown = bindings(binding('devs', ['viewer']))) => resolvePolicyBindings(policy, bound);

describe('policy v2 evaluation (domain)', () => {
  it('a bound principal gets exactly its role permissions at its bound scopes; the derived rule names binding/role/permission', () => {
    const decision = evaluatePolicy(effective(), inspectRun());
    expect(decision).toEqual({ decision: 'allow', revision: 'p1+b1', reason: 'GRANTED', ruleId: 'devs/viewer/inspect-runs' });
    expect(evaluatePolicy(effective(), { ...inspectRun(), action: 'cancel' }).reason).toBe('NO_GRANT');
    expect(evaluatePolicy(effective(), inspectRun(alice, 'other')).reason).toBe('NO_GRANT');
    expect(evaluatePolicy(effective(), { ...inspectRun(), resource: { kind: 'pool', id: 'run-1' } }).reason).toBe('NO_GRANT');
  });
  it('a principal without a binding is refused; principal matching is exact on issuer and subject', () => {
    expect(evaluatePolicy(effective(), inspectRun(bob)).reason).toBe('NO_GRANT');
    expect(evaluatePolicy(effective(), inspectRun({ issuer: 'other-host', subject: alice.subject })).reason).toBe('NO_GRANT');
    expect(evaluatePolicy(effective(), inspectRun({ issuer: alice.issuer, subject: '10000' })).reason).toBe('NO_GRANT');
    const group = effective(policyV2(), bindings(binding('devs', ['viewer'], ['proj'], [bob, alice])));
    expect(evaluatePolicy(group, inspectRun(bob)).decision).toBe('allow');
    expect(evaluatePolicy(group, inspectRun(alice)).decision).toBe('allow');
  });
  it('keeps v1 order over explicit and role rules: deny/restriction > require-approval > allow', () => {
    const explicitAllow = { id: 'explicit', effect: 'allow', actions: ['inspect'], scopes: 'all', principals: [alice], resource: { kind: 'run', ids: 'all' } };
    const denied = effective(policyV2({ grants: [explicitAllow] }), bindings(binding('audit', ['auditor'])));
    expect(evaluatePolicy(denied, inspectRun())).toMatchObject({ decision: 'deny', reason: 'DENIED', ruleId: 'audit/auditor/no-cancel' });
    const restricted = effective(policyV2({ restrictions: [{ id: 'freeze', actions: ['inspect'], scopes: 'all', principals: 'all', resource: { kind: 'run', ids: 'all' } }] }));
    expect(evaluatePolicy(restricted, inspectRun())).toMatchObject({ decision: 'deny', ruleId: 'freeze' });
    const gated = policyV2({ roles: [role('viewer', permission('inspect-runs', 'allow', ['inspect']), permission('gate', 'require-approval', ['inspect']))] });
    expect(evaluatePolicy(effective(gated), inspectRun())).toMatchObject({ decision: 'require-approval', ruleId: 'devs/viewer/gate' });
    const explicitDeny = effective(policyV2({ grants: [{ ...explicitAllow, id: 'no', effect: 'deny' }] }));
    expect(evaluatePolicy(explicitDeny, inspectRun())).toMatchObject({ decision: 'deny', ruleId: 'no' });
  });
  it('a binding naming an unknown role is a typed refusal of the whole authority, never a partial one', () => {
    expect(() => effective(policyV2(), bindings(binding('devs', ['viewer']), binding('ops', ['admin'])))).toThrow(expect.objectContaining({ code: 'POLICY_ROLE_UNKNOWN' }));
  });
  it('role is never a call parameter; bindings carry no wildcard principal; role/task permissions are refused until reserve sees them', () => {
    expect(() => evaluatePolicy(effective(), { ...inspectRun(), role: 'viewer' })).toThrow('POLICY_INVALID');
    expect(() => evaluatePolicy(effective(), { ...inspectRun(), principal: { ...principal(alice), role: 'viewer' } })).toThrow('POLICY_INVALID');
    expect(() => effective(policyV2(), bindings({ ...binding('devs', ['viewer']), principals: 'all' }))).toThrow();
    expect(() => effective(policyV2({ roles: [role('runner', permission('t', 'require-approval', ['execute'], 'task'))] }))).toThrow('POLICY_INVALID');
    expect(() => effective({ ...policyV2(), bindings: bindings() })).toThrow();
  });
  it('v1 documents are untouched; an effective document binds both revisions; v2 declares scopes only from explicit grants', () => {
    const v1 = { schemaVersion: 1, revision: 'r', restrictions: [], grants: [] };
    expect(resolvePolicyBindings(v1, null)).toEqual(v1);
    expect(policySchema.parse(effective()).revision).toBe('p1+b1');
    expect(() => resolvePolicyBindings(policyV2({ revision: 'x'.repeat(128) }), bindings())).toThrow();
    const named = { id: 'named', effect: 'allow', actions: ['inspect'], scopes: ['declared'], principals: [bob], resource: { kind: 'scope', ids: 'all' } };
    const document = effective(policyV2({ grants: [named] }), bindings(binding('devs', ['viewer'], ['bound-only'])));
    expect(policyDeclaredScopes(document)).toEqual(['declared']);
    expect(policyScopeGrants(document, alice, ['bound-only', 'declared'])).toEqual(['bound-only']);
    expect(policyHasResourceRules(document, 'task')).toBe(false); expect(policyHasResourceRules(document, 'run')).toBe(true);
    expect(policyHasResourceRules(v1, 'run')).toBe(false);
  });
});

describe('role membership through the S1 scope registry', () => {
  const registry = (pins: Record<string, string>): ScopeRegistry & { writes: string[][] } => {
    const writes: string[][] = [];
    return { writes, async pinnedCompanies(ids) { return new Map(Object.entries(pins).filter(([scope]) => ids.includes(scope))); },
      async pinDeclared(ids, company) { writes.push([...ids]); return new Map(ids.map(id => [id, company])); } };
  };
  it('a role binding makes a pinned scope a member; it never declares or pins a scope', async () => {
    const all = effective(policyV2({ roles: [role('scope-reader', permission('inspect-scope', 'allow', ['inspect'], 'scope'))] }), bindings(binding('devs', ['scope-reader'], 'all')));
    expect(await resolvePolicyScopeMembership(all, alice, ['proj'], 'default', registry({ proj: 'default' }))).toEqual(['proj']);
    await expect(resolvePolicyScopeMembership(all, bob, ['proj'], 'default', registry({ proj: 'default' }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(resolvePolicyScopeMembership(all, alice, ['proj'], 'acme', registry({ proj: 'default' }))).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    const named = effective(policyV2({ roles: [role('scope-reader', permission('inspect-scope', 'allow', ['inspect'], 'scope'))] }), bindings(binding('devs', ['scope-reader'], ['fresh'])));
    const fresh = registry({});
    await expect(resolvePolicyScopeMembership(named, alice, ['fresh'], 'default', fresh)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    expect(fresh.writes).toEqual([]);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function layoutFixture(policy: unknown, bound: unknown | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bindings-')); roots.push(root);
  const layout = resolveProductLayout({ projectRoot: root, root: join(root, '.deckent') });
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const policyPath = join(root, '.deckent', 'policy.json'), bindingsPath = join(root, '.deckent', 'bindings.json');
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  if (bound !== undefined) await writeFile(bindingsPath, typeof bound === 'string' ? bound : JSON.stringify(bound), { mode: 0o600 });
  return { root, layout, policyPath, bindingsPath, source: createLayoutPolicySource(layout, process.getuid!(), 4096) };
}
describe.skipIf(process.platform === 'win32')('bindings layout resource', () => {
  const runQuery = { scopeId: 'proj', runId: 'run-1' };
  it('v2 policy + bindings authorizes a real gate; v1 never reads the bindings resource', async () => {
    const f = await layoutFixture(policyV2(), bindings(binding('devs', ['viewer'])));
    const gate = new RunPolicyAuthorization(f.source);
    await expect(gate.authorize('inspect', runQuery, principal(alice))).resolves.toBeUndefined();
    await expect(gate.authorize('inspect', runQuery, principal(bob))).rejects.toThrow('POLICY_DENIED');
    await expect(gate.authorize('cancel', runQuery, principal(alice))).rejects.toThrow('POLICY_DENIED');
    expect((await f.source.load()).revision).toBe('p1+b1');
    const v1 = await layoutFixture({ schemaVersion: 1, revision: 'solo', restrictions: [], grants: [] }, '{ not json');
    await chmod(v1.bindingsPath, 0o666);
    expect((await v1.source.load()).revision).toBe('solo');
  });
  it('an unknown role, a missing, unsafe, oversized or substituted bindings file is a typed refusal; gates fail closed', async () => {
    const unknown = await layoutFixture(policyV2(), bindings(binding('devs', ['admin'])));
    await expect(unknown.source.load()).rejects.toMatchObject({ code: 'POLICY_ROLE_UNKNOWN' });
    await expect(new DispatchInventoryPolicyAuthorization(unknown.source).authorize('proj', principal(alice))).rejects.toThrow('POLICY_UNAVAILABLE');
    const missing = await layoutFixture(policyV2(), undefined);
    await expect(missing.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_MISSING', resource: 'bindings' });
    const f = await layoutFixture(policyV2(), bindings(binding('devs', ['viewer'])));
    await chmod(f.bindingsPath, 0o644); await expect(f.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_UNSAFE', resource: 'bindings' });
    await chmod(f.bindingsPath, 0o400); expect((await f.source.load()).revision).toBe('p1+b1');
    await expect(new FilePolicySource({ path: f.policyPath, bindingsPath: f.bindingsPath, ownerUid: process.getuid!() + 1, maxBytes: 4096 }).load())
      .rejects.toMatchObject({ code: 'POLICY_FILE_UNSAFE' });
    await link(f.bindingsPath, join(f.root, 'linked')); await expect(f.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_UNSAFE', resource: 'bindings' });
    await rm(join(f.root, 'linked'));
    await rename(f.bindingsPath, join(f.root, 'real')); await symlink(join(f.root, 'real'), f.bindingsPath);
    await expect(f.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_UNSAFE', resource: 'bindings' });
    await rm(f.bindingsPath); await writeFile(f.bindingsPath, JSON.stringify(bindings(binding('devs', ['viewer'], Array.from({ length: 500 }, (_, i) => `scope-${i}`)))), { mode: 0o600 });
    await expect(f.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_TOO_LARGE', resource: 'bindings' });
    await writeFile(f.bindingsPath, '{ private-invalid'); await expect(f.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_INVALID', resource: 'bindings' });
  });
  it('policy.json cannot carry bindings inline and a v2 policy without a bindings path is refused', async () => {
    const inline = await layoutFixture({ ...policyV2(), bindings: bindings(binding('devs', ['viewer'])) }, bindings(binding('devs', ['viewer'])));
    await expect(inline.source.load()).rejects.toMatchObject({ code: 'POLICY_FILE_INVALID', resource: 'policy' });
    const f = await layoutFixture(policyV2(), bindings(binding('devs', ['viewer'])));
    await expect(new FilePolicySource({ path: f.policyPath, ownerUid: process.getuid!(), maxBytes: 4096 }).load()).rejects.toMatchObject({ code: 'POLICY_FILE_MISSING', resource: 'bindings' });
  });
});
