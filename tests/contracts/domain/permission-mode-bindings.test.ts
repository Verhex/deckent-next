import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, permissionModeCommandSchema, permissionModeView, resolvePolicyBindings, withPrincipalPermissionMode } from '#domain/index.js';

// T-L4 slice 4c: the pure bindings change behind `/mode`. Only the caller's own entries (exact issuer + subject) change; every other
// person's entry and the role bindings stay as they were; `ask` is the absence of an entry; an unchanged mode writes nothing.
const me = { issuer: 'host', subject: '1000' }, other = { issuer: 'host', subject: '1001' }, sameSubject = { issuer: 'idp', subject: '1000' };
const roleBinding = { id: 'dev', principals: [me, other], roles: ['developer'], scopes: ['scope', 'other-scope'] };
const theirs = { id: 'their-mode', principal: other, scopes: ['scope'], mode: 'full-auto' as const };
const lookalike = { id: 'idp-mode', principal: sameSubject, scopes: ['scope'], mode: 'auto-edit' as const };
const v2 = (modes: unknown[]) => bindingsFileSchema.parse({ schemaVersion: 2, revision: 'b1', bindings: [roleBinding], modes });

describe('withPrincipalPermissionMode (T-L4 slice 4c)', () => {
  it('adds the caller\'s entry for the scope and leaves every other entry and the role bindings as they were', () => {
    const before = v2([theirs, lookalike]);
    const modes = withPrincipalPermissionMode(before, me, 'scope', 'auto-edit', 'm-1');
    expect(modes).toEqual([theirs, lookalike, { id: 'm-1', principal: me, scopes: ['scope'], mode: 'auto-edit' }]);
    // The same subject under another issuer is another person: never touched (exact issuer + subject).
    expect(modes!.filter(entry => entry.principal.subject === '1000' && entry.principal.issuer === 'idp')).toEqual([lookalike]);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b2', bindings: before.bindings, modes }).success).toBe(true);
  });

  it('moves the scope between the caller\'s entries, removes an emptied entry and clears it with ask', () => {
    const mine = { id: 'mine', principal: me, scopes: ['scope', 'other-scope'], mode: 'auto-edit' as const };
    const full = { id: 'full', principal: me, scopes: ['third'], mode: 'full-auto' as const };
    expect(withPrincipalPermissionMode(v2([mine, full, theirs]), me, 'scope', 'full-auto', 'm-x')).toEqual([
      { ...mine, scopes: ['other-scope'] }, { ...full, scopes: ['third', 'scope'] }, theirs]);
    expect(withPrincipalPermissionMode(v2([{ ...mine, scopes: ['scope'] }, theirs]), me, 'scope', 'ask', 'm-x')).toEqual([theirs]);
  });

  it('answers null when the mode already is exactly the requested one (nothing to write)', () => {
    expect(withPrincipalPermissionMode(v2([theirs]), me, 'scope', 'ask', 'm-1')).toBeNull();
    expect(withPrincipalPermissionMode(v2([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'auto-edit' }]), me, 'scope', 'auto-edit', 'm-1')).toBeNull();
    // v1 bindings have no modes: ask is already true.
    expect(withPrincipalPermissionMode(bindingsFileSchema.parse({ schemaVersion: 1, revision: 'b1', bindings: [] }), me, 'scope', 'ask', 'm-1')).toBeNull();
  });

  it('resolves an ambiguous pair (fail-closed ask) into exactly one entry, and suffixes a clashing id', () => {
    const one = { id: 'm-1', principal: me, scopes: ['scope'], mode: 'auto-edit' as const };
    const two = { id: 'two', principal: me, scopes: ['scope'], mode: 'full-auto' as const };
    const modes = withPrincipalPermissionMode(v2([one, two, { id: 'm-1-2', principal: other, scopes: ['x'], mode: 'ask' }]), me, 'scope', 'full-auto', 'm-1');
    expect(modes).toEqual([{ id: 'm-1-2', principal: other, scopes: ['x'], mode: 'ask' }, { id: 'm-1', principal: me, scopes: ['scope'], mode: 'full-auto' }]);
    const fresh = withPrincipalPermissionMode(v2([{ id: 'm-1', principal: other, scopes: ['x'], mode: 'ask' }]), me, 'scope', 'auto-edit', 'm-1');
    expect(fresh!.map(entry => entry.id)).toEqual(['m-1', 'm-1-2']);
  });

  it('reports the effective mode, revision and eligibility of one person in one scope', () => {
    const policy = { schemaVersion: 2, revision: 'p1', roles: [{ id: 'developer', permissions: [{ id: 'edit', effect: 'require-approval', actions: ['invoke'],
      resource: { kind: 'agent-tool', ids: ['edit_file'] }, modeEligible: true }] }], grants: [], restrictions: [], separationOfDuties: [] };
    const resolved = resolvePolicyBindings(policy, v2([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'auto-edit' }]));
    expect(permissionModeView(resolved, me, 'scope')).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'auto-edit', revision: 'p1+b1', eligible: true });
    expect(permissionModeView(resolved, me, 'elsewhere')).toMatchObject({ mode: 'ask', eligible: false });
    expect(permissionModeView(resolved, sameSubject, 'scope')).toMatchObject({ mode: 'ask', eligible: false });
    const v1 = resolvePolicyBindings({ schemaVersion: 1, revision: 'v1', grants: [], restrictions: [] }, null);
    expect(permissionModeView(v1, me, 'scope')).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: false, mode: 'ask', revision: 'v1', eligible: false });
  });

  it('accepts only a catalog mode and never a principal field in the command', () => {
    const command = { schemaVersion: 1, scopeId: 'scope', mode: 'auto-edit', expectedRevision: 'p1+b1' };
    expect(permissionModeCommandSchema.safeParse(command).success).toBe(true);
    expect(permissionModeCommandSchema.safeParse({ ...command, mode: 'yolo' }).success).toBe(false);
    expect(permissionModeCommandSchema.safeParse({ ...command, principal: other }).success).toBe(false);
  });
});
