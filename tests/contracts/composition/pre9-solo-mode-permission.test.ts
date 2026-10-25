import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, openOwnPermissionMode, openPermissionModesInstallation } from '#composition/core/installation/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { readLocalOsIdentity, withLocalPrincipalChannel } from '#adapters/index.js';
import { FIRST_RUN_POLICY_TEMPLATE_VERSION, INSTALLER_PERMISSION_MODES_COMMAND_PREFIX, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, fullAccessGrant, installerPermissionModeRuleId,
  mcpPrincipalRef, permissionModeView, planInstallerPermissionModes, policySchema, resolvePolicyBindings, type AuditEvent, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, PermissionModeApplication, admitFullAccessTurn, decideAgentToolCall } from '#engine/index.js';
import { getConfigFieldDefault, productResourcePath, resolveProductLayout, t } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import { permissionModeStop, runModeCommand } from '#surfaces/core/terminal/index.js';

// PRE-9 SOLO-MOD-IZNI (owner 2026-10-21; law audit AUDIT-PRE9-LAW R1–R8): on a fresh solo installation the installation owner opens full-auto and
// full-access with `deckent init policy --scope <id> --modes <set>` confirmed at the terminal; an AI (MCP) or a pipe cannot; the hard floor stays
// closed in full access; other people and the template default are unchanged; plan and result are the effective decision per mode (R1).
const SCOPE = 'installation';
const cli = (modes: string, ...rest: string[]) => ['init', 'policy', '--scope', SCOPE, '--modes', modes, ...rest];
const RULE_IDS = { 'full-auto': installerPermissionModeRuleId('full-auto'), 'full-access': installerPermissionModeRuleId('full-access') } as const;
const COMMAND_HINT = 'deckent init policy';
const attested = { attest: async () => true };
const uid = () => process.getuid?.();
type Modes = readonly string[];
const open = (root: string, modes: Modes, apply = false, expect?: string, witness = attested) =>
  openPermissionModesInstallation(root, SCOPE, { modes, apply, ...(expect === undefined ? {} : { expect }) }, {}, uid(), witness);
/** Preview, then apply exactly the previewed revision as an attested person (the CLI card's path). */
async function openWitnessed(root: string, modes: Modes) {
  const planned = await open(root, modes);
  return open(root, modes, true, planned.revision ?? undefined);
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[relative(root, join(entry.parentPath, entry.name))] = (await readFile(join(entry.parentPath, entry.name))).toString('base64');
  }
  return out;
}
/** A fresh `init policy --apply` installation and the person it names (this process's OS identity), with a real mode application over its files. */
async function freshInstallation(edit?: (policy: { grants: unknown[] }) => unknown) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pre9-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, SCOPE);
  const layout = resolveProductLayout({ projectRoot: root }), policyPath = productResourcePath(layout, 'policy');
  if (edit) {
    const current = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: unknown[] };
    await writeFile(policyPath, JSON.stringify(edit(current)), { mode: 0o600 });
  }
  const identity = readLocalOsIdentity();
  const person: VerifiedPrincipal = { id: identity.id, issuer: identity.issuer, subject: identity.subject, assurance: 'os-user', scopeIds: [SCOPE] };
  const source = createLayoutPolicySource(layout, process.getuid!(), getConfigFieldDefault('inspection').policyMaxBytes);
  const modes = new PermissionModeApplication(source, () => undefined, Date.now);
  const load = async () => source.load();
  const set = async (mode: 'full-auto' | 'full-access' | 'standart') => {
    const revision = permissionModeView(policySchema.parse(await load()), person, SCOPE).revision;
    return modes.set(person, { schemaVersion: 1, scopeId: SCOPE, mode, expectedRevision: revision }).then(result => ({ result }), (error: { code?: string }) => ({ code: error.code }));
  };
  const permissionRules = async () => (JSON.parse(await readFile(policyPath, 'utf8')) as { grants: PolicyGrant[] }).grants.filter(rule => rule.resource.kind === 'permission-mode');
  const audit = () => {
    const db = new DatabaseSync(productResourcePath(layout, 'ledger'), { readOnly: true });
    try { return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row.record)) as { event: AuditEvent }).event); } finally { db.close(); }
  };
  return { root, policyPath, person, load, set, permissionRules, audit };
}
const io = () => {
  const out: string[] = [];
  return { out, sinks: { stdout: { write(value: string) { out.push(value); return true; } }, stderr: { write(value: string) { out.push(value); return true; } } } };
};

