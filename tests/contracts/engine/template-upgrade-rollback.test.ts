import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, POLICY_RECOVERY_CHANGE_KIND, RECOVERY_ROLLOUT, firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, NERVOUS_EXECUTABLE_ACTIONS, PolicyAdministrationApplication, PolicyTemplateUpgrade, RecoveryPolicyCard, administerOwnPolicyChange, nervousStandingApproval,
  upgradePolicyTemplate, upgradeFirstRunProposalRules } from '#engine/index.js';
import { createHmacIntegrity, sha256 } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, auditEventSchema, evaluatePolicy, mcpPrincipalRef, policyChangeSchema, policyGrantSchema, policySchema } from '#domain/index.js';
import { ModelInvocationPolicyAuthorization } from '#engine/core/policy/index.js';

const names = { firstCommitOperationId: 'coding.first-commit', uninstallOperationIds: ['installation.remove-cache', 'installation.remove-data', 'installation.remove-image', 'installation.remove-service'], proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer', executionEnvironmentIds: ['docker'],
  recoveryRules: RECOVERY_ROLLOUT.rules.map(id => ({ id, version: 1 })), readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
// alpha.56 D1: the rolled-back delta is v16's recovery cells (require-approval); it was v15's (S4B-1 + S4B-3 + S8) through v15, v14's two memory reads through v14.
const deltaIds: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(edit: (grants: readonly PolicyGrant[]) => readonly unknown[] = grants => grants, seededUpgrade = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-template-rollback-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const }, ledger = join(root, 'ledger.db');
  openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock), { principal } = await sessions.verifySession(undefined);
  const template = firstRunPolicyTemplate({ scopeId: 's', principal, ...names });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'authority-revisions');
  const original = { ...template.policy, revision: 'first-run-template-v10', grants: template.policy.grants.filter(rule => !deltaIds.includes(rule.id)) };
  await writeFile(policyPath, JSON.stringify(seededUpgrade ? original : template.policy), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  // 128 KiB (product default 1 MiB): an archive entry holds the policy twice, and the v15 template (S4B-3) outgrew a 64 KiB entry.
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 131_072 });
  if (seededUpgrade) expect(await upgradePolicyTemplate(source, { scopeId: 's', principal, apply: true, owner: true, peopleLimit: 10, now: () => 1000, audit: () => undefined,
    toolNames: names })).toMatchObject({ status: 'upgraded' });
  const edited = edit(template.policy.grants);
  if (JSON.stringify(edited) !== JSON.stringify(template.policy.grants)) await source.updateAuthority(() => ({ write: { policy: { ...template.policy, revision: 'a-custom', grants: edited }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-custom');
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
  const integrity = createHmacIntegrity('key', randomBytes(32)), events: AuditEvent[] = [];
  const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
    requestTtlMs: 60_000, audit: event => { events.push(event); } });
  let cards = 0;
  const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => {
    cards++;
    expect(journal.store.list('s', null, 10)).toHaveLength(cards);
    return new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source, integrity, clock, 'local-runtime', 10, undefined, undefined, { interactive: async () => true })
      .decide({ schemaVersion: 1, scopeId: 's', approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
  };
  const upgrade = new PolicyTemplateUpgrade({ administration, approve, policy: source }, names);
  return { principal, administration, approve, apply: () => upgrade.run({ scopeId: 's', principal, mode: 'apply', reason: 'v14 upgrade' }), source, events, archive, get cards() { return cards; }, bytes: () => readFile(policyPath, 'utf8'),
    rollback: (expect?: string) => upgrade.run({ scopeId: 's', principal, mode: 'rollback', reason: 'v14 rollback', ...(expect ? { expect } : {}) }) };
}

describe.skipIf(process.platform !== 'linux')('v20 rollback through the real approval and archived authority writer', () => {
  it('approves the operation card, removes only v20 rules, preserves the only administration grants, and refuses stale replay', async () => {
    const f = await fixture(), beforeBytes = await f.bytes(), before = JSON.parse(beforeBytes);
    expect(deltaIds).toEqual(['first-run-mcp-propose-work', 'first-run-mcp-propose-setting', 'first-run-mcp-propose-pool', 'first-run-mcp-propose-target']);
    expect(await f.rollback('stale')).toMatchObject({ status: 'conflict' });
    expect(f.cards).toBe(0); expect(await f.bytes()).toBe(beforeBytes);
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(',') });
    expect(f.cards).toBe(1);
    const after = JSON.parse(await f.bytes());
    expect(after.grants).toEqual(before.grants.filter((grant: { id: string }) => !deltaIds.includes(grant.id)));
    expect(after.grants.some((grant: { id: string }) => grant.id === 'first-run-policy-administer')).toBe(true);
    for (const id of ['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets', 'first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt',
      'first-run-scope-inspect', 'first-run-service-shutdown', 'first-run-model-activation', 'first-run-decision-inspect', 'first-run-installation-repair']) expect(after.grants.find((grant: { id: string }) => grant.id === id)).toEqual(before.grants.find((grant: { id: string }) => grant.id === id));
    expect(after.grants.some((grant: { id: string }) => grant.id === 'first-run-approvals')).toBe(true);
    expect(f.events.filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
    const entries = await readdir(f.archive); expect(entries).toHaveLength(2);
    const receipts = await Promise.all(entries.map(async name => JSON.parse(await readFile(join(f.archive, name), 'utf8'))));
    const receipt = receipts.find(entry => entry.before.policy.revision === before.revision);
    expect(receipt).toMatchObject({ state: 'committed', before: { policy: before }, after: { policy: after } });
    const kept = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'nothing-to-roll-back' });
    expect(await f.bytes()).toBe(kept); expect(f.cards).toBe(1);
  });

  it('preserves a modified current-version rule carrying the only administration authority and reports its conflict', async () => {
    const modified = deltaIds[0]!;
    // v20's delta names the MCP actor: the modified rule is moved to the person so it carries their only administration authority.
    const f = await fixture(grants => grants.filter(rule => rule.id !== 'first-run-policy-administer').map(rule => rule.id === modified
      ? { ...rule, effect: 'allow', principals: grants.find(item => item.id === 'first-run-read-tools')!.principals, actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } } : rule));
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', conflicts: [modified], reason: deltaIds.slice(1).join(',') });
    const after = JSON.parse(await f.bytes());
    expect(after.grants.find((rule: { id: string }) => rule.id === modified)).toEqual(JSON.parse(before).grants.find((rule: { id: string }) => rule.id === modified));
    expect(f.cards).toBe(1);
    expect(after.grants.some((rule: { id: string }) => deltaIds.slice(1).includes(rule.id))).toBe(false);
  });

  it('refuses rollback through I2 when a deny on a delta cell binds the person', async () => {
    const f = await fixture(grants => [...grants, { ...grants.find(rule => rule.id === deltaIds[0])!, id: 'run-card', effect: 'deny', principals: grants.find(item => item.id === 'first-run-read-tools')!.principals }]);
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: ['delegation'] });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0); expect(f.events).toEqual([]);
  });
});

