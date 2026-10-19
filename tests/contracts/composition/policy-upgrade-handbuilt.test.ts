import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, evaluatePolicy, resolvePolicyBindings } from '#domain/index.js';
import { decideAgentToolCall } from '#engine/index.js';
import { main } from '#surfaces/index.js';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation as upgradeInstallation } from '#composition/core/installation/index.js';
import { clearConfigCache } from '#platform/index.js';

/** SEC-1 (I-POL): `init policy --upgrade --apply` is an authority write and vitest has no terminal, so this file attests the witness; the refusal
 * without one is tests/contracts/composition/policy-upgrade-witness.test.ts. */
const upgradePolicyTemplateInstallation = (...args: Parameters<typeof upgradeInstallation>) =>
  upgradeInstallation(args[0], args[1], args[2], args[3], args[4], args[5], args[6], { attest: async () => true });

// POLICY-UPGRADE-HANDBUILT (lead 2026-10-08, Jev b6dba079): the live and N1 installations run a hand-built policy (`live-read-tools`, no
// first-run read rule), so both upgrade commands refused them and MCP calls (decided on `mcp-server` since alpha.11) were denied. The installer
// upgrade now takes `--person <issuer>/<subject>`: the file owner names a person the policy already names explicitly on an allow rule of the
// scope, and only the v5 rules that person lacks are added (archived, on the previewed revision; a second run is `current`). Real adapters, temp dirs.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PERSON = { issuer: 'DESKTOP-7NLBLGA', subject: '1000' };
const SCOPE = 'live';
const MCP_PERSON = { issuer: `${PERSON.issuer}/mcp`, subject: PERSON.subject };
const grant = (id: string, kind: string, actions: string[], ids: string[] | 'all', extra: Record<string, unknown> = {}) =>
  ({ id, actions, scopes: [SCOPE], principals: [PERSON], resource: { kind, ids }, effect: 'allow', ...extra });
/** The live installation's 20 hand-built grants (2026-10-08 shape; model hashes shortened): the person is on every one. */
const HAND_BUILT = [
  { ...grant('local-monitor', 'scope', ['inspect'], ['pilot']), scopes: ['pilot'] },
  grant('live-activate', 'model-activation', ['activate', 'deactivate', 'inspect'], ['c690105a']),
  grant('live-invoke', 'model-invocation', ['invoke', 'inspect', 'cancel-invocation'], ['cfa84547']),
  grant('live-scope', 'scope', ['inspect'], [SCOPE]),
  grant('live-service-shutdown', 'service', ['shutdown'], ['local']),
  grant('live-read-tools', 'agent-tool', ['invoke'], ['read_file', 'list_dir', 'grep', 'glob']),
  grant('live-approval-inspect', 'approval', ['inspect', 'decide'], 'all'),
  grant('first-run-scratch-tools', 'agent-tool', ['invoke'], ['scratch_write', 'scratch_read', 'scratch_list']),
  grant('first-run-edit-shell-tools', 'agent-tool', ['invoke'], ['edit_file', 'write_file', 'run_shell'], { effect: 'require-approval', modeEligible: true }),
  grant('first-run-write-operation', 'operation', ['execute'], ['workspace.file.write']),
  grant('first-run-shell-operation', 'operation', ['execute'], ['host.shell.run']),
  grant('first-run-scratch-write-operation', 'operation', ['execute'], ['workspace.scratch.write']),
  grant('live-permission-modes', 'permission-mode', ['set'], ['full-auto', 'full-access']),
  grant('owner-secret-store', 'secret', ['set', 'delete'], 'all'),
  grant('owner-mcp-tools', 'agent-tool', ['invoke'], ['mcp__context7__resolve_library_id', 'mcp__context7__query_docs'], { effect: 'require-approval', modeEligible: true }),
  grant('owner-mcp-operation', 'operation', ['execute'], ['mcp.tool.call']),
  grant('live-attempt-release', 'attempt', ['release'], 'all'),
  { ...grant('owner-config-write', 'config', ['write'], 'all'), scopes: 'all' },
  { ...grant('owner-model-catalog', 'model-activation', ['activate', 'deactivate', 'inspect'], 'all'), scopes: 'all' },
  grant('owner-invoke-local-vllm', 'model-invocation', ['invoke', 'inspect', 'cancel-invocation'], ['d3b0417a']),
];
const LIVE_REVISION = 'a-419c58eb46be94c44ee1f8014d275fb122d6efa8';
const handBuilt = (grants: readonly unknown[] = HAND_BUILT) => ({ schemaVersion: 2, revision: LIVE_REVISION, roles: [], restrictions: [], separationOfDuties: [], grants });

