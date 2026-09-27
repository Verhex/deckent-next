import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { closeModeRuntimes, me, modeRuntime, rule } from '../support/agent-turn-modes.js';

// T-L4 slice 4c on the real runtime service: a person reads and sets their own permission mode through two v15 operations. The service
// replaces bindings.json atomically (temp + rename, conditional on the revision the caller read), only the caller's own entries change,
// the change needs a company `permission-mode`/`set` grant and is audited before it is applied; the next turn uses the new mode.
afterEach(closeModeRuntimes);
const other = { issuer: 'another-host', subject: '4242' };
const theirs = { id: 'their-mode', principal: other, scopes: ['scope'], mode: 'full-auto' };
const lookalike = { id: 'lookalike', principal: { issuer: 'idp', subject: me[0]!.subject }, scopes: ['scope'], mode: 'full-auto' };
const roleBinding = { id: 'readers', principals: [me[0], other], roles: ['reader'], scopes: ['scope'] };
const editEligible = [rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], 'require-approval', true), rule('file-write', 'operation', ['workspace.file.write'], 'allow')];
const setGrant = (effect: 'allow' | 'require-approval' = 'allow') => rule('mode-set', 'permission-mode', ['ask', 'auto-edit', 'full-auto'], effect, false, ['set']);
type Runtime = Awaited<ReturnType<typeof modeRuntime>>;

