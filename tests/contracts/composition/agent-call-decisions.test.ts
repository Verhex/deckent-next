import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectError, resolvePolicyBindings, type AgentToolSpec } from '#domain/index.js';
import { SessionStanding, type EffectApprovalGate } from '#engine/index.js';
import { resolveProductLayout, SystemTrustedClock } from '#platform/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createAgentCallDecisions } from '#composition/core/agent-turn/index.js';
import { shellWritePosture, type ShellCallAuthority } from '#adapters/index.js';

// T-L4 slice 4a (MODES-3: a bindings v2 `auto-edit` entry reads as standart, `ask` as standart that asks for every edit too): the turn's
// permission decision is taken again at the effect on the policy as it is then. A relaxation writes its audit
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
async function fixture(loads: unknown[], options: { standing?: { memory: SessionStanding; session: string }; floored?: boolean; selfSource?: boolean; fullAccess?: boolean; shell?: boolean; clockMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-call-decisions-')); roots.push(root);
  const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const ledger = join(root, 'ledger.db'); openSqliteLedger(ledger, sqlite).close();
  let loaded = 0;
  const context = { principal, policy: { async load() { return loads[Math.min(loaded++, loads.length - 1)]; } }, path: async () => ledger,
    layout: resolveProductLayout({ projectRoot: root, root: data }), config: { storage: { sqlite }, approvals: { keyFile: 'authority.key' } } };
  let plans = 0;
  const edits = { async plan() { plans++; return { ok: true }; }, floored: () => options.floored ?? false, authority: () => false, selfSource: () => options.selfSource ?? false, target: (_tool: string, given: Record<string, unknown>) => String(given['path']) };
  const inner: EffectApprovalGate = { async admit(_descriptor, decision) { if (decision !== 'allow') throw new EffectError('EFFECT_APPROVAL_REQUIRED'); } };
  const approvals = { gate: () => ({ gate: inner, async close() {} }) };
  const decisions = createAgentCallDecisions({ context: context as never, clock: options.clockMs === undefined ? new SystemTrustedClock() : { sample: () => ({ wallMs: options.clockMs!, monotonicMs: 1 }) }, scopeId: 'scope', turnId: 'turn', edits: (() => edits) as never,
    shell: options.shell ? { async plan() { return { ok: true }; }, tier: () => 'other-modify', containment: () => ({ realm: 'sandbox', contained: true }) } as never : null, approvals: approvals as never, fetch: null, ...(options.standing ? { standing: options.standing } : {}), ...(options.fullAccess ? { fullAccess: true } : {}) });
  const events = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT event_id FROM audit_events').all().length; } finally { db.close(); } };
  const auditRecords = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return db.prepare('SELECT record FROM audit_events').all().map(row => JSON.parse(String(row['record'])) as { event: { policyRevision: string; subject: { mode: string; kind: string; phase?: string; source?: string; approvalId?: string | null } & Record<string, unknown> } });
  } finally { db.close(); } };
  let lastAuthority: string | undefined;
  /** Runs the call as the effect application does: two admissions (submit, then before the first claim), recording what each saw. */
  const execute = async () => {
    const seen: { eventsAtRun: number; admissions: string[] } = { eventsAtRun: -1, admissions: [] };
    const outcome = await decisions.execute(edit, args, { round: 1, index: 0 }, 'call_1', async (gate, authority) => {
      lastAuthority = authority;
      seen.eventsAtRun = events();
      for (let pass = 0; pass < 2; pass++) {
        try { await gate.admit({ approval: 'policy' } as never, 'require-approval', {} as never, principal as never, { record: null } as never); seen.admissions.push('admitted'); }
        catch (error) { seen.admissions.push((error as { code: string }).code); return { status: 'error', text: (error as { code: string }).code }; }
      }
      return { status: 'ok', text: 'ran' };
    });
    return { outcome, ...seen };
  };
  return { decisions, execute, events, auditRecords, plans: () => plans, authority: () => lastAuthority, failAudit: () => { context.config.approvals.keyFile = '/'; } };
}