/** A real policy-only installation (journal, identities, private files), then its policy.json replaced by a hand-built one (mode 0600). */
async function installation(policy: unknown = handBuilt()) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-handbuilt-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, SCOPE);
  const data = join(root, '.deckent'), policyPath = join(data, 'policy.json');
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath: join(data, 'bindings.json'), archivePath: join(data, 'audit', 'authority-revisions'),
    ownerUid: userInfo().uid, maxBytes: 65_536 });
  const principal = { id: 'owner@live', ...PERSON, assurance: 'os-user' as const, scopeIds: [SCOPE] };
  /** The production decisions of an MCP tool call on server `context7`: the policy evaluation of its `mcp-server` resource, and the call decision. */
  const mcp = async () => {
    const loaded = await source.load();
    return { server: evaluatePolicy(loaded, { principal, scopeId: SCOPE, action: 'invoke', resource: { kind: 'mcp-server', id: 'context7' } }).decision,
      call: decideAgentToolCall(loaded, { principal, scopeId: SCOPE, tool: { name: 'mcp__context7__query_docs' }, operation: { id: 'mcp.tool.call' }, cell: 'mcp-call',
        mcpServer: 'context7' }).decision };
  };
  const upgrade = (apply: boolean, options: { expect?: string; person?: { issuer: string; subject: string }; uid?: number } = {}) =>
    upgradePolicyTemplateInstallation(root, SCOPE, apply, options.expect, {}, options.uid ?? process.getuid?.(), options.person);
  const archive = async () => { try { return await readdir(join(data, 'audit', 'authority-revisions')); } catch { return []; } };
  /** The person's separate MCP actor (W3-AUTHORITY): one policy decision of `action` on `kind`. */
  const mcpActor = async (action: string, kind: string) => evaluatePolicy(await source.load(), { principal: { ...principal, id: 'owner@live/mcp', ...MCP_PERSON },
    scopeId: SCOPE, action, resource: { kind, id: 'any' } }).decision;
  return { root, policyPath, bytes: () => readFile(policyPath, 'utf8'), upgrade, mcp, mcpActor, archive };
}

