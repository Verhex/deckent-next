import { describe, expect, it } from 'vitest';
import { getPolicyVocabulary, policyChangeSchema, resolvePolicyBindings, standingCell, standingCovers, standingGrantChange, standingPattern, standingRevokeChange,
  STANDING_GRANT_KIND, STANDING_PATTERN_MAX_CHARS } from '#domain/index.js';
import { decideAgentToolCall, type AgentToolCallCell } from '#engine/index.js';

// PERSISTENT-APPROVALS G6: a standing approval (this session / persisted as the person's own grant) lowers only a persistable cell, only
// by an exact narrow pattern, and never a deny, the write floor, destructive shell or a fetch.
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope', 'other'] };
type Effect = 'allow' | 'deny' | 'require-approval';
const rule = (id: string, kind: string, ids: string[], effect: Effect, extra: Record<string, unknown> = {}, who: unknown = me, scopes: string[] = ['scope']) =>
  ({ id, effect, actions: kind === 'operation' ? ['execute'] : ['invoke'], scopes, principals: [who], resource: { kind, ids }, ...extra });
const policyOf = (grants: unknown[], restrictions: unknown[] = []) => resolvePolicyBindings(
  { schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions, grants }, { schemaVersion: 2, revision: 'b', bindings: [], modes: [] });
const KEY = 'v1:run_shell:command:npm test';
let seq = 0;
const standingGrant = (key = KEY, who: unknown = me, scopes = ['scope']) => rule(`standing-${++seq}`, STANDING_GRANT_KIND, [key], 'allow', {}, who, scopes);
const OPERATION: Record<string, string | null> = { shell: 'host.shell.run', edit: 'workspace.file.write' };
const decide = (policy: unknown, cell: AgentToolCallCell, standing: { key: string; session: boolean } | null, tool = 'run_shell') =>
  decideAgentToolCall(policy, { principal, scopeId: 'scope', tool: { name: tool }, operation: cell === 'read' ? null : cell.startsWith('fetch') ? { id: 'network.fetch' } : { id: OPERATION[cell.startsWith('shell') ? 'shell' : 'edit']! },
    cell, standing });
const allowAll = [rule('t-shell', 'agent-tool', ['run_shell'], 'allow'), rule('o-shell', 'operation', ['host.shell.run'], 'allow'),
  rule('t-edit', 'agent-tool', ['edit_file'], 'allow'), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'),
  rule('t-fetch', 'agent-tool', ['fetch_url'], 'allow'), rule('o-fetch', 'operation', ['network.fetch'], 'allow')];