it.skipIf(process.platform !== 'linux')('POLICY-V12 rule, v20 delta: a delta the installer (or the S6 start upgrade) added under template v20 is rollbackable; an older or future key does not count', async () => {
  const seed = async (version: number) => {
    const f = await fixture(undefined, false), current = JSON.parse(await f.bytes());
    await f.source.updateAuthority(() => ({ write: { policy: { ...current, revision: 'a-older', grants: current.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id)) },
      bindings: null, order: 'policy-first' }, result: null }), 'fixture-older');
    // The installer upgrade's own key shape (`policy-template-upgrade-v<version>-<64 hex>`), as a v16 installer writes it.
    await f.source.updateAuthority(() => ({ write: { policy: { ...current, revision: 'a-upgraded' }, bindings: null, order: 'policy-first' }, result: null }),
      `policy-template-upgrade-v${version}-${'a'.repeat(64)}`);
    return f;
  };
  const v20 = await seed(20);
  expect(await v20.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  // Owner S6 (2026-11-09): the service start's own upgrade of an exact v19 policy adds exactly v20's rules, no card, audited, under that installer key;
  // a second start is current, an already-v20 or hand-built policy is left alone, and once the person rolled them back they are never re-added.
  const auto = await fixture(undefined, false), events: AuditEvent[] = [], audit = { openAudit: async () => ({ record: (event: AuditEvent) => { events.push(event); }, close: () => undefined }), now: () => 5 };
  const run = async () => upgradeFirstRunProposalRules(auto.source, { person: auto.principal, history: (await auto.source.authorityHistory())!, ...audit });
  expect(await run()).toBe('current'); expect(events).toEqual([]); // a fresh v20 install: nothing to add, nothing written
  const v20Bytes = JSON.parse(await auto.bytes()), v19Policy = { ...v20Bytes, revision: 'first-run-template-v19', grants: v20Bytes.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id)) };
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify(v19Policy), { mode: 0o600 });
  expect(await run()).toBe('upgraded');
  const upgraded = JSON.parse(await auto.bytes());
  expect(upgraded.grants).toEqual([...v19Policy.grants, ...v20Bytes.grants.filter((rule: { id: string }) => deltaIds.includes(rule.id))]);
  // The Run and setting proposals are cards no mode lowers; the proposed Run's pool and work-target use are allow (lead 2026-11-09 option 2).
  expect(upgraded.grants.filter((rule: { id: string }) => deltaIds.includes(rule.id)).map((rule: PolicyGrant) => [rule.effect, rule.modeEligible])).toEqual([['require-approval', undefined], ['require-approval', undefined], ['allow', undefined], ['allow', undefined]]);
  expect(events.map(event => event.subject)).toMatchObject([{ kind: 'authority-change', installer: { basis: 'first-run', template: { version: 20 } }, counts: { grantsAdded: 4, grantsRemoved: 0 },
    revision: { before: 'first-run-template-v19', after: upgraded.revision }, commandId: expect.stringMatching(/^policy-template-upgrade-v20-[a-f0-9]{64}$/u) }]);
  expect(await run()).toBe('current'); expect(events).toHaveLength(1);
  expect(await auto.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(',') }); // the person revokes them on the card
  const revoked = await auto.bytes();
  expect(await run()).toBe('current'); expect(await auto.bytes()).toBe(revoked); expect(events).toHaveLength(1); // never re-added
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify({ ...v19Policy, revision: 'hand-built', grants: v19Policy.grants.filter((rule: { id: string }) => rule.id !== 'first-run-read-tools') }), { mode: 0o600 });
  expect(await upgradeFirstRunProposalRules(auto.source, { person: auto.principal, history: [], ...audit })).toBe('skipped');
  // A hand-built (live-shape) policy is anchored on the configured service scope where an allow rule names the person; another person's is never touched.
  expect(await upgradeFirstRunProposalRules(auto.source, { person: { issuer: auto.principal.issuer, subject: 'someone-else' }, history: [], scopeId: 's', ...audit })).toBe('skipped');
  expect(await upgradeFirstRunProposalRules(auto.source, { person: auto.principal, history: [], scopeId: 's', ...audit })).toBe('upgraded');
  expect(events.at(-1)!.subject).toMatchObject({ kind: 'authority-change', installer: { basis: 'named-person', template: { version: 20 } }, counts: { grantsAdded: 4 } });
  expect(events.at(-1)!.subject).not.toHaveProperty('skipped');
  // Lead 2026-11-09 (side effect B): an MCP actor that holds the `work` group keeps its allows. The upgrade adds only the setting rule and names the
  // three it left to the group in the audit record; the actor's create_run stays allow (no card) and its reserve and pool use are unchanged.
  const ai = mcpPrincipalRef(auto.principal), work = ['run', 'pool', 'work-target'].map(kind => ({ id: `mcp-cap-work-${kind}`, effect: 'allow', actions: kind === 'run' ? ['create', 'inspect', 'reserve', 'cancel'] : ['use'],
    scopes: ['s'], principals: [ai], resource: { kind, ids: kind === 'pool' ? ['p'] : 'all' } }));
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify({ ...v19Policy, revision: 'a-work-group', grants: [...v19Policy.grants, ...work] }), { mode: 0o600 });
  // The person as the service start passes it (issuer and subject: proposal-policy.ts), so the record is checked against the sealed audit contract.
  expect(await upgradeFirstRunProposalRules(auto.source, { person: { issuer: auto.principal.issuer, subject: auto.principal.subject }, history: [], ...audit })).toBe('upgraded');
  expect(events.at(-1)!.subject).toMatchObject({ counts: { grantsAdded: 1 }, skipped: [{ ruleId: 'first-run-mcp-propose-work', heldBy: 'mcp-cap-work-run' },
    { ruleId: 'first-run-mcp-propose-pool', heldBy: 'mcp-cap-work-pool' }, { ruleId: 'first-run-mcp-propose-target', heldBy: 'mcp-cap-work-work-target' }] });
  expect(auditEventSchema.parse(events.at(-1)).subject).toMatchObject({ skipped: [{ ruleId: 'first-run-mcp-propose-work' }, {}, {}] }); // the sealed audit contract carries the reasons
  const grouped = await auto.source.load(), actor = { id: 'mcp', ...ai, assurance: 'workload-verified' as const, scopeIds: ['s'] };
  for (const [action, kind, id] of [['create', 'run', 'r'], ['reserve', 'run', 'r'], ['use', 'pool', 'p'], ['use', 'work-target', 't']] as const)
    expect(evaluatePolicy(grouped, { principal: actor, scopeId: 's', action, resource: { kind, id } }).decision, `${kind}/${action}`).toBe('allow');
  for (const version of [19, 21]) {
    const other = await seed(version), before = await other.bytes();
    expect(await other.rollback()).toMatchObject({ status: 'nothing-to-roll-back', conflicts: deltaIds });
    expect(await other.bytes()).toBe(before); expect(other.cards).toBe(0);
  }
});

