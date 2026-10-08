import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { evaluatePolicy } from '#domain/index.js';
import { decideAgentToolCall } from '#engine/index.js';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';

// POLICY-UPGRADE-HANDBUILT (lead 2026-10-08, Jev b6dba079): the live and N1 installations run a hand-built policy (`live-read-tools`, no
// first-run read rule), so both upgrade commands refused them and MCP calls (decided on `mcp-server` since alpha.11) were denied. The installer
// upgrade now takes `--person <issuer>/<subject>`: the file owner names a person the policy already names explicitly on an allow rule of the
// scope, and only the v5 rules that person lacks are added (archived, on the previewed revision; a second run is `current`). Real adapters, temp dirs.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PERSON = { issuer: 'DESKTOP-7NLBLGA', subject: '1000' };
const SCOPE = 'live';
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
  return { root, policyPath, bytes: () => readFile(policyPath, 'utf8'), upgrade, mcp, archive };
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
      { id: 'first-run-backup', effect: 'allow', actions: ['create', 'verify', 'restore'], scopes: 'all', principals: [PERSON], resource: { kind: 'backup', ids: 'all' } },
    ]);
    expect(await f.bytes()).toBe(before);
    expect(await f.archive()).toEqual([]);

    const applied = await f.upgrade(true, { person: PERSON, expect: preview.revision! });
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
    expect(record).toMatchObject({ state: 'committed', key: expect.stringMatching(/^policy-template-upgrade-v7-/) });
    expect(record.before.policy).toEqual(handBuilt());
    expect(record.after.policy).toEqual(after);

    const upgraded = await f.bytes();
    expect(await f.upgrade(true, { person: PERSON })).toMatchObject({ status: 'current', basis: 'named-person', rules: [] });
    expect(await f.bytes()).toBe(upgraded);
    expect(await f.archive()).toHaveLength(1);
    // After: the mcp-server resource allows; the call itself still asks on its card (the `mcp-call` hard-floor cell raises an allow).
    expect(await f.mcp()).toEqual({ server: 'allow', call: 'require-approval' });
  });

  it('refuses and writes nothing: a person the policy does not name, `all` principals only, a caller who is not the file owner, a stale --expect', async () => {
    const f = await installation();
    const before = await f.bytes();
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
      'first-run-approvals', 'first-run-secret-switch', 'first-run-backup'].includes(rule.id)).map(rule => rule.id === 'first-run-read-tools' ? { ...rule, resource: { ...rule.resource,
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
    expect(await upgradePolicyTemplateInstallation(root, SCOPE, true, 'first-run-template-v4')).toMatchObject({ status: 'upgraded' });
    expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual(v5);
    expect(await upgradePolicyTemplateInstallation(root, SCOPE, true, undefined, {}, process.getuid?.(), owner)).toMatchObject({ status: 'current', basis: 'first-run' });
  });
});
