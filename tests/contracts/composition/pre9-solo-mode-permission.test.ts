import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as installation from '#composition/core/installation/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { readLocalOsIdentity, withLocalPrincipalChannel } from '#adapters/index.js';
import { FIRST_RUN_POLICY_TEMPLATE_VERSION, delegationWithin, evaluatePolicy, firstRunPolicyTemplate, fullAccessGrant, mcpPrincipalRef, permissionModeView,
  policySchema, resolvePolicyBindings, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, PermissionModeApplication, admitFullAccessTurn, decideAgentToolCall } from '#engine/index.js';
import { getConfigFieldDefault, productResourcePath, resolveProductLayout, t } from '#platform/index.js';
import { main } from '#surfaces/index.js';

// PRE-9 SOLO-MOD-IZNI (owner 2026-10-21, "Beta öncesi ürün düzeltmesi"; lane B phase 1, RED): on a fresh solo installation the installation owner
// opens full-auto and full-access through a product command confirmed at the terminal; an AI (MCP) or a pipe cannot; the hard floor stays closed in
// full access; other people and the template default are unchanged. Design: proof/ALPHA51-2026-10-21/DESIGN-PRE9.md (option B, pending the law
// auditor). Every name the design still has to settle is in the block below, so the auditor's answer is a one-place edit.
const SCOPE = 'installation';
/** The planned composition export (installer custody, like `upgradePolicyTemplateInstallation`); absent today. */
const OPEN_EXPORT = 'openPermissionModesInstallation';
/** The planned CLI form: `deckent init policy --scope <id> --modes <set> --preview|--apply [--expect <token>]`. */
const cli = (modes: string, ...rest: string[]) => ['init', 'policy', '--scope', SCOPE, '--modes', modes, ...rest];
/** The planned managed rule ids, one per opened mode. */
const RULE_IDS = { 'full-auto': 'first-run-permission-mode-full-auto', 'full-access': 'first-run-permission-mode-full-access' } as const;
/** What the refusal texts must point to instead of "add an allow grant to the policy". */
const COMMAND_HINT = 'deckent init policy';
type OpenInput = { readonly modes: readonly string[]; readonly apply: boolean; readonly expect?: string };
type OpenResult = { readonly status: string; readonly reason?: string | null; readonly expect?: string | null; readonly rules?: readonly PolicyGrant[] };
type OpenFn = (root: string, scopeId: string, input: OpenInput, options?: object, callerUid?: number, person?: undefined, witness?: { attest(): Promise<boolean> }) => Promise<OpenResult>;
const attested = { attest: async () => true };
/** The composition export through a runtime lookup (absent today: every case fails on this, not at import, and typecheck stays green). */
function openModes(): OpenFn {
  const fn = (installation as Record<string, unknown>)[OPEN_EXPORT];
  expect(typeof fn, `${OPEN_EXPORT} is the product command's composition entry`).toBe('function');
  return fn as OpenFn;
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
  const events: unknown[] = [];
  const modes = new PermissionModeApplication(source, event => { events.push(event); }, Date.now);
  const load = async () => source.load();
  const set = async (mode: 'full-auto' | 'full-access' | 'standart') => {
    const revision = permissionModeView(policySchema.parse(await load()), person, SCOPE).revision;
    return modes.set(person, { schemaVersion: 1, scopeId: SCOPE, mode, expectedRevision: revision }).then(result => ({ result }), (error: { code?: string }) => ({ code: error.code }));
  };
  return { root, policyPath, person, load, set, events };
}
const io = () => {
  const out: string[] = [];
  return { out, sinks: { stdout: { write(value: string) { out.push(value); return true; } }, stderr: { write(value: string) { out.push(value); return true; } } } };
};