it.skipIf(process.platform !== 'linux')('POLICY-V12 option A: a governed delta upgrade whose plan did not carry the v12 rules stays rollbackable', async () => {
  const v12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
  const f = await fixture(undefined, false), current = JSON.parse(await f.bytes());
  const older = { ...current, revision: 'a-older', grants: current.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id) && !v12.includes(rule.id)) };
  await f.source.updateAuthority(() => ({ write: { policy: older, bindings: null, order: 'policy-first' }, result: null }), 'fixture-older');
  // The key the governed chain wrote then: its plan was exactly the delta (no v12 rules), bound by the effect wire key.
  const rules = current.grants.filter((rule: { id: string }) => deltaIds.includes(rule.id));
  const change = policyChangeSchema.parse({ schemaVersion: 1, changes: rules.map((grant: unknown) => ({ kind: 'grant.add', grant: policyGrantSchema.parse(grant) })) });
  const tag = `template-v5:${deltaIds.join(',')}`;
  // The governed chain binds the resolved (policy + bindings) revision it read.
  const resolved = 'a-older+first-run-template-v20-bindings';
  const commandId = sha256(`policy-template-upgrade:1\0s\0${f.principal.issuer}\0${f.principal.subject}\0${tag}\0${resolved}`);
  const key = effectWireKey({ schemaVersion: 1, commandId, scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation,
    target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: resolved });
  await f.source.updateAuthority(() => ({ write: { policy: { ...older, revision: 'a-governed', grants: [...older.grants, ...rules] }, bindings: null, order: 'policy-first' }, result: null }), key);
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
});

