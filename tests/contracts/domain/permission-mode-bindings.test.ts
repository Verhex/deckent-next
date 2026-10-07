import { describe, expect, it } from 'vitest';
import { bindingsFileSchema, permissionModeCommandSchema, permissionModeView, resolvePolicyBindings, upgradeBindingsDocument, withPrincipalPermissionMode } from '#domain/index.js';

// T-L4 slice 4c, MODES-3: the pure bindings change behind `/mode`. Only the caller's own entries (exact issuer + subject) change; every other
// person's entry and the role bindings stay as they were; the default `standart` without `askEdits` is the absence of an entry; an unchanged
// mode writes nothing; a v2 document's entries come back in their v3 form.
const me = { issuer: 'host', subject: '1000' }, other = { issuer: 'host', subject: '1001' }, sameSubject = { issuer: 'idp', subject: '1000' };
const principalOf = (who: typeof me) => ({ id: `os:${who.subject}`, ...who, assurance: 'os-user' as const, scopeIds: ['scope', 'elsewhere'] });
const roleBinding = { id: 'dev', principals: [me, other], roles: ['developer'], scopes: ['scope', 'other-scope'] };
const theirs = { id: 'their-mode', principal: other, scopes: ['scope'], mode: 'full-auto' as const };
const lookalike = { id: 'idp-mode', principal: sameSubject, scopes: ['scope'], mode: 'full-auto' as const };
const v3 = (modes: unknown[]) => bindingsFileSchema.parse({ schemaVersion: 3, revision: 'b1', bindings: [roleBinding], modes });
const v2 = (modes: unknown[]) => bindingsFileSchema.parse({ schemaVersion: 2, revision: 'b1', bindings: [roleBinding], modes });

describe('bindings v3 and the v2 migration (MODES-3)', () => {
  it('maps v2 ask → standart + askEdits, auto-edit → standart, full-auto → full-auto; keeps ids, principals, scopes and role bindings', () => {
    const upgraded = upgradeBindingsDocument(v2([{ id: 'a', principal: me, scopes: ['scope'], mode: 'ask' }, { id: 'b', principal: other, scopes: ['scope', 'x'], mode: 'auto-edit' },
      { id: 'c', principal: sameSubject, scopes: ['scope'], mode: 'full-auto' }]));
    expect(upgraded).toEqual({ schemaVersion: 3, revision: 'b1', bindings: [roleBinding], modes: [
      { id: 'a', principal: me, scopes: ['scope'], mode: 'standart', askEdits: true }, { id: 'b', principal: other, scopes: ['scope', 'x'], mode: 'standart' },
      { id: 'c', principal: sameSubject, scopes: ['scope'], mode: 'full-auto' }] });
    expect(upgradeBindingsDocument({ schemaVersion: 1, revision: 'b0', bindings: [] })).toEqual({ schemaVersion: 3, revision: 'b0', bindings: [], modes: [] });
    expect(upgradeBindingsDocument(upgraded)).toEqual(upgraded);
    expect(() => upgradeBindingsDocument({ schemaVersion: 4, revision: 'b', bindings: [], modes: [] })).toThrow();
  });

  it('refuses v2 names in v3 and v3 names in v2; askEdits is the literal true or absent', () => {
    for (const mode of ['ask', 'auto-edit', 'yolo']) expect(bindingsFileSchema.safeParse({ schemaVersion: 3, revision: 'b', bindings: [], modes: [{ ...theirs, mode }] }).success).toBe(false);
    for (const mode of ['standart', 'full-access']) expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [{ ...theirs, mode }] }).success).toBe(false);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 3, revision: 'b', bindings: [], modes: [{ ...theirs, askEdits: true }] }).success).toBe(true);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 3, revision: 'b', bindings: [], modes: [{ ...theirs, askEdits: false }] }).success).toBe(false);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 2, revision: 'b', bindings: [], modes: [{ ...theirs, askEdits: true }] }).success).toBe(false);
  });
});