async function authority(f: Runtime, grants: Record<string, unknown>[], version: 1 | 2 = 2) {
  const base = await readFile(join(f.data, 'policy.json'), 'utf8').then(text => JSON.parse(text) as { grants: Record<string, unknown>[] });
  const kept = base.grants.filter(grant => ['invoke', 'scope', 'decide'].includes(String(grant['id'])));
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(version === 2
    ? { schemaVersion: 2, revision: 'p1', roles: [{ id: 'reader', permissions: [{ id: 'read', effect: 'allow', actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['read_file'] } }] }],
      separationOfDuties: [], restrictions: [], grants: [...kept, ...grants] }
    : { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [...kept, ...grants] }), { mode: 0o600 });
  await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [roleBinding], modes: [theirs, lookalike] }), { mode: 0o600 });
}
const client = (f: Runtime) => createConfiguredRuntimeClient(f.project, { env: { HOME: join(f.project, '..', 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' } });
const bindings = async (f: Runtime) => JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { revision: string; bindings: unknown[]; modes: unknown[] };
const changes = (f: Runtime) => f.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'permission-mode-change');

describe.skipIf(process.platform !== 'linux')('permission mode read and write through the runtime service (T-L4 slice 4c)', () => {
  it('sets the caller\'s own mode atomically, keeps every other entry, audits the decision and lowers the next turn', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, [...editEligible, setGrant()]);
    const runtime = client(f);
    const before = await stat(join(f.data, 'bindings.json'), { bigint: true });
    const shown = await runtime.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' });
    expect(shown).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'ask', revision: 'p1+b1', eligible: true });
    const changed = await runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'auto-edit', expectedRevision: shown.revision });
    expect(changed).toMatchObject({ scopeId: 'scope', supported: true, mode: 'auto-edit', previous: 'ask', changed: true, eligible: true });
    expect(changed.revision).toMatch(/^p1\+m-[0-9a-f]{40}$/u);
    // Replaced, not rewritten in place: a new inode, the same owner and mode; every other entry and the role bindings are unchanged.
    const after = await stat(join(f.data, 'bindings.json'), { bigint: true });
    expect(after.ino).not.toBe(before.ino);
    expect({ uid: after.uid, mode: after.mode & 0o777n }).toEqual({ uid: before.uid, mode: 0o600n });
    const file = await bindings(f);
    expect(file).toEqual({ schemaVersion: 2, revision: changed.revision.slice(3), bindings: [roleBinding],
      modes: [theirs, lookalike, { id: expect.stringMatching(/^m-[0-9a-f]{16}$/u), principal: me[0], scopes: ['scope'], mode: 'auto-edit' }] });
    expect(await runtime.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' })).toMatchObject({ mode: 'auto-edit', revision: changed.revision });
    expect(changes(f)).toEqual([{ kind: 'permission-mode-change', requested: 'auto-edit', previous: 'ask', decision: { effect: 'allow', ruleId: 'mode-set' },
      bindingsRevision: { before: 'b1', after: file.revision } }]);
    expect(f.audit()[0]!.event).toMatchObject({ principal: me[0], scopeId: 'scope', policyRevision: 'p1+b1' });
    // The next turn decides on the new mode: the eligible ordinary edit runs without a card and writes its own audit event.
    const turn = await f.call('edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' });
    expect(turn).toMatchObject({ card: false, status: 'ok' });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(f.audit().map(record => record.event.subject['kind'])).toEqual(['permission-mode-change', 'permission-mode']);
    expect(f.audit()[1]!.event).toMatchObject({ policyRevision: changed.revision, subject: { mode: 'auto-edit', grants: { company: 'edit-tools', person: (file.modes[2] as { id: string }).id } } });
    // Back to ask: the caller's entry is removed; the others still stand as they were.
    const cleared = await runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'ask', expectedRevision: changed.revision });
    expect(cleared).toMatchObject({ mode: 'ask', previous: 'auto-edit', changed: true });
    expect((await bindings(f)).modes).toEqual([theirs, lookalike]);
  }, 90_000);

  it('refuses without a set grant, and on a require-approval grant, with a typed refusal: the file stays byte-identical and the refusal is audited', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, editEligible);
    const runtime = client(f), text = await readFile(join(f.data, 'bindings.json'), 'utf8');
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: 'p1+b1' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await authority(f, [...editEligible, setGrant('require-approval')]);
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: 'p1+b1' })).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(text);
    expect(changes(f)).toEqual([
      { kind: 'permission-mode-change', requested: 'full-auto', previous: 'ask', decision: { effect: 'deny', ruleId: null }, bindingsRevision: { before: 'b1', after: null } },
      { kind: 'permission-mode-change', requested: 'full-auto', previous: 'ask', decision: { effect: 'require-approval', ruleId: 'mode-set' }, bindingsRevision: { before: 'b1', after: null } }]);
    // The person's mode is still ask: an eligible edit asks.
    expect(await f.call('edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' })).toMatchObject({ card: true, status: 'denied' });
  }, 90_000);

  it('lets a person tighten their own mode to ask without any set grant (owner R4), audited as allowed without a rule', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, editEligible);
    await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [roleBinding],
      modes: [theirs, lookalike, { id: 'mine', principal: me[0], scopes: ['scope'], mode: 'auto-edit' }] }), { mode: 0o600 });
    const runtime = client(f);
    expect(await runtime.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' })).toMatchObject({ mode: 'auto-edit', revision: 'p1+b1' });
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: 'p1+b1' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const cleared = await runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'ask', expectedRevision: 'p1+b1' });
    expect(cleared).toMatchObject({ mode: 'ask', previous: 'auto-edit', changed: true });
    const file = await bindings(f);
    expect(file.modes).toEqual([theirs, lookalike]);
    expect(changes(f)).toEqual([
      { kind: 'permission-mode-change', requested: 'full-auto', previous: 'auto-edit', decision: { effect: 'deny', ruleId: null }, bindingsRevision: { before: 'b1', after: null } },
      { kind: 'permission-mode-change', requested: 'ask', previous: 'auto-edit', decision: { effect: 'allow', ruleId: null }, bindingsRevision: { before: 'b1', after: file.revision } }]);
    // The next turn is back to asking: an eligible edit shows a card again.
    expect(await f.call('edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' })).toMatchObject({ card: true, status: 'denied' });
  }, 90_000);

  it('answers a typed conflict for a stale revision and for one of two concurrent writes; exactly one write lands', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, [...editEligible, setGrant()]);
    const runtime = client(f), text = await readFile(join(f.data, 'bindings.json'), 'utf8');
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'auto-edit', expectedRevision: 'p0+b0' })).rejects.toMatchObject({ code: 'PERMISSION_MODE_CONFLICT' });
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(text);
    const results = await Promise.allSettled((['auto-edit', 'full-auto'] as const).map(mode =>
      runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode, expectedRevision: 'p1+b1' })));
    const won = results.filter(result => result.status === 'fulfilled'), lost = results.filter(result => result.status === 'rejected');
    expect({ won: won.length, lost: lost.map(result => (result as PromiseRejectedResult).reason?.code) }).toEqual({ won: 1, lost: ['PERMISSION_MODE_CONFLICT'] });
    const winner = (won[0] as PromiseFulfilledResult<{ mode: string; revision: string }>).value;
    const file = await bindings(f);
    expect(`p1+${file.revision}`).toBe(winner.revision);
    expect(file.modes.filter(entry => (entry as { principal: { subject: string; issuer: string } }).principal.issuer === me[0]!.issuer)).toEqual([
      expect.objectContaining({ mode: winner.mode, scopes: ['scope'] })]);
  }, 90_000);

  it('keeps a read-only (0400) bindings file read-only and refuses modes on a v1 policy without touching any file', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, [...editEligible, setGrant()]);
    await chmod(join(f.data, 'bindings.json'), 0o400);
    const runtime = client(f);
    await runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: 'p1+b1' });
    expect((await stat(join(f.data, 'bindings.json'))).mode & 0o777).toBe(0o400);
    await chmod(join(f.data, 'bindings.json'), 0o600);
    await authority(f, [setGrant()], 1);
    const text = await readFile(join(f.data, 'bindings.json'), 'utf8');
    expect(await runtime.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' })).toEqual({ schemaVersion: 1, scopeId: 'scope', supported: false, mode: 'ask', revision: 'p1', eligible: false });
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'auto-edit', expectedRevision: 'p1' })).rejects.toMatchObject({ code: 'PERMISSION_MODE_UNSUPPORTED' });
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(text);
  }, 90_000);

  it('applies nothing when the decision cannot be audited', async () => {
    const f = await modeRuntime({ grants: [], mode: null });
    await authority(f, [...editEligible, setGrant()]);
    const runtime = client(f), text = await readFile(join(f.data, 'bindings.json'), 'utf8');
    f.exec("CREATE TRIGGER audit_refuses BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    await expect(runtime.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'auto-edit', expectedRevision: 'p1+b1' })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(text);
    expect(await runtime.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' })).toMatchObject({ mode: 'ask', revision: 'p1+b1' });
  }, 90_000);
});