it.skipIf(process.platform !== 'linux')('Astra 2596: a governed upgrade that named the configured service `local` stays rollbackable under the historical identity, not today\'s default', async () => {
  const v12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
  const f = await fixture(undefined, false), current = JSON.parse(await f.bytes());
  const older = { ...current, revision: 'a-older', grants: current.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id) && !v12.includes(rule.id)) };
  await f.source.updateAuthority(() => ({ write: { policy: older, bindings: null, order: 'policy-first' }, result: null }), 'fixture-older');
  // The plan the governed chain submitted then: the delta and both owner rules, the stop rule naming the then-configured service `local`.
  const rules = current.grants.filter((rule: { id: string }) => deltaIds.includes(rule.id) || v12.includes(rule.id))
    .map((rule: { id: string; resource: object }) => rule.id === v12[1] ? { ...rule, resource: { kind: 'service', ids: ['local'] } } : rule);
  const change = policyChangeSchema.parse({ schemaVersion: 1, changes: rules.map((grant: unknown) => ({ kind: 'grant.add', grant: policyGrantSchema.parse(grant) })) });
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = 'a-older+first-run-template-v20-bindings';
  const commandId = sha256(`policy-template-upgrade:1\0s\0${f.principal.issuer}\0${f.principal.subject}\0${tag}\0${resolved}`);
  const key = effectWireKey({ schemaVersion: 1, commandId, scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation,
    target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: resolved });
  await f.source.updateAuthority(() => ({ write: { policy: { ...older, revision: 'a-governed', grants: [...older.grants, ...rules] }, bindings: null, order: 'policy-first' }, result: null }), key);
  // The fixture's upgrade carries no service id today (default `s-runtime`): the entry's own `local` decides whether it was this upgrade.
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  expect(JSON.parse(await f.bytes()).grants.find((rule: { id: string }) => rule.id === v12[1])?.resource).toEqual({ kind: 'service', ids: ['local'] });
});

