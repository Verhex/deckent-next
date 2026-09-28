import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectError, resolvePolicyBindings, type AgentToolSpec } from '#domain/index.js';
import type { EffectApprovalGate } from '#engine/index.js';
import { resolveProductLayout, SystemTrustedClock } from '#platform/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createAgentCallDecisions } from '#composition/core/agent-turn/index.js';

// T-L4 slice 4a: the turn's permission decision is taken again at the effect on the policy as it is then. A relaxation writes its audit
// event before the effect runs; the effect gate re-decides on every admission, so a deny or a lost relaxation since stops the effect.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const me = { issuer: 'host', subject: '1000' };
const principal = { id: 'os:1000', ...me, assurance: 'os-user' as const, scopeIds: ['scope'] };
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const edit: AgentToolSpec = { name: 'edit_file', version: 1, toolClass: 'edit', description: 'edit', inputSchema: { type: 'object' } } as AgentToolSpec;
const args = { path: 'src/a.ts', old_string: 'a', new_string: 'b' };
type Effect = 'allow' | 'deny' | 'require-approval';
const snapshot = (tool: Effect, mode: string | null, revision = `p-${tool}-${mode}`, toolGrant = 'edit-tool', modeEntry = 'me-mode') => resolvePolicyBindings({ schemaVersion: 2, revision, roles: [], separationOfDuties: [], restrictions: [],
  grants: [{ id: toolGrant, effect: tool, actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool', ids: ['edit_file'] },
    ...(tool === 'require-approval' ? { modeEligible: true } : {}) },
  { id: 'file-write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: [me], resource: { kind: 'operation', ids: ['workspace.file.write'] } }] },
mode === null ? { schemaVersion: 1, revision: 'b', bindings: [] } : { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: modeEntry, principal: me, scopes: ['scope'], mode }] });

/** `loads[i]` is what the i-th policy load returns (the last one repeats): authorize loads once, execute once, each admission once. */
async function fixture(loads: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'dn-call-decisions-')); roots.push(root);
  const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
  let loaded = 0;
  const context = { principal, policy: { async load() { return loads[Math.min(loaded++, loads.length - 1)]; } }, path: async () => ledger,
    layout: resolveProductLayout({ projectRoot: root, root: data }), config: { storage: { sqlite }, approvals: { keyFile: 'authority.key' } } };
  let plans = 0;
  const edits = { async plan() { plans++; return { ok: true }; }, floored: () => false, target: () => 'src/a.ts' };
  const inner: EffectApprovalGate = { async admit(_descriptor, decision) { if (decision !== 'allow') throw new EffectError('EFFECT_APPROVAL_REQUIRED'); } };
  const approvals = { gate: () => ({ gate: inner, async close() {} }) };
  const decisions = createAgentCallDecisions({ context: context as never, clock: new SystemTrustedClock(), scopeId: 'scope', turnId: 'turn', edits: (() => edits) as never,
    shell: null, approvals: approvals as never });
  const events = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT event_id FROM audit_events').all().length; } finally { db.close(); } };
  const auditRecords = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return db.prepare('SELECT record FROM audit_events').all().map(row => JSON.parse(String(row['record'])) as { event: { policyRevision: string; subject: { mode: string } } });
  } finally { db.close(); } };
  /** Runs the call as the effect application does: two admissions (submit, then before the first claim), recording what each saw. */
  const execute = async () => {
    const seen: { eventsAtRun: number; admissions: string[] } = { eventsAtRun: -1, admissions: [] };
    const outcome = await decisions.execute(edit, args, { round: 1, index: 0 }, 'call_1', async gate => {
      seen.eventsAtRun = events();
      for (let pass = 0; pass < 2; pass++) {
        try { await gate.admit({ approval: 'policy' } as never, 'require-approval', {} as never, principal as never, { record: null } as never); seen.admissions.push('admitted'); }
        catch (error) { seen.admissions.push((error as { code: string }).code); return { status: 'error', text: (error as { code: string }).code }; }
      }
      return { status: 'ok', text: 'ran' };
    });
    return { outcome, ...seen };
  };
  return { decisions, execute, events, auditRecords, plans: () => plans };
}

