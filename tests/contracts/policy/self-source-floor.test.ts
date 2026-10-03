import { describe, expect, it } from 'vitest';
import { auditEventSchema, resolvePolicyBindings, sessionPattern, standingCell, standingPattern } from '#domain/index.js';
import { agentCallPermissionMode, decideAgentToolCall, agentToolApprovalFacts, standingCallKey, standingApprovalAuditEvent } from '#engine/index.js';

const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope'] };
const CALL = { tool: 'edit_file', cell: 'edit-self-source', path: 'src/a.ts', command: null };
const KEY = 'v1:session:edit-self-source:edit_file:directory:src/*';
const policy = (mode: 'standart' | 'full-auto' | 'full-access', effect: 'allow' | 'require-approval' | 'deny', extra: unknown[] = []) => resolvePolicyBindings({ schemaVersion: 2, revision: 'p',
  roles: [], separationOfDuties: [], restrictions: [], grants: [{ id: 'edit', effect, actions: ['invoke'], scopes: ['scope'], principals: [me],
    resource: { kind: 'agent-tool', ids: ['edit_file'] }, ...(effect === 'require-approval' ? { modeEligible: true } : {}) },
  { id: 'write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: [me], resource: { kind: 'operation', ids: ['workspace.file.write'] } }, ...extra] },
{ schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'mode', principal: me, scopes: ['scope'], mode }] });
const decide = (snapshot: unknown, session = false) => decideAgentToolCall(snapshot, { principal, scopeId: 'scope', tool: { name: 'edit_file' },
  operation: { id: 'workspace.file.write' }, cell: 'edit-self-source', standing: { key: KEY, session } });
const standing = { id: 'standing-self-source', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool-call', ids: [KEY] } };

describe('SELF-SOURCE-FLOOR session and policy boundary', () => {
  it('has a session pattern that never becomes a remembered standing pattern or an ordinary edit key', () => {
    expect(standingCell(CALL.cell)).toBe(false);
    expect(standingPattern(CALL)).toEqual({ ok: false, reason: 'cell-not-standing' });
    expect(sessionPattern(CALL)).toMatchObject({ ok: true, pattern: { key: KEY, cell: CALL.cell, kind: 'directory', text: 'src/*' } });
    const ordinary = { ...CALL, cell: 'edit' };
    expect(sessionPattern(ordinary)).toEqual(standingPattern(ordinary));
    expect(standingCallKey(CALL)).toEqual({ key: KEY, cell: CALL.cell, session: false });
  });

  it('never offers a session or standing key for any static hard-floor target', () => {
    for (const path of ['package.json', '.deckent/config.json', '.agents/refactor/x.mjs', '.github/w.yml', 'AGENTS.md', 'src/package.json']) {
      const call = { ...CALL, path, cell: 'edit-floor' };
      expect(sessionPattern(call), path).toEqual({ ok: false, reason: 'cell-not-standing' });
      expect(standingPattern(call), path).toEqual({ ok: false, reason: 'cell-not-standing' });
      expect(standingCallKey(call), path).toBeNull();
    }
  });
  it('validates a self-source session target as narrowly as an ordinary edit target', () => {
    for (const path of ['../src/a', '/src/a', 'src//a', 'src/./a', 'src/*', 'src/../a', 'src/a\n']) {
      expect(sessionPattern({ ...CALL, path })).toEqual({ ok: false, reason: 'unsafe-target' });
    }
    expect(sessionPattern({ ...CALL, path: null })).toEqual({ ok: false, reason: 'no-target' });
    // A shell call's session answer names its whole command, with a separate cell-specific session key.
    expect(sessionPattern({ ...CALL, tool: 'run_shell', path: null, command: 'touch dist/a.js' })).toMatchObject({ ok: true,
      pattern: { key: 'v1:session:edit-self-source:run_shell:command:touch dist/a.js', kind: 'command' } });
  });

  it.each(['standart', 'full-auto'] as const)('raises allowed writes and never mode-lowers eligible self-source writes in %s', mode => {
    for (const effect of ['allow', 'require-approval'] as const) expect(decide(policy(mode, effect))).toEqual({ decision: 'require-approval', revision: 'p+b', relaxation: null });
  });

  it('uses only the session answer, never a matching persisted grant; a deny still wins', () => {
    for (const mode of ['standart', 'full-auto'] as const) for (const effect of ['allow', 'require-approval'] as const) {
      expect(decide(policy(mode, effect), true)).toEqual({ decision: 'allow', revision: 'p+b', relaxation: null, standing: { source: 'session', key: KEY, grantId: null } });
      expect(decide(policy(mode, effect, [standing])).decision).toBe('require-approval');
      expect(decide(policy(mode, effect, [standing]), true).standing?.source).toBe('session');
    }
    expect(decide(policy('full-auto', 'deny'), true).decision).toBe('deny');
  });

  it('keeps company refusal on the session key and unmarked company approval rules', () => {
    const companyAsk = { ...standing, id: 'company-ask', effect: 'require-approval' };
    expect(decide(policy('standart', 'allow', [companyAsk]), true).decision).toBe('require-approval');
    const base = policy('standart', 'require-approval');
    const unmarked = { ...base, grants: base.grants.map(grant => grant.id === 'edit' ? { ...grant, modeEligible: undefined } : grant) };
    expect(decide(unmarked, true).decision).toBe('require-approval');
  });

  it('preserves ordinary customer edits and exact full-access decisions; authority writes keep asking', () => {
    const base = policy('standart', 'allow');
    const access = { id: 'fa', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: [me], resource: { kind: 'permission-mode', ids: ['full-access'] } };
    const allowed = { ...base, grants: [...base.grants, access] };
    const request = { principal, scopeId: 'scope', tool: { name: 'edit_file' }, operation: { id: 'workspace.file.write' } };
    expect(decideAgentToolCall(base, { ...request, cell: 'edit' })).toEqual({ decision: 'allow', revision: 'p+b', relaxation: null });
    expect(decideAgentToolCall(allowed, { ...request, cell: 'edit', fullAccess: true })).toEqual({ decision: 'allow', revision: 'p+b', relaxation: null,
      fullAccess: { cell: 'edit', policy: 'allow', raised: false, company: null, grant: 'fa' } });
    for (const fullAccess of [false, true]) expect(decideAgentToolCall(allowed, { ...request, cell: 'edit-authority', fullAccess, standing: { key: KEY, session: true } }))
      .toEqual({ decision: 'require-approval', revision: 'p+b', relaxation: null });
  });

  it('carries the self-source cell through the existing sealed session audit and requires a turn-bound card', () => {
    const event = standingApprovalAuditEvent({ phase: 'remembered', scopeId: 'scope', turnId: 'turn', execution: { round: 1, index: 0 }, callId: 'call', principal: me,
      revision: 'p+b', atMs: 1000, standing: { source: 'session', key: KEY, grantId: null }, cell: 'edit-self-source', approvalId: 'approval',
      tool: { name: 'edit_file', version: 1 }, argsDigest: 'a'.repeat(64), summary: { kind: 'edit', path: 'src/a.ts' } });
    expect(auditEventSchema.safeParse(event).success).toBe(true);
    expect(event.subject).toMatchObject({ kind: 'standing-approval', source: 'session', cell: 'edit-self-source', grantId: null });
    expect(agentToolApprovalFacts(policy('standart', 'allow'), 'scope', 'edit-self-source')).toMatchObject({ requiredAssurance: 'turn-bound' });
  });
});

// A stored start mode cannot claim a launched full-access turn on a self-source card.
it('names the effective standart mode when full access was saved for a future launch', () => {
  expect(agentCallPermissionMode(policy('full-access', 'allow'), principal, 'scope')).toBe('standart');
  expect(agentCallPermissionMode(policy('full-auto', 'allow'), principal, 'scope')).toBe('full-auto');
});