it.skipIf(process.platform !== 'linux')('Astra 2598: a governed upgrade whose `local` stop was covered by another allow ([delta, scope-inspect]) stays rollbackable when today\'s id differs', async () => {
  const v12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
  const f = await fixture(undefined, false), current = JSON.parse(await f.bytes());
  const ownStop = { id: 'own-stop', effect: 'allow', actions: ['shutdown'], scopes: ['s'], principals: [{ issuer: f.principal.issuer, subject: f.principal.subject }], resource: { kind: 'service', ids: ['local'] } };
  const older = { ...current, revision: 'a-older', grants: [...current.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id) && !v12.includes(rule.id)), ownStop] };
  await f.source.updateAuthority(() => ({ write: { policy: older, bindings: null, order: 'policy-first' }, result: null }), 'fixture-older');
  // Then the configured service was `local`, covered by `own-stop`: the plan was the delta and scope inspection only, no stop rule.
  const rules = current.grants.filter((rule: { id: string }) => deltaIds.includes(rule.id) || rule.id === v12[0]);
  const change = policyChangeSchema.parse({ schemaVersion: 1, changes: rules.map((grant: unknown) => ({ kind: 'grant.add', grant: policyGrantSchema.parse(grant) })) });
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = 'a-older+first-run-template-v20-bindings';
  const commandId = sha256(`policy-template-upgrade:1\0s\0${f.principal.issuer}\0${f.principal.subject}\0${tag}\0${resolved}`);
  const key = effectWireKey({ schemaVersion: 1, commandId, scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation,
    target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: resolved });
  await f.source.updateAuthority(() => ({ write: { policy: { ...older, revision: 'a-governed', grants: [...older.grants, ...rules] }, bindings: null, order: 'policy-first' }, result: null }), key);
  // Today the fixture names no service (default `s-runtime`, not covered by `own-stop`): the recomputed plan would carry a stop rule.
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  const after = JSON.parse(await f.bytes()) as { grants: { id: string }[] };
  expect(after.grants.map(rule => rule.id)).toEqual(expect.arrayContaining(['own-stop', v12[0]]));
  expect(after.grants.some(rule => deltaIds.includes(rule.id))).toBe(false);
});