describe.skipIf(process.platform !== 'linux')('PRE-9: the installation owner opens full-auto / full-access by a confirmed product command', () => {
  it('fresh solo install: standart only; the command previews, a witnessed apply opens both modes, then the person sets them', async () => {
    const f = await freshInstallation();
    // Baseline (today's defect, and the default that stays): no grant on a fresh install.
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
    expect(permissionModeView(policySchema.parse(await f.load()), f.person, SCOPE)).toMatchObject({ fullAuto: false, fullAccess: false });

    // The product command: preview through the CLI names the rules it would add (nothing written).
    const before = await snapshot(f.root), preview = io();
    const open = openModes();
    expect(await main(cli('full-auto,full-access', '--preview', '--json'), { root: f.root, initialize() {}, [OPEN_EXPORT]: open, ...preview.sinks })).toBe(0);
    expect(preview.out.join('')).toContain(RULE_IDS['full-auto']);
    expect(await snapshot(f.root)).toEqual(before);

    // A witnessed apply (the terminal confirmation) writes exactly the two managed rules, naming this person alone, in this scope only.
    const planned = await open(f.root, SCOPE, { modes: ['full-auto', 'full-access'], apply: false });
    expect(planned).toMatchObject({ status: 'preview' });
    const applied = await open(f.root, SCOPE, { modes: ['full-auto', 'full-access'], apply: true, expect: planned.expect! }, {}, process.getuid?.(), undefined, attested);
    expect(applied).toMatchObject({ status: 'applied' });
    const written = (JSON.parse(await readFile(f.policyPath, 'utf8')) as { grants: PolicyGrant[] }).grants.filter(rule => rule.resource.kind === 'permission-mode');
    expect(written).toEqual([
      { id: RULE_IDS['full-auto'], effect: 'allow', actions: ['set'], scopes: [SCOPE], principals: [{ issuer: f.person.issuer, subject: f.person.subject }], resource: { kind: 'permission-mode', ids: ['full-auto'] } },
      { id: RULE_IDS['full-access'], effect: 'allow', actions: ['set'], scopes: [SCOPE], principals: [{ issuer: f.person.issuer, subject: f.person.subject }], resource: { kind: 'permission-mode', ids: ['full-access'] } },
    ]);
    // The same set again changes nothing.
    expect(await open(f.root, SCOPE, { modes: ['full-auto', 'full-access'], apply: false })).toMatchObject({ status: 'current' });

    // The person now opens the modes through the existing mode application (and a full-access turn is admitted).
    expect(permissionModeView(policySchema.parse(await f.load()), f.person, SCOPE)).toMatchObject({ fullAuto: true, fullAccess: true });
    expect(await f.set('full-auto')).toMatchObject({ result: { mode: 'full-auto', changed: true } });
    expect(admitFullAccessTurn(await f.load(), { principal: f.person, scopeId: SCOPE, turnId: 't1', sessionId: null, eventId: 'e1', atMs: 1 }).allowed).toBe(true);
  });

  it('a pipe (no controlling terminal) and the MCP actor cannot open the modes: typed refusal, every file byte-identical', async () => {
    const f = await freshInstallation(), before = await snapshot(f.root);
    const cliRun = io();
    // vitest has no controlling terminal: the CLI apply is refused for the witness, not as an unknown flag.
    expect(await main(cli('full-auto,full-access', '--apply', '--json'), { root: f.root, initialize() {}, [OPEN_EXPORT]: (installation as Record<string, unknown>)[OPEN_EXPORT], ...cliRun.sinks }))
      .not.toBe(0);
    expect(cliRun.out.join('')).toContain('AUTHORITY_WITNESS_REQUIRED');
    const open = openModes();
    await expect(open(f.root, SCOPE, { modes: ['full-auto'], apply: true })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(withLocalPrincipalChannel('mcp', () => open(f.root, SCOPE, { modes: ['full-auto'], apply: true }, {}, process.getuid?.(), undefined, attested)))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await snapshot(f.root)).toEqual(before);
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
  });

  it('a company deny on permission-mode/set wins: the command refuses and writes nothing', async () => {
    const f = await freshInstallation(policy => ({ ...policy, grants: [...policy.grants, { id: 'company-no-full-access', effect: 'deny', actions: ['set'], scopes: [SCOPE],
      principals: 'all', resource: { kind: 'permission-mode', ids: ['full-access'] } }] }));
    const before = await snapshot(f.root), open = openModes();
    expect(await open(f.root, SCOPE, { modes: ['full-access'], apply: false })).toMatchObject({ status: 'refused' });
    expect(await open(f.root, SCOPE, { modes: ['full-access'], apply: true }, {}, process.getuid?.(), undefined, attested)).toMatchObject({ status: 'refused' });
    expect(await snapshot(f.root)).toEqual(before);
  });

  it('after opening: the hard floor stays closed in full access, AI stays denied, another person stays standart; --modes none closes', async () => {
    const f = await freshInstallation(), open = openModes();
    const planned = await open(f.root, SCOPE, { modes: ['full-auto', 'full-access'], apply: false });
    await open(f.root, SCOPE, { modes: ['full-auto', 'full-access'], apply: true, expect: planned.expect! }, {}, process.getuid?.(), undefined, attested);
    const policy = await f.load();
    const call = (cell: 'edit-authority' | 'mcp-floor' | 'shell-destructive', principal: VerifiedPrincipal = f.person, snapshotPolicy: unknown = policy) => decideAgentToolCall(snapshotPolicy, {
      principal, scopeId: SCOPE, fullAccess: true, cell,
      ...(cell === 'mcp-floor' ? { tool: { name: 'mcp__srv__drop' }, mcpServer: 'srv', operation: { id: FIRST_RUN_TOOL_NAMES.mcpCallOperationId } }
        : cell === 'edit-authority' ? { tool: { name: 'edit_file' }, operation: { id: FIRST_RUN_TOOL_NAMES.writeOperationId } }
          : { tool: { name: 'run_shell' }, operation: { id: FIRST_RUN_TOOL_NAMES.shellOperationId } }) }).decision;
    // Full access really works (destructive shell without a card) — and still never lowers the configuration write or the MCP ask pin.
    expect(call('shell-destructive')).toBe('allow');
    expect(call('edit-authority')).toBe('require-approval');
    expect(call('mcp-floor')).toBe('require-approval');
    // A company deny is never lowered by full access.
    const denied = policySchema.parse(policy);
    const withDeny = { ...denied, grants: [...(denied.schemaVersion === 2 ? denied.grants : []), { id: 'company-no-shell', effect: 'deny', actions: ['execute'], scopes: [SCOPE], principals: 'all',
      resource: { kind: 'operation', ids: [FIRST_RUN_TOOL_NAMES.shellOperationId] } }] };
    expect(call('shell-destructive', f.person, withDeny)).toBe('deny');
    // The AI (MCP) actor: no mode, and the hard-floor cells are denied outright.
    const ai: VerifiedPrincipal = { ...f.person, ...mcpPrincipalRef(f.person), assurance: 'workload-verified' };
    expect(evaluatePolicy(policy, { principal: ai, scopeId: SCOPE, action: 'set', resource: { kind: 'permission-mode', id: 'full-auto' } }).decision).toBe('deny');
    expect(call('edit-authority', ai)).toBe('deny');
    // Another person in the same installation (a team member) is not opened by the owner's command.
    const colleague: VerifiedPrincipal = { ...f.person, id: 'colleague', subject: `${f.person.subject}-colleague` };
    expect(fullAccessGrant(policy, colleague, SCOPE).decision).not.toBe('allow');
    // The way back: `--modes none` removes exactly the managed rules; full-auto is refused again.
    const closing = await open(f.root, SCOPE, { modes: [], apply: false });
    expect(await open(f.root, SCOPE, { modes: [], apply: true, expect: closing.expect! }, {}, process.getuid?.(), undefined, attested)).toMatchObject({ status: 'applied' });
    expect((JSON.parse(await readFile(f.policyPath, 'utf8')) as { grants: PolicyGrant[] }).grants.some(rule => rule.resource.kind === 'permission-mode')).toBe(false);
    expect(await f.set('full-auto')).toEqual({ code: 'PERMISSION_MODE_DENIED' });
  });
});