describe.skipIf(process.platform !== 'linux')('deckent init policy --upgrade --person (hand-built policy, POLICY-UPGRADE-HANDBUILT)', () => {
  it('previews exactly the missing current template rules for the named person, applies them on the previewed revision (archived; hand-built rules byte-identical), a second apply is current, and the MCP call is then authorized on mcp-server', async () => {
    const f = await installation();
    const before = await f.bytes();
    // Before: the MCP call is refused (no mcp-server grant; the old wire-name rule no longer decides it).
    expect(await f.mcp()).toEqual({ server: 'deny', call: 'deny' });
    // Without --person: refused as before, now naming --person and the people this policy names in the scope; nothing written.
    expect(await f.upgrade(false)).toMatchObject({ status: 'unavailable', reason: 'not-first-run', people: [PERSON], rules: [] });
    expect(await f.upgrade(true)).toMatchObject({ status: 'unavailable', reason: 'not-first-run' });
    const preview = await f.upgrade(false, { person: PERSON });
    expect(preview).toMatchObject({ status: 'preview', basis: 'named-person', person: PERSON, principal: PERSON, revision: LIVE_REVISION, conflicts: [], wireRules: ['owner-mcp-tools'] });
    // Covered and skipped: approval inspect/decide (live-approval-inspect) and the mcp.tool.call operation (owner-mcp-operation).
    expect(preview.rules).toEqual([
      { id: 'first-run-mcp-servers', effect: 'allow', actions: ['invoke'], scopes: 'all', principals: [PERSON], resource: { kind: 'mcp-server', ids: 'all' } },
      { id: 'first-run-mcp-propose-tool', effect: 'allow', actions: ['invoke'], scopes: [SCOPE], principals: [PERSON], resource: { kind: 'agent-tool', ids: ['propose_mcp_server'] } },
      { id: 'first-run-policy-administer', effect: 'allow', actions: ['execute'], scopes: [SCOPE], principals: [PERSON], resource: { kind: 'operation', ids: ['policy.administer'] } },
      // v6 (owner 2026-10-08): a hand-built secret rule of set/delete does not cover the store switch; the named person gets it here.
      { id: 'first-run-secret-switch', effect: 'allow', actions: ['switch'], scopes: [SCOPE], principals: [PERSON], resource: { kind: 'secret', ids: 'all' } },
      // v7 (K3, owner 2026-10-08): activation is covered (owner-model-catalog, all/all); the live rule names one model, so model calls are added.
      { id: 'first-run-model-invocation', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: [SCOPE], principals: [PERSON],
        resource: { kind: 'model-invocation', ids: 'all' } },
      // v7 (SPEND-SETTLEMENT + stage 1): the person's spend account rule (inspect, audit, held reconcile, budget create/revision).
      { id: 'first-run-provider-spending', effect: 'allow', actions: ['inspect', 'audit', 'reconcile', 'budget-revision'], scopes: [SCOPE], principals: [PERSON],
        resource: { kind: 'provider-spend-account', ids: 'all' } },
      // v8 (BACKUP-COMMAND): installation-wide backup for the named person.
      { id: 'first-run-backup', effect: 'allow', actions: ['create', 'verify', 'restore'], scopes: 'all', principals: [PERSON], resource: { kind: 'backup', ids: 'all' } },
      // v9 (W3-AUTHORITY, owner 2026-10-09): MCP observation only, for the person's separate MCP actor `<issuer>/mcp`.
      ...['run', 'scope', 'approval', 'model-activation', 'model-invocation', 'provider-spend-account'].map(kind => ({ id: `first-run-mcp-observe-${kind}`, effect: 'allow',
        actions: ['inspect'], scopes: [SCOPE], principals: [MCP_PERSON], resource: { kind, ids: 'all' } })),
      grant('first-run-runs', 'run', ['create', 'reserve', 'inspect', 'cancel'], 'all'),
      grant('first-run-pools', 'pool', ['use', 'inspect'], 'all'),
      grant('first-run-attempts', 'attempt', ['execute', 'evaluate', 'read-output', 'recover-output', 'cancel', 'reconcile', 'release'], 'all'),
      grant('first-run-work-targets', 'work-target', ['use'], 'all'),
      grant('first-run-quota-release', 'pool', ['release-quota'], 'all', { scopes: 'all' }),
      grant('first-run-integration', 'attempt', ['prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'], 'all'),
      grant('first-run-work-target-adopt', 'work-target', ['adopt'], 'all'),
      // v12 (option A): the hand-built `live-scope` already covers scope inspection; its `local` stop rule names another service than the one
      // configured here (the fresh install's `live-runtime`), so only the service stop is added.
      grant('first-run-service-shutdown', 'service', ['shutdown'], [`${SCOPE}-runtime`]),
      // v13 (I-POL, owner A48-D3 + MON-NAMES + CA-1 + C3): `model-activation deactivate` is covered (owner-model-catalog); the other six are added,
      // the installation-wide ones over every scope, and the MCP actor gets only the pool read.
      grant('first-run-execution-environment-install', 'execution-environment', ['install'], ['docker'], { scopes: 'all' }),
      grant('first-run-installation-repair', 'installation', ['repair'], 'all', { scopes: 'all' }),
      grant('first-run-decision-inspect', 'decision', ['inspect'], 'all'),
      grant('first-run-monitor-scope-diagnostics', 'monitor', ['inspect-scope-diagnostics'], 'all', { scopes: 'all' }),
      grant('first-run-standing-grants-all', 'policy', ['inspect-standing-grants'], 'all'),
      { id: 'first-run-mcp-observe-pool', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals: [MCP_PERSON], resource: { kind: 'pool', ids: 'all' } },
    ]);
    expect(await f.bytes()).toBe(before);
    expect(await f.archive()).toEqual([]);

    const applied = await f.upgrade(true, { person: PERSON, expect: preview.expect! });
    expect(applied).toMatchObject({ status: 'upgraded', basis: 'named-person' });
    const after = JSON.parse(await f.bytes()) as { revision: string; grants: unknown[] };
    expect(applied.revision).toBe(after.revision);
    expect(after.revision).not.toBe(LIVE_REVISION);
    expect(after.grants.slice(0, HAND_BUILT.length)).toEqual(HAND_BUILT); // every hand-built rule kept, unchanged and in place
    expect(after.grants.slice(HAND_BUILT.length)).toEqual(preview.rules);
    // The authority-revision archive (the installer upgrade's backup and audit record) holds the documents before and after, committed.
    const entries = await f.archive();
    expect(entries).toHaveLength(1);
    const record = JSON.parse(await readFile(join(f.root, '.deckent', 'audit', 'authority-revisions', entries[0]!), 'utf8')) as Record<string, unknown> & {
      before: { policy: unknown }; after: { policy: unknown } };
    expect(record).toMatchObject({ state: 'committed', key: expect.stringMatching(/^policy-template-upgrade-v13-/) });
    expect(record.before.policy).toEqual(handBuilt());
    expect(record.after.policy).toEqual(after);

    const upgraded = await f.bytes();
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'current', basis: 'named-person', rules: [] });
    expect(await f.bytes()).toBe(upgraded);
    expect(await f.archive()).toHaveLength(1);
    // After: the mcp-server resource allows; the call itself still asks on its card (the `mcp-call` hard-floor cell raises an allow).
    expect(await f.mcp()).toEqual({ server: 'allow', call: 'require-approval' });
    // v9: the MCP actor observes, but a mutation the person holds (live-invoke, owner-model-catalog) is refused without a grant naming `<issuer>/mcp`.
    expect(await f.mcpActor('inspect', 'run')).toBe('allow');
    expect(await f.mcpActor('invoke', 'model-invocation')).toBe('deny');
    expect(await f.mcpActor('activate', 'model-activation')).toBe('deny');
  });

  it('upgrades the hand-built live-read-tools v9 shape to v11 and enables the /do policy chain only for its owner', async () => {
    const f = await installation();
    // Retain the older add-only upgrades in a hand-built policy; no first-run-read-tools anchor is invented.
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'upgraded' });
    const current = JSON.parse(await f.bytes()) as { grants: { id: string }[] };
    const v9 = { ...current, revision: 'hand-built-v9', grants: current.grants.filter(rule => !['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown'].includes(rule.id)) };
    await writeFile(f.policyPath, JSON.stringify(v9), { mode: 0o600 });
    expect(v9.grants.some(rule => rule.id === 'live-read-tools')).toBe(true);
    expect(v9.grants.some(rule => rule.id === 'first-run-read-tools')).toBe(false);
    const before = await f.bytes();
    const output: string[] = [], errors: string[] = [];
    const context = { root: f.root, stdout: { write: (text: string) => { output.push(text); return true; } },
      stderr: { write: (text: string) => { errors.push(text); return true; } },
      upgradePolicyTemplateInstallation: (root: string, scopeId: string, apply: boolean, expect?: string, person?: typeof PERSON) =>
        upgradePolicyTemplateInstallation(root, scopeId, apply, expect, {}, process.getuid?.(), person) };
    const argv = ['init', 'policy', '--scope', SCOPE, '--upgrade', '--person', `${PERSON.issuer}/${PERSON.subject}`, '--json'];
    expect(await main([...argv, '--preview'], context)).toBe(0); expect(errors).toEqual([]);
    const preview = JSON.parse(output.join('')) as { revision: string; expect: string; rules: { id: string }[] };
    expect(preview).toMatchObject({ status: 'preview', basis: 'named-person', template: { to: 13 } });
    expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual(['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-service-shutdown']);
    expect(await f.bytes()).toBe(before);
    output.length = 0;
    expect(await main([...argv, '--apply', '--expect', preview.expect], context)).toBe(0); expect(errors).toEqual([]);
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'upgraded' });
    const file = JSON.parse(await f.bytes());
    const policy = resolvePolicyBindings(file, JSON.parse(await readFile(join(f.root, '.deckent', 'bindings.json'), 'utf8')));
    const owner = { id: 'owner', ...PERSON, assurance: 'os-user' as const, scopeIds: [SCOPE] };
    for (const [kind, action] of [['run', 'inspect'], ['run', 'create'], ['run', 'reserve'], ['pool', 'use'], ['attempt', 'execute'], ['attempt', 'evaluate'], ['attempt', 'read-output']]) {
      const request = { principal: owner, scopeId: SCOPE, action: action!, resource: { kind: kind!, id: 'any' } };
      expect(evaluatePolicy(policy, request).decision).toBe('allow');
      expect(evaluatePolicy(policy, { ...request, principal: { ...owner, subject: '1001', id: 'stranger' } }).decision).toBe('deny');
      expect(evaluatePolicy(policy, { ...request, principal: { ...owner, ...MCP_PERSON, id: 'mcp' } }).decision).toBe(kind === 'run' && action === 'inspect' ? 'allow' : 'deny');
    }
    expect(file.grants.slice(0, v9.grants.length)).toEqual(v9.grants);
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'current' });
  });

  it('refuses and writes nothing: a person the policy does not name, `all` principals only, a caller who is not the file owner, a stale --expect', async () => {
    const f = await installation();
    const before = await f.bytes();
    expect(await f.upgrade(true, { person: MCP_PERSON })).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
    const stranger = { issuer: 'DESKTOP-7NLBLGA', subject: '1001' };
    expect(await f.upgrade(false, { person: stranger })).toMatchObject({ status: 'unavailable', reason: 'person-not-named', people: [PERSON], rules: [] });
    expect(await f.upgrade(true, { person: stranger })).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
    // Named only on a rule of another scope (`pilot`) or on an `all`-scopes rule: not named in this scope.
    const elsewhere = await installation(handBuilt([...HAND_BUILT, { ...grant('other', 'scope', ['inspect'], ['pilot']), scopes: ['pilot'], principals: [stranger] },
      { ...grant('other-config', 'config', ['write'], 'all'), scopes: 'all', principals: [stranger] }]));
    expect(await elsewhere.upgrade(true, { person: stranger })).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
    // A policy whose rules are all for `all` principals names nobody: refused for any person (9a380dee: `all` never proves a person).
    const open = await installation(handBuilt(HAND_BUILT.map(rule => ({ ...rule, principals: 'all' }))));
    const openBytes = await open.bytes();
    expect(await open.upgrade(true, { person: PERSON })).toMatchObject({ status: 'unavailable', reason: 'person-not-named', people: [] });
    expect(await open.upgrade(false)).toMatchObject({ status: 'unavailable', reason: 'not-first-run', people: [] });
    expect(await open.bytes()).toBe(openBytes);
    expect(await open.archive()).toEqual([]);
    // Another local user (not the files' owner uid): refused before anything is read.
    const other = (process.getuid?.() ?? 0) + 1;
    expect(await f.upgrade(true, { person: PERSON, uid: other })).toMatchObject({ status: 'unavailable', reason: 'not-owner', people: [] });
    expect(await f.upgrade(false, { person: PERSON, uid: other })).toMatchObject({ status: 'unavailable', reason: 'not-owner', rules: [] });
    // A stale --expect: conflict, nothing written.
    expect(await f.upgrade(true, { person: PERSON, expect: 'a-stale' })).toMatchObject({ status: 'conflict', reason: 'revision-changed', revision: LIVE_REVISION });
    // An unusable person (a control character): refused as invalid.
    expect(await f.upgrade(true, { person: { issuer: 'DESKTOP\u001b[2J', subject: '1000' } })).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    expect(await f.bytes()).toBe(before);
    expect(await f.archive()).toEqual([]);
    expect(await f.mcp()).toEqual({ server: 'deny', call: 'deny' });
  });

  it('a first-run template policy keeps today\'s behaviour; with --person it must be the person the template names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-policy-handbuilt-template-')); roots.push(root);
    await applyPolicyTemplateInstallation(root, SCOPE);
    const policyPath = join(root, '.deckent', 'policy.json');
    const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string; principals: { issuer: string; subject: string }[]; resource: { ids: unknown } }[] };
    const owner = v5.grants[0]!.principals[0]!;
    const v4 = { ...v5, revision: 'first-run-template-v4', grants: v5.grants.filter(rule => !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer',
      'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-provider-spending', 'first-run-backup', 'first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt', 'first-run-scope-inspect', 'first-run-service-shutdown'].includes(rule.id)
      && !rule.id.startsWith('first-run-mcp-observe-') && !(FIRST_RUN_CURRENT_UPGRADE_RULE_IDS as readonly string[]).includes(rule.id)).map(rule => rule.id === 'first-run-read-tools' ? { ...rule, resource: { ...rule.resource,
      ids: (rule.resource.ids as string[]).filter(name => name !== 'propose_mcp_server') } } : rule) };
    await writeFile(policyPath, `${JSON.stringify(v4)}\n`, { mode: 0o600 });
    const v4Bytes = await readFile(policyPath, 'utf8');
    const plain = await upgradePolicyTemplateInstallation(root, SCOPE, false);
    expect(plain).toMatchObject({ status: 'preview', basis: 'first-run', person: null, revision: 'first-run-template-v4' });
    // Another person on a template policy: the template's read rule does not name them; nothing is written.
    expect(await upgradePolicyTemplateInstallation(root, SCOPE, true, undefined, {}, process.getuid?.(), { issuer: owner.issuer, subject: `${owner.subject}9` }))
      .toMatchObject({ status: 'unavailable', reason: 'not-this-person' });
    expect(await readFile(policyPath, 'utf8')).toBe(v4Bytes);
    // The same person: exactly today's plan and result.
    const same = await upgradePolicyTemplateInstallation(root, SCOPE, false, undefined, {}, process.getuid?.(), owner);
    expect(same).toMatchObject({ status: 'preview', basis: 'first-run', person: owner });
    expect(same.rules).toEqual(plain.rules);
    expect(await upgradePolicyTemplateInstallation(root, SCOPE, true, plain.expect!)).toMatchObject({ status: 'upgraded' });
    expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual(v5);
    expect(await upgradePolicyTemplateInstallation(root, SCOPE, true, undefined, {}, process.getuid?.(), owner)).toMatchObject({ status: 'current', basis: 'first-run' });
  });
});