it.skipIf(process.platform !== 'linux')('rollback removes a fresh install\'s own v20 delta, detects changed-then-restored content, and refuses missing history without a card or write', async () => {
  // Owner 2026-11-05 (R4a, amends J3): on a provably fresh install the same card removes exactly the latest MCP-actor delta (v20 since alpha.64); the person's
  // other rules stay, the AI's Run proposal is refused by policy afterwards (owner S6: revoking stops the proposals), and `--apply` re-adds the same rules.
  const fresh = await fixture(undefined, false), initial = JSON.parse(await fresh.bytes()) as { grants: { id: string }[] };
  const mcp = { ...fresh.principal, id: 'mcp', ...mcpPrincipalRef(fresh.principal), assurance: 'workload-verified' as const };
  const invoke = () => new ModelInvocationPolicyAuthorization(fresh.source).authorize('invoke', { scopeId: 's', reference: { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 } }, mcp);
  const propose = async () => evaluatePolicy(await fresh.source.load(), { principal: { ...mcp, scopeIds: ['s'] }, scopeId: 's', action: 'create', resource: { kind: 'run', id: 'r' } }).decision;
  expect(await invoke()).toMatchObject({ ruleId: 'first-run-mcp-model-invocation' }); expect(await propose()).toBe('require-approval');
  expect(await fresh.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  expect(fresh.cards).toBe(1);
  expect((JSON.parse(await fresh.bytes()) as typeof initial).grants).toEqual(initial.grants.filter(rule => !deltaIds.includes(rule.id)));
  expect(await propose()).toBe('deny'); expect(await invoke()).toMatchObject({ ruleId: 'first-run-mcp-model-invocation' }); // v19's rules stay installed
  expect(await fresh.apply()).toMatchObject({ status: 'upgraded' }); expect(fresh.cards).toBe(2);
  const readded = (JSON.parse(await fresh.bytes()) as typeof initial).grants;
  expect(readded.filter(rule => deltaIds.includes(rule.id))).toEqual(initial.grants.filter(rule => deltaIds.includes(rule.id)));
  expect(readded.filter(rule => !deltaIds.includes(rule.id))).toEqual(initial.grants.filter(rule => !deltaIds.includes(rule.id)));
  expect(await propose()).toBe('require-approval');
  expect(await fresh.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(',') });
  // NEGATIVE: the same template policy with an older bindings revision (an exact installer upgrade whose archive is gone) is not provably fresh.
  const stale = await fixture(undefined, false), staleBytes = await stale.bytes();
  const bindingsPath = join(dirname(stale.archive), 'bindings.json'), bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
  await writeFile(bindingsPath, JSON.stringify({ ...bindings, revision: 'first-run-template-v12-bindings' }), { mode: 0o600 });
  expect(await stale.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await stale.bytes()).toBe(staleBytes); expect(stale.cards).toBe(0);
  // NEGATIVE (Astra 2672 N1): the template's revision and bindings but one expected v15 rule deleted by hand, no archive: not provably fresh.
  const edited = await fixture(undefined, false), policyPath = join(dirname(edited.archive), 'policy.json'), held = JSON.parse(await readFile(policyPath, 'utf8'));
  await writeFile(policyPath, JSON.stringify({ ...held, grants: held.grants.filter((rule: { id: string }) => rule.id !== deltaIds[0]) }), { mode: 0o600 });
  const editedBytes = await edited.bytes();
  expect(await edited.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await edited.bytes()).toBe(editedBytes); expect(edited.cards).toBe(0);
  const restored = await fixture(), before = JSON.parse(await restored.bytes());
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-edited', grants: before.grants.map((rule: { id: string }) =>
    rule.id === deltaIds[0] ? { ...rule, scopes: ['other'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-edited');
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-restored' }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-restored');
  expect(await restored.rollback()).toMatchObject({ status: 'rolled-back', conflicts: [deltaIds[0]], reason: deltaIds.slice(1).join(',') });
  expect(restored.cards).toBe(1);
  expect(JSON.parse(await restored.bytes()).grants.some((rule: { id: string }) => rule.id === deltaIds[0])).toBe(true);
  // Hand-built (no first-run read anchor): the person still holds the tool cells the v20 MCP rule delegates (I2 needs them to revoke it).
  const handBuilt = await fixture(grants => grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule));
  expect(await handBuilt.rollback()).toMatchObject({ status: 'rolled-back', conflicts: [] });
  expect(handBuilt.cards).toBe(1);
  const governed = await fixture(undefined, false), snapshot = JSON.parse(await governed.bytes());
  await governed.source.updateAuthority(state => ({ write: {
    policy: { ...snapshot, revision: 'a-rooted', grants: snapshot.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id)),
      roles: [{ id: 'admin', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(resource => resource.kind)) }] },
    bindings: { ...(state.bindings as object), revision: 'a-rooted', bindings: [{ id: 'admin', roles: ['admin'], scopes: 'all',
      principals: [{ issuer: governed.principal.issuer, subject: governed.principal.subject }] }] }, order: 'policy-first' }, result: null }), 'fixture-rooted');
  expect(await governed.apply()).toMatchObject({ status: 'upgraded' });
  expect(await governed.rollback()).toMatchObject({ status: 'rolled-back', conflicts: [] });
  expect(governed.cards).toBe(2);
  const damaged = await fixture(), bytes = await damaged.bytes();
  await rm(damaged.archive, { recursive: true });
  expect(await damaged.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await damaged.bytes()).toBe(bytes); expect(damaged.cards).toBe(0);
});