describe('the standing pattern (generalization rule)', () => {
  it('is the whole command for shell, the directory plus /* for an edit, and nothing for any other cell', () => {
    expect(standingPattern({ tool: 'run_shell', cell: 'shell-narrow-mutating', path: null, command: 'npm test' })).toMatchObject({ ok: true, pattern: { key: KEY, kind: 'command', text: 'npm test' } });
    expect(standingPattern({ tool: 'run_shell', cell: 'shell-read-low', path: null, command: 'git log --oneline' })).toMatchObject({ ok: true, pattern: { key: 'v1:run_shell:command:git log --oneline' } });
    expect(standingPattern({ tool: 'edit_file', cell: 'edit', path: 'src/a/b.ts', command: null })).toMatchObject({ ok: true, pattern: { key: 'v1:edit_file:directory:src/a/*', kind: 'directory' } });
    expect(standingPattern({ tool: 'edit_file', cell: 'edit', path: 'README.md', command: null })).toMatchObject({ ok: true, pattern: { key: 'v1:edit_file:directory:./*' } });
    for (const cell of ['edit-floor', 'shell-destructive', 'shell-always-ask', 'shell-other-modify', 'fetch-listed', 'fetch-unlisted', 'read']) {
      expect(standingCell(cell)).toBe(false);
      expect(standingPattern({ tool: 'run_shell', cell, path: 'a/b', command: 'x' })).toEqual({ ok: false, reason: 'cell-not-standing' });
    }
  });

  it('refuses a target it cannot show whole and narrow: multi-line, control characters, traversal, absolute, glob characters, too long, missing', () => {
    const shell = (command: string | null) => standingPattern({ tool: 'run_shell', cell: 'shell-narrow-mutating', path: null, command });
    const edit = (path: string | null) => standingPattern({ tool: 'edit_file', cell: 'edit', path, command: null });
    expect(shell('a\nb')).toEqual({ ok: false, reason: 'unsafe-target' });
    expect(shell('a\u0007b')).toEqual({ ok: false, reason: 'unsafe-target' });
    expect(shell(' npm test')).toEqual({ ok: false, reason: 'unsafe-target' });
    expect(shell('x'.repeat(STANDING_PATTERN_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'pattern-too-long' });
    expect(shell(null)).toEqual({ ok: false, reason: 'no-target' });
    for (const path of ['../a', 'a/../b', '/etc/passwd', 'a//b', './a', 'a/*.ts', 'a/[x]/b', 'a\\b', 'a\n/b']) expect(edit(path)).toEqual({ ok: false, reason: 'unsafe-target' });
    expect(edit('a/'.repeat(STANDING_PATTERN_MAX_CHARS) + 'f')).toEqual({ ok: false, reason: 'pattern-too-long' });
    expect(edit(null)).toEqual({ ok: false, reason: 'no-target' });
  });

  it('covers by literal equality only (no glob is evaluated) and builds a change the policy administration accepts', () => {
    expect(standingCovers(KEY, KEY)).toBe(true);
    expect(standingCovers('v1:edit_file:directory:src/*', 'v1:edit_file:directory:src/a')).toBe(false);
    expect(standingCovers('v1:run_shell:command:npm *', 'v1:run_shell:command:npm test')).toBe(false);
    const change = standingGrantChange({ id: 'standing-abc', principal: me, scopeId: 'scope', key: KEY });
    expect(policyChangeSchema.safeParse(change).success).toBe(true);
    expect(change.changes[0]).toMatchObject({ kind: 'grant.add', grant: { effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: STANDING_GRANT_KIND, ids: [KEY] } } });
    expect(policyChangeSchema.safeParse(standingRevokeChange('standing-abc')).success).toBe(true);
    expect(getPolicyVocabulary().resources.map(resource => resource.kind)).toContain(STANDING_GRANT_KIND);
  });
});