describe('permission decision at the effect (T-L4 slice 4a)', () => {
  it('writes the audit event before the effect runs and admits the relaxed call on each admission', async () => {
    const f = await fixture([snapshot('require-approval', 'auto-edit')]);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    expect(f.decisions.prepare(edit, args)).toEqual({ ok: true, requireApproval: false });
    expect(await f.execute()).toEqual({ outcome: { status: 'ok', text: 'ran' }, eventsAtRun: 1, admissions: ['admitted', 'admitted'] });
    expect(f.events()).toBe(1);
  });

  it('stops the effect when the policy denies between the audit and an admission; runs nothing when it changed before the effect', async () => {
    const denied = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('deny', 'auto-edit')]);
    expect(await denied.decisions.authorize(edit, args)).toBe('allow');
    expect(await denied.execute()).toMatchObject({ outcome: { status: 'error', text: 'POLICY_DENIED' }, admissions: ['admitted', 'POLICY_DENIED'] });
    const lost = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', null)]);
    expect(await lost.decisions.authorize(edit, args)).toBe('allow');
    expect(await lost.execute()).toMatchObject({ outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
    for (const [changed, text] of [[snapshot('deny', 'auto-edit'), 'denied-by-policy'], [snapshot('require-approval', null), 'approval-required']] as const) {
      const before = await fixture([snapshot('require-approval', 'auto-edit'), changed]);
      expect(await before.decisions.authorize(edit, args)).toBe('allow');
      const result = await before.execute();
      expect(result).toMatchObject({ eventsAtRun: -1, admissions: [] });
      expect(result.outcome.text).toContain(text);
      expect(before.events()).toBe(0);
    }
  });

  it('admits only the decision the audit event recorded: another mode, revision or a plain allow since stops the effect (Astra 2133)', async () => {
    // authorize, execute (the audited decision), then the admissions. Astra's case: audited in auto-edit, admitted after a switch to full-auto.
    const audited = snapshot('require-approval', 'auto-edit');
    const sameRevision = 'p-require-approval-auto-edit';
    for (const [label, later] of [['mode', snapshot('require-approval', 'full-auto')], ['revision', snapshot('require-approval', 'auto-edit', 'p-edited')],
      ['plain allow', snapshot('allow', 'auto-edit')], ['mode, revision not bumped', snapshot('require-approval', 'full-auto', sameRevision)],
      ['company grant, revision not bumped', snapshot('require-approval', 'auto-edit', sameRevision, 'edit-tool-2')],
      ['person entry, revision not bumped', snapshot('require-approval', 'auto-edit', sameRevision, 'edit-tool', 'me-mode-2')]] as const) {
      const f = await fixture([audited, audited, later]);
      expect(await f.decisions.authorize(edit, args)).toBe('allow');
      expect({ label, ...(await f.execute()) }).toEqual({ label, outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, eventsAtRun: 1,
        admissions: ['EFFECT_APPROVAL_REQUIRED'] });
      // No second event: the one audited decision is not replaced by the new one.
      expect(f.events()).toBe(1);
    }
    // A change between the two admissions stops the second one.
    const second = await fixture([audited, audited, audited, snapshot('require-approval', 'full-auto')]);
    expect(await second.decisions.authorize(edit, args)).toBe('allow');
    expect(await second.execute()).toMatchObject({ outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, admissions: ['admitted', 'EFFECT_APPROVAL_REQUIRED'] });
    // An equal snapshot read again (same revision, same relaxation) is still admitted.
    const same = await fixture([audited, audited, snapshot('require-approval', 'auto-edit')]);
    expect(await same.decisions.authorize(edit, args)).toBe('allow');
    expect(await same.execute()).toMatchObject({ outcome: { status: 'ok', text: 'ran' }, admissions: ['admitted', 'admitted'] });
  });

  it('Astra 2134 R2 repro: changing the relaxed mode after audit must not use the stale audit event', async () => {
    const f = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'full-auto')]);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    const result = await f.execute();
    expect(result.outcome.status).toBe('error');
    // The one event still describes the audited decision, and nothing was admitted under the new one.
    expect(result).toMatchObject({ eventsAtRun: 1, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
    expect(f.auditRecords().map(record => [record.event.policyRevision, record.event.subject.mode]))
      .toEqual([['p-require-approval-auto-edit+b', 'auto-edit']]);
  });

  it('answers deny before planning and fails closed on an unreadable policy', async () => {
    const f = await fixture([snapshot('deny', 'full-auto')]);
    expect(await f.decisions.authorize(edit, args)).toBe('deny');
    expect(f.plans()).toBe(0);
    const broken = await fixture([{ schemaVersion: 9 }]);
    expect(await broken.decisions.authorize(edit, args)).toBe('deny');
    expect(broken.decisions.prepare(edit, args)).toEqual({ ok: true, requireApproval: true });
  });
});