// alpha.56 D1: the raise through the real chain (approval card, delegation-bound gate, bound inside the write lock, audit, archive).
it.skipIf(process.platform !== 'linux')('the recovery card raises its v16 cell through the real policy.administer chain; the same replace on another path is refused', async () => {
  const f = await fixture(undefined, false), cell = 'first-run-recovery-action-fence-attempt';
  const before = policySchema.parse(await f.source.load()), ask = before.grants.find(rule => rule.id === cell)!;
  expect(ask.effect).toBe('require-approval'); expect(nervousStandingApproval(before, f.principal, { scopeId: 's', action: 'fence-attempt' }, 1)).toBeNull();
  // Negative first: the same replace declared as a standing change keeps today's bound (POLICY_DELEGATION_EXCEEDS at the gate), nothing written.
  await expect(administerOwnPolicyChange(f, { scopeId: 's', principal: f.principal, change: { schemaVersion: 1, changes: [{ kind: 'grant.replace', grant: { ...ask, effect: 'allow' } }] },
    tag: 'd1-negative', reason: 'standing path', revision: before.revision, kind: 'standing-change' })).rejects.toMatchObject({ code: 'POLICY_DELEGATION_EXCEEDS' });
  expect(policySchema.parse(await f.source.load()).revision).toBe(before.revision);
  // Audit cbbe28b5f: a policy-recovery set that pairs the raise with an added require-approval on the same cell is refused at the gate, nothing written.
  await expect(administerOwnPolicyChange(f, { scopeId: 's', principal: f.principal, change: { schemaVersion: 1, changes: [{ kind: 'grant.replace', grant: { ...ask, effect: 'allow' } },
    { kind: 'grant.add', grant: { ...ask, id: 'd1-shadow-ask' } }] }, tag: 'd1-pair', reason: 'paired set', revision: before.revision, kind: POLICY_RECOVERY_CHANGE_KIND }))
    .rejects.toMatchObject({ code: 'POLICY_DELEGATION_EXCEEDS' });
  expect(policySchema.parse(await f.source.load()).revision).toBe(before.revision);
  const rollout = { registry: { revision: 'r', status: 'provisional' as const }, complete: true, rules: [], decisions: { decided: 0, agreements: 0, perMille: null, waiting: 0, met: false } };
  const card = new RecoveryPolicyCard({ policy: f.source, administration: f.administration, approve: f.approve }, { rollout: async () => rollout, executable: NERVOUS_EXECUTABLE_ACTIONS }, async () => true);
  expect(await card.change({ schemaVersion: 1, scopeId: 's', kind: 'action', id: 'fence-attempt', action: 'grant', expectedRevision: before.revision }, f.principal)).toMatchObject({ status: 'applied' });
  const after = policySchema.parse(await f.source.load());
  expect(after.grants.find(rule => rule.id === cell)).toEqual({ ...ask, effect: 'allow' });
  expect(nervousStandingApproval(after, f.principal, { scopeId: 's', action: 'fence-attempt' }, 1)).not.toBeNull();
  expect(f.events.filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
});