describe('the call decision with a standing approval', () => {
  it('lowers the floor raise of a persistable cell for exactly the persisted pattern, for the person and scope it names', () => {
    const policy = policyOf([...allowAll, standingGrant()]);
    expect(decide(policy, 'shell-narrow-mutating', { key: KEY, session: false })).toMatchObject({ decision: 'allow', relaxation: null, standing: { source: 'grant', key: KEY } });
    expect(decide(policy, 'shell-read-low', { key: KEY, session: false })).toMatchObject({ decision: 'allow', standing: { source: 'grant' } });
    // another command, another person, another scope, no standing key: the floor raise stands.
    expect(decide(policy, 'shell-narrow-mutating', { key: 'v1:run_shell:command:npm run x', session: false })).toEqual({ decision: 'require-approval', revision: 'p+b', relaxation: null });
    expect(decide(policyOf([...allowAll, standingGrant(KEY, { issuer: 'host', subject: '2000' })]), 'shell-narrow-mutating', { key: KEY, session: false }).decision).toBe('require-approval');
    expect(decide(policyOf([...allowAll, standingGrant(KEY, me, ['other'])]), 'shell-narrow-mutating', { key: KEY, session: false }).decision).toBe('require-approval');
    expect(decide(policy, 'shell-narrow-mutating', null).decision).toBe('require-approval');
  });

  it('lowers an approval asked by an eligible company rule, and never one the company did not mark or denied', () => {
    const key = 'v1:edit_file:directory:src/*';
    const eligible = policyOf([rule('t-edit', 'agent-tool', ['edit_file'], 'require-approval', { modeEligible: true }), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'),
      standingGrant(key)]);
    expect(decide(eligible, 'edit', { key, session: false }, 'edit_file')).toMatchObject({ decision: 'allow', standing: { source: 'grant' } });
    const marked = (extra: Record<string, unknown>) => policyOf([rule('t-edit', 'agent-tool', ['edit_file'], 'require-approval', extra), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'), standingGrant(key)]);
    expect(decide(marked({}), 'edit', { key, session: false }, 'edit_file').decision).toBe('require-approval');
    // a deny (strict side) and a deny/require-approval on the standing key itself both beat the standing approval.
    const denied = policyOf([rule('t-edit', 'agent-tool', ['edit_file'], 'deny'), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'), standingGrant(key)]);
    expect(decide(denied, 'edit', { key, session: false }, 'edit_file').decision).toBe('deny');
        const askedCompany = policyOf([rule('t-edit', 'agent-tool', ['edit_file'], 'require-approval', { modeEligible: true }), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'),
      standingGrant(key), rule('company-ask', STANDING_GRANT_KIND, [key], 'require-approval')]);
    expect(decide(askedCompany, 'edit', { key, session: true }, 'edit_file').decision).toBe('require-approval');
    const restricted = policyOf([rule('t-edit', 'agent-tool', ['edit_file'], 'require-approval', { modeEligible: true }), rule('o-edit', 'operation', ['workspace.file.write'], 'allow'),
      standingGrant(key)], [{ id: 'no', actions: ['invoke'], scopes: ['scope'], principals: 'all', resource: { kind: STANDING_GRANT_KIND, ids: [key] } }]);
    expect(decide(restricted, 'edit', { key, session: true }, 'edit_file').decision).toBe('require-approval');
  });

  it('never lowers the write floor, destructive / always-ask / other-modify shell or a fetch, even with a matching grant and session memory', () => {
    const policy = policyOf([...allowAll, standingGrant('v1:run_shell:command:rm -rf x'), standingGrant('v1:edit_file:directory:.git/*')]);
    for (const [cell, tool] of [['shell-destructive', 'run_shell'], ['shell-always-ask', 'run_shell'], ['shell-other-modify', 'run_shell'], ['edit-floor', 'edit_file'],
      ['fetch-unlisted', 'fetch_url']] as const) {
      const result = decide(policy, cell, { key: 'v1:run_shell:command:rm -rf x', session: true }, tool);
      expect(result.decision).toBe('require-approval');
      expect(result.standing).toBeUndefined();
    }
  });

  it('a session memory lowers only when no rule names the key, and only a persistable cell', () => {
    const policy = policyOf(allowAll);
    expect(decide(policy, 'shell-narrow-mutating', { key: KEY, session: true })).toMatchObject({ decision: 'allow', standing: { source: 'session', key: KEY, grantId: null } });
    expect(decide(policy, 'shell-narrow-mutating', { key: KEY, session: false }).decision).toBe('require-approval');
    expect(decide(policy, 'shell-destructive', { key: KEY, session: true }).decision).toBe('require-approval');
  });

  it('only a person\'s own standing-* grant stands: a hand-written grant of the kind under another id, or one for everybody, does not', () => {
    for (const grant of [rule('company-grant', STANDING_GRANT_KIND, [KEY], 'allow'), { ...rule('standing-shared', STANDING_GRANT_KIND, [KEY], 'allow'), principals: 'all' }]) {
      expect(decide(policyOf([...allowAll, grant]), 'shell-narrow-mutating', { key: KEY, session: false }).decision).toBe('require-approval');
    }
  });

  it('a role\'s authority over the whole kind (the owner root) is authority to delegate, never a standing approval', () => {
    const owner = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', separationOfDuties: [], restrictions: [], grants: allowAll,
      roles: [{ id: 'owner', permissions: [{ id: 'all-calls', effect: 'allow', actions: 'all', resource: { kind: STANDING_GRANT_KIND, ids: 'all' } }] }] },
    { schemaVersion: 2, revision: 'b', bindings: [{ id: 'root', principals: [me], roles: ['owner'], scopes: 'all' }], modes: [] });
    expect(decide(owner, 'shell-narrow-mutating', { key: KEY, session: false }).decision).toBe('require-approval');
    expect(decide(owner, 'shell-narrow-mutating', { key: KEY, session: true })).toMatchObject({ decision: 'allow', standing: { source: 'session' } });
  });
});