/** MODES-3: a policy snapshot with the company grant `permission-mode`/`set` `full-access` (null: none) and a v3 mode entry. */
const withAccess = (tool: Effect, grant: Effect | null, revision = `p-fa-${tool}-${grant}`, mode = 'full-auto') => {
  const base = snapshot(tool, 'full-auto', revision) as { grants: unknown[] } & Record<string, unknown>;
  return resolvePolicyBindings({ schemaVersion: 2, revision, roles: [], separationOfDuties: [], restrictions: [], grants: [...base.grants,
    ...(grant ? [{ id: 'fa', effect: grant, actions: ['set'], scopes: ['scope'], principals: [me], resource: { kind: 'permission-mode', ids: ['full-access'] } }] : [])] },
  { schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['scope'], mode: mode === 'full-auto' ? 'full-auto' : 'full-access' }] });
};

describe('permission decision at the effect (T-L4 slice 4a)', () => {
  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — writes the audit event before the effect runs and admits the relaxed call on each admission', async () => {
    const f = await fixture([snapshot('require-approval', 'auto-edit')]);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    expect(f.decisions.prepare(edit, args)).toEqual({ ok: true, requireApproval: false });
    expect(await f.execute()).toEqual({ outcome: { status: 'ok', text: 'ran' }, eventsAtRun: 1, admissions: ['admitted', 'admitted'] });
    expect(f.events()).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — stops the effect when the policy denies between the audit and an admission; runs nothing when it changed before the effect', async () => {
    const denied = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('deny', 'auto-edit')]);
    expect(await denied.decisions.authorize(edit, args)).toBe('allow');
    expect(await denied.execute()).toMatchObject({ outcome: { status: 'error', text: 'POLICY_DENIED' }, admissions: ['admitted', 'POLICY_DENIED'] });
    const lost = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'ask')]);
    expect(await lost.decisions.authorize(edit, args)).toBe('allow');
    expect(await lost.execute()).toMatchObject({ outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
    for (const [changed, text] of [[snapshot('deny', 'auto-edit'), 'denied-by-policy'], [snapshot('require-approval', 'ask'), 'approval-required']] as const) {
      const before = await fixture([snapshot('require-approval', 'auto-edit'), changed]);
      expect(await before.decisions.authorize(edit, args)).toBe('allow');
      const result = await before.execute();
      expect(result).toMatchObject({ eventsAtRun: -1, admissions: [] });
      expect(result.outcome.text).toContain(text);
      expect(before.events()).toBe(0);
    }
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — admits only the decision the audit event recorded: another mode, revision or a plain allow since stops the effect (Astra 2133)', async () => {
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

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — Astra 2134 R2 repro: changing the relaxed mode after audit must not use the stale audit event', async () => {
    const f = await fixture([snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'auto-edit'), snapshot('require-approval', 'full-auto')]);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    const result = await f.execute();
    expect(result.outcome.status).toBe('error');
    // The one event still describes the audited decision, and nothing was admitted under the new one.
    expect(result).toMatchObject({ eventsAtRun: 1, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
    expect(f.auditRecords().map(record => [record.event.policyRevision, record.event.subject.mode]))
      .toEqual([['p-require-approval-auto-edit+b', 'standart']]);
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — answers deny before planning and fails closed on an unreadable policy', async () => {
    const f = await fixture([snapshot('deny', 'full-auto')]);
    expect(await f.decisions.authorize(edit, args)).toBe('deny');
    expect(f.plans()).toBe(0);
    const broken = await fixture([{ schemaVersion: 9 }]);
    expect(await broken.decisions.authorize(edit, args)).toBe('deny');
    expect(broken.decisions.prepare(edit, args)).toEqual({ ok: true, requireApproval: true });
  });

  // PERSISTENT-APPROVALS G6: a standing approval lowers the owner approval of an ordinary edit exactly like a mode relaxation does — audited
  // before the effect, re-decided on every admission, admitted only as audited — and "this session" is remembered only after its audit.
  const KEY = 'v1:edit_file:directory:src/*';
  const asks = snapshot('require-approval', 'ask');
  const withGrant = (id = 'standing-1', revision = 'p-grant') => {
    const base = snapshot('require-approval', 'ask', revision) as { grants: unknown[] } & Record<string, unknown>;
    return resolvePolicyBindings({ schemaVersion: 2, revision, roles: [], separationOfDuties: [], restrictions: [], grants: [...base.grants, { id, effect: 'allow', actions: ['invoke'], scopes: ['scope'],
      principals: [me], resource: { kind: 'agent-tool-call', ids: [KEY] } }] }, { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'me-mode', principal: me, scopes: ['scope'], mode: 'ask' }] });
  };

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — this session: asks until the card answer is remembered (audited first), then lowers the call, audits its use before the effect, and is gone after a restart', async () => {
    const memory = new SessionStanding(), session = 'conversation-1';
    const f = await fixture([asks], { standing: { memory, session } });
    expect(await f.decisions.authorize(edit, args)).toBe('require-approval');
    expect(await f.decisions.remember(edit, args, { round: 1, index: 0 }, 'call_1', 'approval-1')).toBe(true);
    expect(f.auditRecords().map(record => [record.event.subject.kind, record.event.subject.phase, record.event.subject.source, record.event.subject.approvalId]))
      .toEqual([['standing-approval', 'remembered', 'session', 'approval-1']]);
    expect(memory.has(session, KEY)).toBe(true);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    expect(await f.execute()).toEqual({ outcome: { status: 'ok', text: 'ran' }, eventsAtRun: 2, admissions: ['admitted', 'admitted'] });
    expect(f.auditRecords().map(record => record.event.subject.phase)).toEqual(['remembered', 'used']);
    // A restarted service holds nothing: the same call asks again.
    const restarted = await fixture([asks], { standing: { memory: new SessionStanding(), session } });
    expect(await restarted.decisions.authorize(edit, args)).toBe('require-approval');
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — a call the standing approval does not name, another conversation, or the write floor still asks; nothing is remembered without an audit', async () => {
    const memory = new SessionStanding();
    memory.remember('conversation-1', KEY);
    const other = await fixture([asks], { standing: { memory, session: 'conversation-2' } });
    expect(await other.decisions.authorize(edit, args)).toBe('require-approval');
    const elsewhere = await fixture([asks], { standing: { memory, session: 'conversation-1' } });
    expect(await elsewhere.decisions.authorize(edit, { ...args, path: 'docs/a.md' })).toBe('require-approval');
    const floored = await fixture([asks], { standing: { memory, session: 'conversation-1' }, floored: true });
    expect(await floored.decisions.authorize(edit, args)).toBe('require-approval');
    expect(await floored.decisions.remember(edit, args, { round: 1, index: 0 }, 'call_1', 'approval-1')).toBe(false);
    expect(floored.events()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — the persisted grant lowers the call and is audited as a grant; losing the session memory or the grant before an admission stops the effect', async () => {
    const granted = await fixture([withGrant()]);
    expect(await granted.decisions.authorize(edit, args)).toBe('allow');
    expect(await granted.execute()).toMatchObject({ outcome: { status: 'ok' }, eventsAtRun: 1, admissions: ['admitted', 'admitted'] });
    expect(granted.auditRecords()[0]!.event.subject).toMatchObject({ kind: 'standing-approval', phase: 'used', source: 'grant', grantId: 'standing-1' });
    // Revoked, replaced by another grant id, or the policy revision changed (same grant) between the audit and an admission: the audited decision is gone.
    for (const later of [asks, withGrant('standing-2'), withGrant('standing-1', 'p-edited')]) {
      const f = await fixture([withGrant(), withGrant(), later]);
      expect(await f.decisions.authorize(edit, args)).toBe('allow');
      expect(await f.execute()).toMatchObject({ outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
    }
    const memory = new SessionStanding();
    memory.remember('c', KEY);
    const dropped = await fixture([asks], { standing: { memory, session: 'c' } });
    expect(await dropped.decisions.authorize(edit, args)).toBe('allow');
    const seen: string[] = [];
    await dropped.decisions.execute(edit, args, { round: 1, index: 0 }, 'call_1', async gate => {
      memory.forget('c');
      try { await gate.admit({ approval: 'policy' } as never, 'require-approval', {} as never, principal as never, { record: null } as never); seen.push('admitted'); }
      catch (error) { seen.push((error as { code: string }).code); }
      return { status: 'ok', text: 'x' };
    });
    expect(seen).toEqual(['EFFECT_APPROVAL_REQUIRED']);
  });

  // MODES-3: a launched full-access turn. Every effect call it allows is one sealed `full-access-call` event before the effect — a plain allow
  // too — and the effect gate admits only that decision again: a revoked grant (or a turn without the flag) is not what was audited.
  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — full access: a plain allow and a floor path both run, each audited once as a full-access call before the effect', async () => {
    const plain = await fixture([withAccess('allow', 'allow')], { fullAccess: true });
    expect(await plain.decisions.authorize(edit, args)).toBe('allow');
    expect(await plain.execute()).toEqual({ outcome: { status: 'ok', text: 'ran' }, eventsAtRun: 1, admissions: ['admitted', 'admitted'] });
    expect(plain.auditRecords().map(record => record.event.subject)).toEqual([expect.objectContaining({ kind: 'full-access-call', cell: 'edit', policy: 'allow', raised: false,
      company: null, grant: 'fa', summary: { kind: 'edit', path: 'src/a.ts' } })]);
    const floor = await fixture([withAccess('require-approval', 'allow')], { fullAccess: true, floored: true });
    expect(await floor.decisions.authorize(edit, args)).toBe('allow');
    expect(await floor.execute()).toMatchObject({ outcome: { status: 'ok' }, eventsAtRun: 1 });
    expect(floor.auditRecords()[0]!.event.subject).toMatchObject({ kind: 'full-access-call', cell: 'edit-floor', policy: 'require-approval', raised: false, company: 'edit-tool' });
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — full access: a grant revoked or denied after the audit stops the effect; without the grant or without the launch flag it is the stored mode', async () => {
    for (const later of [withAccess('allow', null), withAccess('allow', 'deny'), withAccess('allow', 'allow', 'p-edited')]) {
      const f = await fixture([withAccess('allow', 'allow'), withAccess('allow', 'allow'), later], { fullAccess: true });
      expect(await f.decisions.authorize(edit, args)).toBe('allow');
      expect(await f.execute()).toMatchObject({ outcome: { status: 'error', text: 'EFFECT_APPROVAL_REQUIRED' }, eventsAtRun: 1, admissions: ['EFFECT_APPROVAL_REQUIRED'] });
      expect(f.events()).toBe(1);
    }
    // No grant: the floor asks (standart reading). A stored full-access start mode without the launch flag is standart too.
    const noGrant = await fixture([withAccess('allow', null)], { fullAccess: true, floored: true });
    expect(await noGrant.decisions.authorize(edit, args)).toBe('require-approval');
    const stored = await fixture([withAccess('allow', 'allow', 'p-stored', 'full-access')], { floored: true });
    expect(await stored.decisions.authorize(edit, args)).toBe('require-approval');
    expect(noGrant.events() + stored.events()).toBe(0);
  });
});