describe.skipIf(process.platform !== 'linux')('PRE-9: the installation owner opens full-auto / full-access by a confirmed product command', () => {
  it('fresh solo install: standart only; the command previews, a witnessed apply opens both modes, then the person sets them', async () => {
    const f = await freshInstallation();
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
    expect(permissionModeView(policySchema.parse(await f.load()), f.person, SCOPE)).toMatchObject({ fullAuto: false, fullAccess: false });

    // The product command: the CLI preview shows each mode's effective change (nothing written).
    const before = await snapshot(f.root), preview = io();
    expect(await main(cli('full-auto,full-access', '--preview', '--json'), { root: f.root, initialize() {}, openPermissionModesInstallation, ...preview.sinks })).toBe(0);
    expect(JSON.parse(preview.out.join(''))).toMatchObject({ status: 'preview', basis: 'first-run', added: [{ id: RULE_IDS['full-auto'] }, { id: RULE_IDS['full-access'] }],
      modes: [{ mode: 'full-auto', before: 'deny', after: 'allow', managed: 'added', others: [] }, { mode: 'full-access', before: 'deny', after: 'allow', managed: 'added', others: [] }] });
    expect(await snapshot(f.root)).toEqual(before);

    // A witnessed apply writes exactly the two managed rules, naming this person alone, in this scope only, audited as an installer authority change.
    expect(await openWitnessed(f.root, ['full-auto', 'full-access'])).toMatchObject({ status: 'applied' });
    const named = [{ issuer: f.person.issuer, subject: f.person.subject }];
    expect(await f.permissionRules()).toEqual([
      { id: RULE_IDS['full-auto'], effect: 'allow', actions: ['set'], scopes: [SCOPE], principals: named, resource: { kind: 'permission-mode', ids: ['full-auto'] } },
      { id: RULE_IDS['full-access'], effect: 'allow', actions: ['set'], scopes: [SCOPE], principals: named, resource: { kind: 'permission-mode', ids: ['full-access'] } },
    ]);
    const change = f.audit().map(event => event.subject).filter(subject => subject.kind === 'authority-change').at(-1);
    expect(change).toMatchObject({ kind: 'authority-change', installer: { basis: 'first-run', template: { version: 16 } }, counts: { grantsAdded: 2, grantsRemoved: 0 } });
    expect((change as { commandId: string }).commandId.startsWith(INSTALLER_PERMISSION_MODES_COMMAND_PREFIX)).toBe(true);
    // The same set again changes nothing.
    expect(await open(f.root, ['full-auto', 'full-access'])).toMatchObject({ status: 'current' });

    expect(permissionModeView(policySchema.parse(await f.load()), f.person, SCOPE)).toMatchObject({ fullAuto: true, fullAccess: true });
    expect(await f.set('full-auto')).toMatchObject({ result: { mode: 'full-auto', changed: true } });
    expect(admitFullAccessTurn(await f.load(), { principal: f.person, scopeId: SCOPE, turnId: 't1', sessionId: null, eventId: 'e1', atMs: 1 }).allowed).toBe(true);
  });

  it('U5-S5: own-mode card refuses AI, no witness and foreign owner; decline is inert, yes uses one audited PRE-9 write and retains another open mode', async () => {
    const f = await freshInstallation(), before = await snapshot(f.root); let asks = 0;
    const input = { scopeId: SCOPE, mode: 'full-access' as const, confirm: async () => { asks++; return true; } };
    await expect(withLocalPrincipalChannel('mcp', () => openOwnPermissionMode(f.root, input, {}, uid(), attested))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(openOwnPermissionMode(f.root, input, {}, uid(), { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(openOwnPermissionMode(f.root, input, {}, uid()! + 1, attested)).rejects.toMatchObject({ code: 'PERMISSION_MODE_DENIED' });
    expect(asks).toBe(0); expect(await snapshot(f.root)).toEqual(before);
    expect(await openOwnPermissionMode(f.root, { ...input, confirm: async () => false }, {}, uid(), attested)).toBe(false);
    expect(await snapshot(f.root)).toEqual(before);
    const cancel = new AbortController();
    expect(await openOwnPermissionMode(f.root, { ...input, signal: cancel.signal, confirm: async () => { cancel.abort(); return true; } }, {}, uid(), attested)).toBe(false);
    expect(await snapshot(f.root)).toEqual(before);
    await openWitnessed(f.root, ['full-auto']);
    const prior = f.audit().filter(event => event.subject.kind === 'authority-change').length;
    expect(await openOwnPermissionMode(f.root, input, {}, uid(), attested)).toBe(true); expect(asks).toBe(1);
    expect((await f.permissionRules()).map(rule => rule.id)).toEqual([RULE_IDS['full-auto'], RULE_IDS['full-access']]);
    expect(f.audit().filter(event => event.subject.kind === 'authority-change')).toHaveLength(prior + 1);
    // Review an old revision, then move it with another authorized writer. The accepted old card must never apply.
    await openWitnessed(f.root, []);
    await expect(openOwnPermissionMode(f.root, { ...input, confirm: async () => { await openWitnessed(f.root, ['full-auto']); return true; } }, {}, uid(), attested))
      .rejects.toMatchObject({ code: 'PERMISSION_MODE_CONFLICT' });
    expect((await f.permissionRules()).map(rule => rule.id)).toEqual([RULE_IDS['full-auto']]);
    const custom = await freshInstallation(policy => ({ ...policy, grants: policy.grants.filter(rule => (rule as PolicyGrant).id !== 'first-run-read-tools') }));
    expect(await openOwnPermissionMode(custom.root, input, {}, uid(), attested)).toBe(true);
    expect((await custom.permissionRules()).map(rule => rule.id)).toEqual([RULE_IDS['full-access']]);
  });

  it('a pipe (no controlling terminal) and the MCP actor cannot open the modes: typed refusal, every file byte-identical', async () => {
    const f = await freshInstallation(), before = await snapshot(f.root);
    const cliRun = io();
    expect(await main(cli('full-auto,full-access', '--apply', '--json'), { root: f.root, initialize() {}, openPermissionModesInstallation, ...cliRun.sinks })).not.toBe(0);
    expect(cliRun.out.join('')).toContain('AUTHORITY_WITNESS_REQUIRED');
    await expect(openPermissionModesInstallation(f.root, SCOPE, { modes: ['full-auto'], apply: true })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(withLocalPrincipalChannel('mcp', () => open(f.root, ['full-auto'], true))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await snapshot(f.root)).toEqual(before);
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
    // `--modes` never goes with `--upgrade`; an unknown or repeated mode is a usage error.
    for (const argv of [cli('full-auto', '--upgrade', '--preview'), cli('standart', '--preview'), cli('full-auto,full-auto', '--preview')]) {
      const run = io();
      expect(await main(argv, { root: f.root, initialize() {}, openPermissionModesInstallation, ...run.sinks })).not.toBe(0);
      expect(run.out.join('')).toContain('CLI_USAGE');
    }
  });

  it('a company deny on permission-mode/set wins: the command refuses, names the rule and writes nothing', async () => {
    const f = await freshInstallation(policy => ({ ...policy, grants: [...policy.grants, { id: 'company-no-full-access', effect: 'deny', actions: ['set'], scopes: [SCOPE],
      principals: 'all', resource: { kind: 'permission-mode', ids: ['full-access'] } }] }));
    const before = await snapshot(f.root);
    expect(await open(f.root, ['full-access'])).toMatchObject({ status: 'refused', reason: 'policy-refused',
      modes: expect.arrayContaining([expect.objectContaining({ mode: 'full-access', after: 'deny', blockedBy: 'company-no-full-access' })]) });
    expect(await open(f.root, ['full-access'], true)).toMatchObject({ status: 'refused' });
    expect(await snapshot(f.root)).toEqual(before);
  });

  it('R1: a mode another rule already allows is current (nothing added); --modes none leaves it open and names that rule', async () => {
    const owner = readLocalOsIdentity();
    const hand = { id: 'hand-permission-modes', effect: 'allow', actions: ['set'], scopes: [SCOPE], principals: [{ issuer: owner.issuer, subject: owner.subject }],
      resource: { kind: 'permission-mode', ids: ['full-auto', 'full-access'] } };
    const f = await freshInstallation(policy => ({ ...policy, grants: [...policy.grants, hand] }));
    const before = await snapshot(f.root);
    expect(await open(f.root, ['full-auto', 'full-access'])).toMatchObject({ status: 'current', added: [],
      modes: [{ mode: 'full-auto', after: 'allow', managed: 'none', others: ['hand-permission-modes'] }, { mode: 'full-access', after: 'allow', managed: 'none', others: ['hand-permission-modes'] }] });
    expect(await open(f.root, [])).toMatchObject({ status: 'current', removed: [], modes: [{ mode: 'full-auto', wanted: false, after: 'allow', others: ['hand-permission-modes'] },
      { mode: 'full-access', wanted: false, after: 'allow', others: ['hand-permission-modes'] }] });
    expect(await snapshot(f.root)).toEqual(before);
    // The CLI says so in words: the hand rule stays and still allows the mode.
    const run = io();
    expect(await main(cli('none', '--preview'), { root: f.root, initialize() {}, openPermissionModesInstallation, ...run.sinks })).toBe(0);
    expect(run.out.join('')).toContain('hand-permission-modes');
  });

  it('after opening: the hard floor stays closed in full access, AI stays denied, another person stays standart; --modes none closes', async () => {
    const f = await freshInstallation();
    await openWitnessed(f.root, ['full-auto', 'full-access']);
    const policy = await f.load();
    const call = (cell: 'edit-authority' | 'mcp-floor' | 'shell-destructive', principal: VerifiedPrincipal = f.person, snapshotPolicy: unknown = policy) => decideAgentToolCall(snapshotPolicy, {
      principal, scopeId: SCOPE, fullAccess: true, cell,
      ...(cell === 'mcp-floor' ? { tool: { name: 'mcp__srv__drop' }, mcpServer: 'srv', operation: { id: FIRST_RUN_TOOL_NAMES.mcpCallOperationId } }
        : cell === 'edit-authority' ? { tool: { name: 'edit_file' }, operation: { id: FIRST_RUN_TOOL_NAMES.writeOperationId } }
          : { tool: { name: 'run_shell' }, operation: { id: FIRST_RUN_TOOL_NAMES.shellOperationId } }) }).decision;
    expect(call('shell-destructive')).toBe('allow');
    expect(call('edit-authority')).toBe('require-approval');
    expect(call('mcp-floor')).toBe('require-approval');
    const parsed = policySchema.parse(policy);
    const withDeny = { ...parsed, grants: [...(parsed.schemaVersion === 2 ? parsed.grants : []), { id: 'company-no-shell', effect: 'deny', actions: ['execute'], scopes: [SCOPE], principals: 'all',
      resource: { kind: 'operation', ids: [FIRST_RUN_TOOL_NAMES.shellOperationId] } }] };
    expect(call('shell-destructive', f.person, withDeny)).toBe('deny');
    const ai: VerifiedPrincipal = { ...f.person, ...mcpPrincipalRef(f.person), assurance: 'workload-verified' };
    expect(evaluatePolicy(policy, { principal: ai, scopeId: SCOPE, action: 'set', resource: { kind: 'permission-mode', id: 'full-auto' } }).decision).toBe('deny');
    expect(call('edit-authority', ai)).toBe('deny');
    // R7: a team member in the same installation is not opened by the owner's command (neither mode).
    const colleague: VerifiedPrincipal = { ...f.person, id: 'colleague', subject: `${f.person.subject}-colleague` };
    expect(fullAccessGrant(policy, colleague, SCOPE).decision).not.toBe('allow');
    expect(permissionModeView(policySchema.parse(policy), colleague, SCOPE)).toMatchObject({ fullAuto: false, fullAccess: false });
    // The way back: `--modes none` removes exactly the managed rules; full-auto is refused again.
    expect(await openWitnessed(f.root, [])).toMatchObject({ status: 'applied', removed: [RULE_IDS['full-auto'], RULE_IDS['full-access']] });
    expect(await f.permissionRules()).toEqual([]);
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
  });
});

// Lead decision (Jev 0de38b48, option b): a stored full-auto is re-checked against its grant on every call, exactly like full access. A revoked grant
// — `--modes none`, a company deny on permission-mode/set, or a removed hand rule — makes the very next call behave as standart, and no surface shows
// full-auto as active while it is not in effect. Bindings, ledger, protocol and template are unchanged (the stored choice stays; it is not effective).
describe.skipIf(process.platform !== 'linux')('PRE-9 (b): a stored full-auto without its grant is standart on the very next call', () => {
  /** A narrow mutating shell command: lowered only in full-auto (the template's edit/shell rule is mode-eligible). */
  const shellCall = (policy: unknown, principal: VerifiedPrincipal) => decideAgentToolCall(policy, { principal, scopeId: SCOPE, cell: 'shell-narrow-mutating',
    tool: { name: 'run_shell' }, operation: { id: FIRST_RUN_TOOL_NAMES.shellOperationId } });
  const rewrite = async (path: string, edit: (policy: { grants: { id: string }[] }) => unknown) =>
    writeFile(path, JSON.stringify(edit(JSON.parse(await readFile(path, 'utf8')) as { grants: { id: string }[] })), { mode: 0o600 });
  async function inFullAuto(edit?: (policy: { grants: unknown[] }) => unknown, open = true) {
    const f = await freshInstallation(edit);
    if (open) await openWitnessed(f.root, ['full-auto']);
    expect(await f.set('full-auto')).toMatchObject({ result: { mode: 'full-auto' } });
    // Control: while the grant holds, full-auto lowers the call (audited relaxation).
    expect(shellCall(await f.load(), f.person)).toMatchObject({ decision: 'allow', relaxation: { mode: 'full-auto', cell: 'shell-modify' } });
    return f;
  }
  const expectStandart = async (f: Awaited<ReturnType<typeof freshInstallation>>) => {
    const policy = await f.load();
    expect(shellCall(policy, f.person)).toMatchObject({ decision: 'require-approval', relaxation: null });
    // The stored choice is still there (no bindings change) but no surface reads it as the mode in effect.
    const view = permissionModeView(policySchema.parse(policy), f.person, SCOPE);
    expect(view).toMatchObject({ mode: 'full-auto', fullAuto: false });
    expect(permissionModeStop(view, false)).toBe('standart');
  };

  it('closing with --modes none: the next call asks (standart)', async () => {
    const f = await inFullAuto();
    await openWitnessed(f.root, []);
    await expectStandart(f);
  });

  it('a company deny on permission-mode/set full-auto: the next call asks (standart)', async () => {
    const f = await inFullAuto();
    await rewrite(f.policyPath, policy => ({ ...policy, grants: [...policy.grants, { id: 'company-no-full-auto', effect: 'deny', actions: ['set'], scopes: [SCOPE], principals: 'all',
      resource: { kind: 'permission-mode', ids: ['full-auto'] } }] }));
    await expectStandart(f);
  });

  it('removing the hand rule that granted full-auto: the next call asks (standart)', async () => {
    const owner = readLocalOsIdentity();
    const f = await inFullAuto(policy => ({ ...policy, grants: [...policy.grants, { id: 'hand-full-auto', effect: 'allow', actions: ['set'], scopes: [SCOPE],
      principals: [{ issuer: owner.issuer, subject: owner.subject }], resource: { kind: 'permission-mode', ids: ['full-auto'] } }] }), false);
    await rewrite(f.policyPath, policy => ({ ...policy, grants: policy.grants.filter(rule => rule.id !== 'hand-full-auto') }));
    await expectStandart(f);
  });

  it('/mode says full-auto is no longer granted and the stored choice is not in effect (typed notice, EN and TR)', async () => {
    const view = { schemaVersion: 1 as const, scopeId: SCOPE, supported: true, mode: 'full-auto' as const, askEdits: false, revision: 'r', eligible: true, fullAccess: false, fullAuto: false };
    const port = { async inspect() { return view; }, async set(): Promise<never> { throw new Error('not called'); } };
    for (const locale of ['en', 'tr'] as const) {
      const revoked = t('terminal.mode.fullAutoRevoked', {}, locale);
      expect(revoked).not.toBe('terminal.mode.fullAutoRevoked');
      const shown = await runModeCommand('show', port, null, { current: '/mode · {mode}', changed: '{previous} → {mode}', inert: '', unsupported: 'v1', usage: 'usage', fullAutoRevoked: revoked } as never);
      expect(shown.entries.map(entry => JSON.stringify(entry)).join('\n')).toContain(revoked);
      expect(JSON.stringify(shown.entries[0])).toContain('/mode · standart');
    }
  });
});

it('hand-built policies (the live/N1 shape): only an explicitly named person; the hand rule is named and never touched', () => {
  const shape = (JSON.parse(readFileSync(new URL('../../fixtures/policy-shapes/live-2026-10-19.json', import.meta.url), 'utf8')) as { policy: { grants: PolicyGrant[] } }).policy;
  const bindings = { schemaVersion: 1, revision: 'b', bindings: [] }, person = { issuer: 'host', subject: '1000' };
  const input = { person, explicit: false, scopeId: 'live', modes: ['full-auto'], peopleLimit: 10 };
  // Without `--person` (the same rule as `init policy --upgrade`): refused, with the people the policy names.
  expect(planInstallerPermissionModes(shape, bindings, input)).toMatchObject({ status: 'unavailable', reason: 'not-first-run', people: expect.arrayContaining([person]) });
  expect(planInstallerPermissionModes(shape, bindings, { ...input, explicit: true, person: { issuer: 'host', subject: 'nobody' } })).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
  expect(planInstallerPermissionModes(shape, bindings, { ...input, explicit: true, modes: ['full-auto', 'full-access'] })).toMatchObject({ status: 'current', added: [],
    modes: [{ mode: 'full-auto', others: ['live-permission-modes'] }, { mode: 'full-access', others: ['live-permission-modes'] }] });
  expect(planInstallerPermissionModes(shape, bindings, { ...input, explicit: true, modes: [] })).toMatchObject({ status: 'current', removed: [],
    modes: [{ mode: 'full-auto', after: 'allow', others: ['live-permission-modes'] }, { mode: 'full-access', after: 'allow', others: ['live-permission-modes'] }] });
  // The MCP actor is never planned for.
  expect(planInstallerPermissionModes(shape, bindings, { ...input, explicit: true, person: mcpPrincipalRef(person) })).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
});

it('the refusal texts point to the product command for the installation owner (EN and TR), never to hand-editing the policy', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const text of [t('error.PERMISSION_MODE_DENIED', { mode: 'full-auto' }, locale), t('terminal.mode.fullAccessGrant', {}, locale), t('terminal.fullAccess.startDenied', {}, locale),
      t('tui.panel.mode.fullAutoOff', {}, locale)]) {
      expect(text, locale).toContain(COMMAND_HINT);
      expect(text).not.toMatch(/to the policy|Policy'ye bir allow grant/u);
    }
  }
});

// Guards: they pin the invariants the design relies on.
it('guard: the first-run template stays v14 and opens no mode by default (a fresh install runs standart until the owner opens one)', () => {
  const built = firstRunPolicyTemplate({ scopeId: SCOPE, principal: { issuer: 'host', subject: 'owner' }, ...FIRST_RUN_TOOL_NAMES });
  expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(16);
  expect(built.policy.schemaVersion === 2 && built.policy.grants.some(rule => rule.resource.kind === 'permission-mode')).toBe(false);
});

it('guard: the governed chain cannot open it — the delegation bound refuses a person granting themselves permission-mode/set (no-grant)', () => {
  const person = { issuer: 'host', subject: 'owner' };
  const built = firstRunPolicyTemplate({ scopeId: SCOPE, principal: person, ...FIRST_RUN_TOOL_NAMES });
  const rule = { id: RULE_IDS['full-auto'], effect: 'allow' as const, actions: ['set'], scopes: [SCOPE], principals: [person], resource: { kind: 'permission-mode', ids: ['full-auto'] } };
  expect(delegationWithin(resolvePolicyBindings(built.policy, built.bindings), person, [rule])).toEqual({ ok: false, ruleId: RULE_IDS['full-auto'], reason: 'no-grant', cell: { kind: 'permission-mode', action: 'set', id: 'full-auto', scope: SCOPE } });
});