describe.skipIf(process.platform !== 'linux')('POLICY-V12 option A (owner 2026-10-16): the add-only plan carries the v12 owner rules', () => {
  it('POLICY-V12 option A: a live-read-tools shape already at v11 gets exactly the two owner rules (preview → apply), then current; an existing service rule and identity are kept', async () => {
    const V12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
    // The live shape without its own scope/service rules, upgraded to the v11 level under the previous release (the v12 rules removed again).
    const f = await installation(handBuilt(HAND_BUILT.filter(rule => !['live-scope', 'live-service-shutdown'].includes(rule.id))));
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'upgraded' });
    const upgraded = JSON.parse(await f.bytes()) as { revision: string; grants: { id: string }[] };
    await writeFile(f.policyPath, JSON.stringify({ ...upgraded, revision: 'a-live-v11', grants: upgraded.grants.filter(rule => !V12.includes(rule.id)) }), { mode: 0o600 });
    const before = await f.bytes();
    const preview = await f.upgrade(false, { person: PERSON });
    expect(preview).toMatchObject({ status: 'preview', basis: 'named-person', exact: false, revision: 'a-live-v11', serviceIdentity: { status: 'kept', identity: { scopeId: SCOPE, serviceId: `${SCOPE}-runtime` } } });
    expect(preview.rules).toEqual([
      { id: 'first-run-scope-inspect', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals: [PERSON], resource: { kind: 'scope', ids: [SCOPE] } },
      { id: 'first-run-service-shutdown', effect: 'allow', actions: ['shutdown'], scopes: [SCOPE], principals: [PERSON], resource: { kind: 'service', ids: [`${SCOPE}-runtime`] } },
    ]);
    expect(await f.bytes()).toBe(before);
    expect(await f.upgrade(true, { person: PERSON, expect: 'a-stale' })).toMatchObject({ status: 'conflict' });
    // The bare policy revision no longer suffices: the token must also bind the service identity the plan names (Astra 2596).
    expect(await f.upgrade(true, { person: PERSON, expect: 'a-live-v11' })).toMatchObject({ status: 'conflict', reason: 'service-identity-unbound', rules: [] });
    expect(await f.bytes()).toBe(before);
    expect(await f.upgrade(true, { person: PERSON, expect: preview.expect! })).toMatchObject({ status: 'upgraded', basis: 'named-person' });
    const after = JSON.parse(await f.bytes()) as { grants: { id: string }[] };
    expect(after.grants.slice(0, -2)).toEqual(JSON.parse(before).grants); // every existing rule kept, unchanged and in place
    expect(after.grants.slice(-2).map(rule => rule.id)).toEqual(V12);
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'current', basis: 'named-person', rules: [] });
    // Negatives: the MCP actor and another person are never named by the new rules; a foreign scope stays outside them.
    expect(await f.mcpActor('shutdown', 'service')).toBe('deny');
    const loaded = resolvePolicyBindings(after, JSON.parse(await readFile(join(f.root, '.deckent', 'bindings.json'), 'utf8')));
    const owner = { id: 'owner', ...PERSON, assurance: 'os-user' as const, scopeIds: [SCOPE, 'foreign'] };
    const decide = (principal: typeof owner, scopeId: string, kind: string, action: string, id: string) => evaluatePolicy(loaded, { principal, scopeId, action, resource: { kind, id } }).decision;
    expect(decide(owner, SCOPE, 'service', 'shutdown', `${SCOPE}-runtime`)).toBe('allow');
    expect(decide(owner, SCOPE, 'scope', 'inspect', SCOPE)).toBe('allow');
    expect(decide({ ...owner, subject: '1001', id: 'stranger' }, SCOPE, 'service', 'shutdown', `${SCOPE}-runtime`)).toBe('deny');
    expect(decide({ ...owner, subject: '1001', id: 'stranger' }, SCOPE, 'scope', 'inspect', SCOPE)).toBe('deny');
    expect(decide(owner, 'foreign', 'service', 'shutdown', `${SCOPE}-runtime`)).toBe('deny');
    expect(decide(owner, 'foreign', 'scope', 'inspect', 'foreign')).toBe('deny');

    // The real live shape: its own `live-scope` and a shutdown rule on the configured service `local` already cover both: nothing is added, the
    // configured identity is kept as it is.
    const live = await installation();
    const config = JSON.parse(await readFile(join(live.root, '.deckent', 'config.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(live.root, '.deckent', 'config.json'), JSON.stringify({ ...config, service: { identity: { scopeId: SCOPE, serviceId: 'local' } } }), { mode: 0o600 }); clearConfigCache();
    expect(await live.upgrade(true, { person: PERSON })).toMatchObject({ status: 'upgraded' });
    const liveBytes = await live.bytes();
    expect((JSON.parse(liveBytes) as { grants: { id: string }[] }).grants.filter(rule => V12.includes(rule.id))).toEqual([]);
    expect(await live.upgrade(true, { person: PERSON })).toMatchObject({ status: 'current', serviceIdentity: { status: 'kept', identity: { scopeId: SCOPE, serviceId: 'local' } } });
    expect(await live.bytes()).toBe(liveBytes);
  });
});