describe('call authority at the effect (merge Astra 2170 x MODES-3)', () => {
  // Merge Astra 2170 x MODES-3 (owner 2026-09-29): the decision tells the effect who stands behind the call — the sandboxed shell derives its
  // write posture from it (`shellWritePosture`): an audited full-access call is `full-access`, never the unattended read-only posture.
  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — hands the effect the call authority: owner-approved for a card, full-access for an audited full-access call, unattended otherwise', async () => {
    const cases: readonly [string, unknown, boolean, string][] = [['card (ask edits)', snapshot('require-approval', 'ask'), false, 'owner-approved'],
      ['full access', withAccess('allow', 'allow'), true, 'full-access'], ['full access over a floor raise', withAccess('require-approval', 'allow'), true, 'full-access'],
      ['mode relaxation', snapshot('require-approval', 'auto-edit'), false, 'unattended'], ['silent allow', snapshot('allow', null), false, 'unattended'],
      ['full-auto relaxation with the grant but no launch flag', withAccess('require-approval', 'allow'), false, 'unattended']];
    for (const [label, loaded, fullAccess, authority] of cases) {
      const f = await fixture([loaded], { fullAccess });
      await f.decisions.authorize(edit, args);
      await f.execute();
      expect({ label, authority: f.authority() }).toEqual({ label, authority });
    }
  });

  // The one posture derivation, pinned per owner rule (2026-09-29): full access is comprehensive (never project read-only; only the configuration
  // file, its turn's floor, stays read-only); standart/full-auto keep the Astra 2170 postures; a revoked full-access turn's unattended call is
  // read-only whatever its tier.
  // SHELL-OVERLAY: a full-auto relaxation past the narrow set, in a realm that keeps writes aside, gets the write set (the project is not
  // read-only: its writes are decided like edits afterwards); without such a realm, or for any other authority, the postures above hold.
  it('derives every write posture from the call authority, the tier, the turn and whether the realm keeps writes aside', () => {
    const tiers = ['read-none', 'read-low', 'narrow-mutating', 'destructive', 'always-ask', 'other-modify'] as const;
    for (const authority of ['owner-approved', 'full-access', 'full-auto', 'unattended'] as const satisfies readonly ShellCallAuthority[]) {
      for (const tier of tiers) {
        for (const fullAccessTurn of [false, true]) {
          for (const writeSets of [false, true]) {
            const writeSet = authority === 'full-auto' && writeSets && tier !== 'narrow-mutating' && !fullAccessTurn;
            const expected = authority === 'owner-approved' ? { writeFloorReadOnly: false, projectReadOnly: false, writeSet: false }
              : authority === 'full-access' ? { writeFloorReadOnly: true, projectReadOnly: false, writeSet: false }
                : writeSet ? { writeFloorReadOnly: true, projectReadOnly: false, writeSet: true }
                  : { writeFloorReadOnly: true, projectReadOnly: fullAccessTurn || tier !== 'narrow-mutating', writeSet: false };
            // OPEN-SANDBOX: the launched full-access mode, and the owner's card inside a full-access turn, run in the open view.
            const open = authority === 'full-access' || authority === 'owner-approved' && fullAccessTurn;
            expect({ authority, tier, fullAccessTurn, writeSets, ...shellWritePosture(authority, tier, fullAccessTurn, writeSets) })
              .toEqual({ authority, tier, fullAccessTurn, writeSets, ...expected, open });
          }
        }
      }
    }
  });
});