describe('withPrincipalPermissionMode (T-L4 slice 4c, MODES-3)', () => {
  it('adds the caller\'s entry for the scope and leaves every other entry and the role bindings as they were', () => {
    const before = v3([theirs, lookalike]);
    const modes = withPrincipalPermissionMode(before, me, 'scope', 'full-auto', false, 'm-1');
    expect(modes).toEqual([theirs, lookalike, { id: 'm-1', principal: me, scopes: ['scope'], mode: 'full-auto' }]);
    // The same subject under another issuer is another person: never touched (exact issuer + subject).
    expect(modes!.filter(entry => entry.principal.subject === '1000' && entry.principal.issuer === 'idp')).toEqual([lookalike]);
    expect(bindingsFileSchema.safeParse({ schemaVersion: 3, revision: 'b2', bindings: before.bindings, modes }).success).toBe(true);
    // The person's "ask for edits too" preference is its own entry value, next to the mode.
    expect(withPrincipalPermissionMode(before, me, 'scope', 'standart', true, 'm-2')).toEqual([theirs, lookalike, { id: 'm-2', principal: me, scopes: ['scope'], mode: 'standart', askEdits: true }]);
  });

  it('moves the scope between the caller\'s entries, removes an emptied entry and clears it with the default standart', () => {
    const mine = { id: 'mine', principal: me, scopes: ['scope', 'other-scope'], mode: 'standart' as const, askEdits: true as const };
    const full = { id: 'full', principal: me, scopes: ['third'], mode: 'full-auto' as const };
    expect(withPrincipalPermissionMode(v3([mine, full, theirs]), me, 'scope', 'full-auto', false, 'm-x')).toEqual([
      { ...mine, scopes: ['other-scope'] }, { ...full, scopes: ['third', 'scope'] }, theirs]);
    expect(withPrincipalPermissionMode(v3([{ ...mine, scopes: ['scope'] }, theirs]), me, 'scope', 'standart', false, 'm-x')).toEqual([theirs]);
  });

  it('answers null when the mode and preference already are exactly the requested ones (nothing to write)', () => {
    expect(withPrincipalPermissionMode(v3([theirs]), me, 'scope', 'standart', false, 'm-1')).toBeNull();
    expect(withPrincipalPermissionMode(v3([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'full-auto' }]), me, 'scope', 'full-auto', false, 'm-1')).toBeNull();
    expect(withPrincipalPermissionMode(v3([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'full-auto' }]), me, 'scope', 'full-auto', true, 'm-1')).not.toBeNull();
    // v1 bindings have no modes: the default standart is already true.
    expect(withPrincipalPermissionMode(bindingsFileSchema.parse({ schemaVersion: 1, revision: 'b1', bindings: [] }), me, 'scope', 'standart', false, 'm-1')).toBeNull();
    // A v2 `ask` entry already is standart + askEdits (v3 form).
    expect(withPrincipalPermissionMode(v2([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'ask' }]), me, 'scope', 'standart', true, 'm-1')).toBeNull();
  });

  it('resolves an ambiguous pair (fail closed: every edit asks) into exactly one entry, and suffixes a clashing id', () => {
    const one = { id: 'm-1', principal: me, scopes: ['scope'], mode: 'standart' as const, askEdits: true as const };
    const two = { id: 'two', principal: me, scopes: ['scope'], mode: 'full-auto' as const };
    const modes = withPrincipalPermissionMode(v3([one, two, { id: 'm-1-2', principal: other, scopes: ['x'], mode: 'full-access' }]), me, 'scope', 'full-auto', false, 'm-1');
    expect(modes).toEqual([{ id: 'm-1-2', principal: other, scopes: ['x'], mode: 'full-access' }, { id: 'm-1', principal: me, scopes: ['scope'], mode: 'full-auto' }]);
    const fresh = withPrincipalPermissionMode(v3([{ id: 'm-1', principal: other, scopes: ['x'], mode: 'full-auto' }]), me, 'scope', 'full-auto', false, 'm-1');
    expect(fresh!.map(entry => entry.id)).toEqual(['m-1', 'm-1-2']);
  });

  it('reports the effective mode, preference, revision, eligibility and whether a grant allows full access', () => {
    const grant = { id: 'fa', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: [me], resource: { kind: 'permission-mode', ids: ['full-access'] } };
    const policy = { schemaVersion: 2, revision: 'p1', roles: [{ id: 'developer', permissions: [{ id: 'edit', effect: 'require-approval', actions: ['invoke'],
      resource: { kind: 'agent-tool', ids: ['edit_file'] }, modeEligible: true }] }], grants: [grant], restrictions: [], separationOfDuties: [] };
    const resolved = resolvePolicyBindings(policy, v3([{ id: 'mine', principal: me, scopes: ['scope'], mode: 'full-access', askEdits: true }]));
    expect(permissionModeView(resolved, principalOf(me), 'scope')).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'full-access', askEdits: true,
      revision: 'p1+b1', eligible: true, fullAccess: true, fullAuto: false });
    expect(permissionModeView(resolved, principalOf(me), 'elsewhere')).toMatchObject({ mode: 'standart', askEdits: false, eligible: false, fullAccess: false });
    expect(permissionModeView(resolved, principalOf(sameSubject), 'scope')).toMatchObject({ mode: 'standart', eligible: false, fullAccess: false });
    const v1 = resolvePolicyBindings({ schemaVersion: 1, revision: 'v1', grants: [], restrictions: [] }, null);
    expect(permissionModeView(v1, principalOf(me), 'scope')).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: false, mode: 'standart', askEdits: false,
      revision: 'v1', eligible: false, fullAccess: false, fullAuto: false });
    // T2 T-MODE-CYCLE: the full-auto set grant is reported the same way (the cycle leaves full-auto out without it); only an allow counts.
    const autoGrant = { ...grant, id: 'fa-auto', resource: { kind: 'permission-mode', ids: ['full-auto'] } };
    const withAuto = resolvePolicyBindings({ ...policy, grants: [grant, autoGrant] }, v3([]));
    expect(permissionModeView(withAuto, principalOf(me), 'scope')).toMatchObject({ fullAccess: true, fullAuto: true });
    const asking = resolvePolicyBindings({ ...policy, grants: [grant, { ...autoGrant, effect: 'require-approval' }] }, v3([]));
    expect(permissionModeView(asking, principalOf(me), 'scope')).toMatchObject({ fullAccess: true, fullAuto: false });
  });

  it('accepts only a catalog mode, an optional boolean askEdits and never a principal field in the command', () => {
    const command = { schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: 'p1+b1' };
    expect(permissionModeCommandSchema.safeParse(command).success).toBe(true);
    expect(permissionModeCommandSchema.safeParse({ ...command, askEdits: false }).success).toBe(true);
    for (const bad of [{ ...command, mode: 'yolo' }, { ...command, mode: 'auto-edit' }, { ...command, principal: other }, { ...command, askEdits: 'on' }]) {
      expect(permissionModeCommandSchema.safeParse(bad).success).toBe(false);
    }
  });
});