it('the refusal texts point to the product command (EN and TR), never to hand-editing the policy', () => {
  for (const locale of ['en', 'tr'] as const) {
    const denied = t('error.PERMISSION_MODE_DENIED', { mode: 'full-auto' }, locale), grant = t('terminal.mode.fullAccessGrant', {}, locale);
    expect(denied, `${locale} PERMISSION_MODE_DENIED`).toContain(COMMAND_HINT);
    expect(grant, `${locale} fullAccessGrant`).toContain(COMMAND_HINT);
  }
  expect(t('error.PERMISSION_MODE_DENIED', { mode: 'full-auto' }, 'en')).not.toMatch(/to the policy/u);
});

// Guards (green today; they pin the invariants the design relies on).
it('guard: the first-run template stays v13 and opens no mode by default (a fresh install runs standart until the owner opens one)', () => {
  const person = { issuer: 'host', subject: 'owner' };
  const built = firstRunPolicyTemplate({ scopeId: SCOPE, principal: person, ...FIRST_RUN_TOOL_NAMES });
  expect(FIRST_RUN_POLICY_TEMPLATE_VERSION).toBe(13);
  expect(built.policy.schemaVersion === 2 && built.policy.grants.some(rule => rule.resource.kind === 'permission-mode')).toBe(false);
});

it('guard: the governed chain cannot open it — the delegation bound refuses a person granting themselves permission-mode/set (no-grant)', () => {
  const person = { issuer: 'host', subject: 'owner' };
  const built = firstRunPolicyTemplate({ scopeId: SCOPE, principal: person, ...FIRST_RUN_TOOL_NAMES });
  const policy = resolvePolicyBindings(built.policy, built.bindings);
  const rule = { id: RULE_IDS['full-auto'], effect: 'allow' as const, actions: ['set'], scopes: [SCOPE], principals: [person], resource: { kind: 'permission-mode', ids: ['full-auto'] } };
  expect(delegationWithin(policy, person, [rule])).toEqual({ ok: false, ruleId: RULE_IDS['full-auto'], reason: 'no-grant' });
});