describe('SELF-SOURCE-FLOOR session effect integration', () => {
  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — full-access ordinary and static-floor decisions and audit payloads are byte-identical with self-source on or off', async () => {
    for (const floored of [false, true]) {
      const baseline = await fixture([withAccess('allow', 'allow')], { fullAccess: true, selfSource: false, floored, clockMs: 1000 });
      const derived = await fixture([withAccess('allow', 'allow')], { fullAccess: true, selfSource: true, floored, clockMs: 1000 });
      expect(await derived.decisions.authorize(edit, args)).toBe(await baseline.decisions.authorize(edit, args));
      expect(derived.decisions.cell(edit, args)).toBe(floored ? 'edit-floor' : 'edit');
      expect(JSON.stringify(derived.decisions.prepare(edit, args))).toBe(JSON.stringify(baseline.decisions.prepare(edit, args)));
      expect(await derived.execute()).toEqual(await baseline.execute());
      expect(JSON.stringify(derived.auditRecords().map(record => record.event))).toBe(JSON.stringify(baseline.auditRecords().map(record => record.event)));
    }
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — a full-auto shell write set refuses dist self-source and authority paths before application, while ordinary customer writes stay allowed', async () => {
    const base = snapshot('allow', 'full-auto') as { grants: unknown[] };
    const policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants: [...base.grants,
      { id: 'shell', effect: 'require-approval', modeEligible: true, actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool', ids: ['run_shell'] } },
      { id: 'run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: [me], resource: { kind: 'operation', ids: ['host.shell.run'] } }] },
    { schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'mode', principal: me, scopes: ['scope'], mode: 'full-auto' }] });
    const f = await fixture([policy], { shell: true, selfSource: true });
    const tool = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'shell', inputSchema: { type: 'object' } } as AgentToolSpec;
    const given = { command: 'touch dist/a.js' };
    expect(await f.decisions.authorize(tool, given)).toBe('allow');
    const result = await f.decisions.execute(tool, given, { round: 1, index: 0 }, 'shell-call', async (_gate, authority, writes) => {
      expect(authority).toBe('full-auto');
      expect(writes).toBeDefined();
      expect(await writes!.decide('dist/a.js', 'edit-self-source')).toEqual({ ok: false, reason: 'write-floor' });
      expect(await writes!.decide('deckent.json', 'edit-authority')).toEqual({ ok: false, reason: 'configuration-file' });
      expect(await writes!.decide('docs/a.md', 'edit')).toMatchObject({ ok: true });
      return { status: 'ok', text: 'checked' };
    });
    expect(result).toEqual({ status: 'ok', text: 'checked' });
    // Only the shell call and the ordinary-write relaxation were audited; neither refused write reached an effect.
    expect(f.events()).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — a session-lowered self-source shell write-set entry records its sealed use before its effect', async () => {
    const base = snapshot('allow', 'full-auto') as { grants: unknown[] };
    const policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants: [...base.grants,
      { id: 'shell', effect: 'require-approval', modeEligible: true, actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool', ids: ['run_shell'] } },
      { id: 'run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: [me], resource: { kind: 'operation', ids: ['host.shell.run'] } }] },
    { schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'mode', principal: me, scopes: ['scope'], mode: 'full-auto' }] });
    const changed = resolvePolicyBindings({ schemaVersion: 2, revision: 'changed', roles: [], separationOfDuties: [], restrictions: [], grants: policy.grants },
    { schemaVersion: 3, revision: 'b', bindings: [], modes: [{ id: 'mode', principal: me, scopes: ['scope'], mode: 'full-auto' }] });
    for (const loss of ['memory', 'policy'] as const) {
      const memory = new SessionStanding(), session = 'shell-source-session';
      memory.remember(session, 'v1:session:edit-self-source:run_shell:directory:dist/*');
      const f = await fixture(loss === 'policy' ? [policy, policy, policy, policy, changed] : [policy], { shell: true, selfSource: true, standing: { memory, session } });
      const tool = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'shell', inputSchema: { type: 'object' } } as AgentToolSpec;
      const given = { command: 'touch dist/a.js' };
      expect(await f.decisions.authorize(tool, given)).toBe('allow');
      const result = await f.decisions.execute(tool, given, { round: 1, index: 0 }, 'shell-call', async (_gate, _authority, writes) => {
        const decision = await writes!.decide('dist/a.js', 'edit-self-source');
        expect(decision.ok).toBe(true);
        expect(f.auditRecords().at(-1)!.event.subject).toMatchObject({ kind: 'standing-approval', phase: 'used', source: 'session', cell: 'edit-self-source',
          summary: { kind: 'edit', path: 'dist/a.js' } });
        const second = await writes!.decide('dist/b.js', 'edit-self-source');
        expect(second.ok).toBe(true);
        const used = f.auditRecords().filter(record => record.event.subject.kind === 'standing-approval');
        expect(used.map(record => record.event.subject['summary'])).toEqual([{ kind: 'edit', path: 'dist/a.js' }, { kind: 'edit', path: 'dist/b.js' }]);
        if (!decision.ok) return { status: 'error', text: 'refused' };
        if (loss === 'memory') memory.forget(session);
        await expect(decision.gate.admit({ approval: 'policy' } as never, 'require-approval', {} as never, principal as never, { record: null } as never))
          .rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
        return { status: 'ok', text: 'checked' };
      });
      expect(result).toEqual({ status: 'ok', text: 'checked' });
    }
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — unavailable audit never remembers a self-source session or runs its lowered effect', async () => {
    const memory = new SessionStanding(), session = 'failed-audit-session';
    const key = 'v1:session:edit-self-source:edit_file:directory:src/*';
    const f = await fixture([snapshot('require-approval', 'ask')], { selfSource: true, standing: { memory, session } });
    expect(await f.decisions.authorize(edit, args)).toBe('require-approval');
    f.failAudit();
    expect(await f.decisions.remember(edit, args, { round: 1, index: 0 }, 'call_1', 'approval')).toBe(false);
    expect(memory.has(session, key)).toBe(false);
    expect(f.events()).toBe(0);
    // Existing session memory cannot bypass a lost audit key: no effect callback is reached.
    memory.remember(session, key);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    const result = await f.execute();
    expect(result.outcome).toMatchObject({ status: 'error' });
    expect(result.outcome.text).toContain('audit-unavailable');
    expect(result.eventsAtRun).toBe(-1);
    expect(result.admissions).toEqual([]);
    expect(f.events()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('requires POSIX private audit keyring — self-source session answers are sealed before memory and used before effects; persisted-only grants never replace the answer', async () => {
    const asks = snapshot('require-approval', 'ask');
    const memory = new SessionStanding(), session = 'self-source-conversation';
    const key = 'v1:session:edit-self-source:edit_file:directory:src/*';
    const f = await fixture([asks], { standing: { memory, session }, selfSource: true });
    expect(await f.decisions.authorize(edit, args)).toBe('require-approval');
    expect(await f.decisions.remember(edit, args, { round: 1, index: 0 }, 'call_1', 'approval-self-source')).toBe(true);
    expect(f.auditRecords()[0]!.event.subject).toMatchObject({ kind: 'standing-approval', phase: 'remembered', source: 'session', cell: 'edit-self-source', grantId: null });
    expect(memory.has(session, key)).toBe(true);
    expect(memory.has(session, 'v1:edit_file:directory:src/*')).toBe(false);
    expect(await f.decisions.authorize(edit, args)).toBe('allow');
    expect(await f.execute()).toMatchObject({ outcome: { status: 'ok' }, eventsAtRun: 2, admissions: ['admitted', 'admitted'] });
    expect(f.auditRecords()[1]!.event.subject).toMatchObject({ kind: 'standing-approval', phase: 'used', source: 'session', cell: 'edit-self-source' });
    const restarted = await fixture([asks], { standing: { memory: new SessionStanding(), session }, selfSource: true });
    expect(await restarted.decisions.authorize(edit, args)).toBe('require-approval');
    const base = snapshot('require-approval', 'ask') as { grants: unknown[] };
    const persisted = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], separationOfDuties: [], restrictions: [], grants: [...base.grants,
      { id: 'standing-self-source', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [me], resource: { kind: 'agent-tool-call', ids: [key] } }] },
    { schemaVersion: 2, revision: 'b', bindings: [], modes: [{ id: 'asks', principal: me, scopes: ['scope'], mode: 'ask' }] });
    const granted = await fixture([persisted], { selfSource: true });
    expect(await granted.decisions.authorize(edit, args)).toBe('require-approval');
    expect(granted.events()).toBe(0);
  });

});
