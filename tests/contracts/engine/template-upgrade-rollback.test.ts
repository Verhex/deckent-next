import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS, FIRST_RUN_POLICY_TEMPLATE_VERSION, POLICY_RECOVERY_CHANGE_KIND, RECOVERY_ROLLOUT, firstRunPolicyTemplate, firstRunExecutionRules, upgradeFirstRunPolicy, getPolicyVocabulary, installationOwnerPermissions, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, NERVOUS_EXECUTABLE_ACTIONS, PolicyAdministrationApplication, PolicyTemplateUpgrade, RecoveryPolicyCard, administerOwnPolicyChange, nervousStandingApproval,
  upgradePolicyTemplate, upgradeFirstRunProposalRules } from '#engine/index.js';
import { createHmacIntegrity, sha256, t } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, auditEventSchema, describePolicyChange, evaluatePolicy, mcpPrincipalRef, policyChangeSchema, policyGrantSchema, policySchema } from '#domain/index.js';
import { policyExecutionLines } from '#engine/index.js';
import { ModelInvocationPolicyAuthorization, type AuthorityRevision } from '#engine/core/policy/index.js';
import { main } from '#surfaces/index.js';
import { homeEnv } from '../support/host-platform.js';
import { answerOnCard } from '#surfaces/core/cli-approval/index.js';
import { approvalWindowLines } from '#surfaces/core/terminal-approval/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';

const names = { firstCommitOperationId: 'coding.first-commit', uninstallOperationIds: ['installation.remove-cache', 'installation.remove-data', 'installation.remove-image', 'installation.remove-service'], proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer', executionEnvironmentIds: ['docker'],
  recoveryRules: RECOVERY_ROLLOUT.rules.map(id => ({ id, version: 1 })), readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
// alpha.56 D1: the rolled-back delta is v16's recovery cells (require-approval); it was v15's (S4B-1 + S4B-3 + S8) through v15, v14's two memory reads through v14.
const deltaIds: readonly string[] = FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(edit: (grants: readonly PolicyGrant[]) => readonly unknown[] = grants => grants, seededUpgrade = true, family: 'ai-proposals' | 'ai-execution' = 'ai-proposals', locale: 'en' | 'tr' = 'en', historyBytes = 1_048_576, scopeId = 's', longIdentity = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-template-rollback-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const }, ledger = join(root, 'ledger.db');
  openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const osSessions = await LocalOsSessionAuthority.create([scopeId], 600_000, clock), verified = await osSessions.verifySession(undefined);
  // A verified-session fixture near the schema bounds; no host identity or live policy is changed.
  const principal = longIdentity ? { ...verified.principal, issuer: 'i'.repeat(256 - '/catalog-aggregator'.length), subject: 'u'.repeat(256) } : verified.principal;
  const sessions = longIdentity ? { verifySession: async () => ({ principal, session: { ...verified.session, principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject } } }),
    isSessionActive: async () => true, revoke: async () => undefined } : osSessions;
  const template = firstRunPolicyTemplate({ scopeId, principal, ...names });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'authority-revisions');
  const managedIds = family === 'ai-proposals' ? deltaIds : FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
  const original = { ...template.policy, revision: 'first-run-template-v10', grants: template.policy.grants.filter(rule => !managedIds.includes(rule.id)) };
  await writeFile(policyPath, JSON.stringify(seededUpgrade ? original : template.policy), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  // Product 1 MiB history bound: the two-step installer retains two complete before/after pairs.
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: historyBytes });
  if (seededUpgrade) expect(await upgradePolicyTemplate(source, { scopeId, principal, apply: true, owner: true, peopleLimit: 10, now: () => 1000, audit: () => undefined,
    toolNames: names })).toMatchObject({ status: 'upgraded' });
  const editable = family === 'ai-execution' ? [...template.policy.grants, ...firstRunExecutionRules([], principal, [scopeId]).wanted] : template.policy.grants;
  const edited = edit(editable);
  if (JSON.stringify(edited) !== JSON.stringify(editable)) await source.updateAuthority(() => ({ write: { policy: { ...template.policy, revision: 'a-custom', grants: edited }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-custom');
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
  const integrity = createHmacIntegrity('key', randomBytes(32)), events: AuditEvent[] = [];
  const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
    requestTtlMs: 60_000, locale, audit: event => { events.push(event); } });
  let cards = 0;
  const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => {
    cards++;
    expect(journal.store.list(scopeId, null, 10)).toHaveLength(cards);
    return new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source, integrity, clock, 'local-runtime', 10, undefined, undefined, { interactive: async () => true })
      .decide({ schemaVersion: 1, scopeId, approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
  };
  const upgrade = new PolicyTemplateUpgrade({ administration, approve, policy: source }, names);
  return { root, principal, administration, approve, request: upgrade.run.bind(upgrade), records: () => journal.store.list(scopeId, null, 20), apply: () => upgrade.run({ scopeId, principal, only: family, mode: 'apply', reason: 'v14 upgrade' }), source, events, archive, get cards() { return cards; }, bytes: () => readFile(policyPath, 'utf8'),
    rollback: (expect?: string) => upgrade.run({ scopeId, principal, mode: 'rollback', ...(family === 'ai-proposals' ? { only: family } : {}), reason: 'v14 rollback', ...(expect ? { expect } : {}) }) };
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
    const entries = await readdir(f.archive); expect(entries).toHaveLength(3); // baseline20, separate execution21, rollback20
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
  const v20Bytes = JSON.parse(await auto.bytes()), v19Policy = { ...v20Bytes, revision: 'first-run-template-v19', grants: v20Bytes.grants.filter((rule: { id: string }) => ![...deltaIds, ...FIRST_RUN_CURRENT_UPGRADE_RULE_IDS].includes(rule.id)) };
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify(v19Policy), { mode: 0o600 });
  expect(await run()).toBe('upgraded');
  const upgraded = JSON.parse(await auto.bytes());
  expect(upgraded.grants.some((rule: { id: string }) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(false);
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
  // Lead 2026-11-09 (side effects A, B): an MCP actor that holds the `work` group keeps its allows. A rule is skipped only when one allow covers its
  // whole cell: the group's run and every-target rules do (named in the audit record), its pool `p` does not cover v20's every pool, so the pool
  // allow is added beside the setting card. The actor's create_run stays allow (no card) and its reserve and pool use are unchanged.
  const ai = mcpPrincipalRef(auto.principal), work = ['run', 'pool', 'work-target'].map(kind => ({ id: `mcp-cap-work-${kind}`, effect: 'allow', actions: kind === 'run' ? ['create', 'inspect', 'reserve', 'cancel'] : ['use'],
    scopes: ['s'], principals: [ai], resource: { kind, ids: kind === 'pool' ? ['p'] : 'all' } }));
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify({ ...v19Policy, revision: 'a-work-group', grants: [...v19Policy.grants, ...work] }), { mode: 0o600 });
  // The person as the service start passes it (issuer and subject: proposal-policy.ts), so the record is checked against the sealed audit contract.
  expect(await upgradeFirstRunProposalRules(auto.source, { person: { issuer: auto.principal.issuer, subject: auto.principal.subject }, history: [], ...audit })).toBe('upgraded');
  expect(events.at(-1)!.subject).toMatchObject({ counts: { grantsAdded: 2 }, skipped: [{ ruleId: 'first-run-mcp-propose-work', heldBy: 'mcp-cap-work-run' },
    { ruleId: 'first-run-mcp-propose-target', heldBy: 'mcp-cap-work-work-target' }] });
  expect(auditEventSchema.parse(events.at(-1)).subject).toMatchObject({ skipped: [{ ruleId: 'first-run-mcp-propose-work' }, {}] }); // the sealed audit contract carries the reasons
  const grouped = await auto.source.load(), actor = { id: 'mcp', ...ai, assurance: 'workload-verified' as const, scopeIds: ['s'] };
  expect(policySchema.parse(grouped).grants.map(rule => rule.id).filter(id => deltaIds.includes(id))).toEqual(['first-run-mcp-propose-setting', 'first-run-mcp-propose-pool']);
  for (const [action, kind, id] of [['create', 'run', 'r'], ['reserve', 'run', 'r'], ['use', 'pool', 'p'], ['use', 'pool', 'q'], ['use', 'work-target', 't']] as const)
    expect(evaluatePolicy(grouped, { principal: actor, scopeId: 's', action, resource: { kind, id } }).decision, `${kind}/${action}/${id}`).toBe('allow');
  // Side effect B: a role binding is an effective grant too. A role-bound Run create allow of the AI actor skips the Run card rule (named with its
  // derived `binding/role/permission` id), so the binding's create_run is never lowered to a card; the other three rules are added.
  const bindingsPath = join(dirname(auto.archive), 'bindings.json'), bound = JSON.parse(await readFile(bindingsPath, 'utf8'));
  await writeFile(join(dirname(auto.archive), 'policy.json'), JSON.stringify({ ...v19Policy, revision: 'a-role', roles: [...v19Policy.roles, { id: 'ai-work', permissions: [{ id: 'create', effect: 'allow', actions: ['create'], resource: { kind: 'run', ids: 'all' } }] }] }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ ...bound, revision: 'b-role', bindings: [...bound.bindings, { id: 'ai-bound', principals: [ai], roles: ['ai-work'], scopes: ['s'] }] }), { mode: 0o600 });
  expect(await upgradeFirstRunProposalRules(auto.source, { person: auto.principal, history: [], ...audit })).toBe('upgraded');
  expect(events.at(-1)!.subject).toMatchObject({ counts: { grantsAdded: 3 }, skipped: [{ ruleId: 'first-run-mcp-propose-work', heldBy: 'ai-bound/ai-work/create' }] });
  expect(evaluatePolicy(await auto.source.load(), { principal: actor, scopeId: 's', action: 'create', resource: { kind: 'run', id: 'r' } }).decision).toBe('allow');
  for (const version of [19, 22]) {
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
  const resolved = `a-older+first-run-template-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-bindings`;
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
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = `a-older+first-run-template-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-bindings`;
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
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = `a-older+first-run-template-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-bindings`;
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

it.skipIf(process.platform !== 'linux')('119-C2: v21 rollback is family-specific and provenance-bound; AI apply/rollback refuse; real person cards carry the whole EN/TR breadth', async () => {
  for (const locale of ['en', 'tr'] as const) {
    const f = await fixture(undefined, false, 'ai-execution', locale, 1_048_576), initial = JSON.parse(await f.bytes()), ids = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
    const ai = { ...f.principal, id: 'ai', ...mcpPrincipalRef(f.principal), assurance: 'workload-verified' as const };
    for (const mode of ['apply', 'rollback'] as const)
      expect(await f.request({ scopeId: 's', principal: ai, mode, reason: 'AI cannot administer' })).toMatchObject({ status: 'refused', missing: ['policy-administer'] });
    expect(await f.bytes()).toBe(JSON.stringify(initial)); expect(f.cards).toBe(0);
    expect(initial.grants.some((rule: PolicyGrant) => ids.includes(rule.id))).toBe(false);
    expect(await f.apply()).toMatchObject({ status: 'upgraded', rules: ids.map(id => ({ id })) });
    const granted = JSON.parse(await f.bytes());
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: ids.join(','), conflicts: [] });
    expect(JSON.parse(await f.bytes()).grants).toEqual(initial.grants.filter((rule: PolicyGrant) => !ids.includes(rule.id)));
    expect(await f.apply()).toMatchObject({ status: 'upgraded' });
    const applied = await f.bytes(); expect(await f.apply()).toMatchObject({ status: 'current' }); expect(await f.bytes()).toBe(applied);
    const record = f.records().find(item => item.request.summary.includes(locale === 'en' ? 'This standing grant' : 'Bu kalıcı izin'))!;
    expect(record).toBeDefined();
    const notice = policyExecutionLines(granted.grants, 's', locale)[0]!;
    expect(notice).toContain(locale === 'en' ? "your or another actor's Runs" : 'senin veya başka aktörün');
    expect(notice).toContain(locale === 'en' ? 'request cancellation or hold' : 'iptal isteme veya beklemeye alma');
    expect(notice).toContain(locale === 'en' ? 'through its MCP tools to try to start them too' : 'MCP araçları üzerinden onları da başlatmayı deneyebilir');
    expect(notice).toContain('deckent policy upgrade --template current --scope s --rollback');
    expect(record.request.summary).toContain(notice); // whole, before the broker's 2048-character cut
    let body = '';
    await answerOnCard(record, undefined, 's', {}, async card => { body = card.body!.join('\n'); return null; }, locale);
    expect(body).toContain(notice); expect(await f.bytes()).toBe(applied); // declining this actual CLI card sends no decision
    const lines = approvalWindowLines({ approvalId: record.request.approvalId, summary: record.request.summary, requester: 'person', runId: '-', taskId: '-', expiresAt: 99_999 }, workSurfaceLabels(locale).approvalWindow, 1_000);
    expect(lines.map(line => line.spans.map(span => span.text).join('')).join('\n')).toContain(notice);
    // Governed re-add is recognized. A later same-id edit then restore is not silently treated as pristine custody.
    const snapshot = JSON.parse(applied), first = ids[0]!;
    for (const revision of ['a-edited', 'a-restored']) await f.source.updateAuthority(() => ({ write: { policy: { ...snapshot, revision, grants: snapshot.grants.map((rule: PolicyGrant) => rule.id === first && revision === 'a-edited' ? { ...rule, scopes: ['other'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), revision);
    const rolled = await f.rollback();
    expect(rolled, JSON.stringify((await f.source.authorityHistory())?.map(entry => ({ before: entry.before.revision, after: entry.after.revision, key: entry.key })))).toMatchObject({ status: 'rolled-back', conflicts: [first], reason: ids.slice(1).join(',') });
    expect(JSON.parse(await f.bytes()).grants.filter((rule: PolicyGrant) => deltaIds.includes(rule.id))).toEqual(initial.grants.filter((rule: PolicyGrant) => deltaIds.includes(rule.id)));
    expect(await f.request({ scopeId: 's', principal: f.principal, mode: 'rollback', only: 'ai-proposals', reason: 'the proposal family is still independently revocable' })).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  }
});

it.skipIf(process.platform !== 'linux')('119-C2 security: measures real v19/v20 upgrades with a UUID scope and near-maximum identity, EN/TR', async () => {
  const scopeId = '12345678-1234-4234-8234-123456789abc';
  for (const locale of ['en', 'tr'] as const) for (const version of [19, 20]) for (const only of ['ai-execution', undefined] as const) {
    const f = await fixture(undefined, false, 'ai-execution', locale, 1_048_576, scopeId, true);
    const current = JSON.parse(await f.bytes()), revision = `first-run-template-v${version}`;
    const removed = [...FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, ...(version === 19 ? FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS : [])];
    await writeFile(join(dirname(f.archive), 'policy.json'), JSON.stringify({ ...current, revision, grants: current.grants.filter((rule: PolicyGrant) => !removed.includes(rule.id)) }), { mode: 0o600 });
    const bindingsPath = join(dirname(f.archive), 'bindings.json'), bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
    await writeFile(bindingsPath, JSON.stringify({ ...bindings, revision: `${revision}-bindings` }), { mode: 0o600 });
    const input = { scopeId, principal: f.principal, reason: 'measured upgrade', ...(only ? { only } : {}) };
    const prior = { ...current, revision, grants: current.grants.filter((rule: PolicyGrant) => !removed.includes(rule.id)) };
    expect(upgradeFirstRunPolicy(prior, { scopeId, principal: f.principal, ...names })).toMatchObject(version === 20 ? { status: 'current' } : { status: 'upgrade', from: version });
    const preview = await f.request({ ...input, mode: 'preview' });
    const notice = t('policy.aiExecution.preview', { actor: `${f.principal.issuer}/mcp/${f.principal.subject}`, scope: scopeId, scopes: scopeId }, locale);
    await mkdir(join(f.root, '.deckent'));
    let printed = '';
    expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', scopeId, '--preview', '--lang', locale], {
      root: f.root, env: homeEnv(f.root), stdout: { write(value: string) { printed += value; } },
      upgradePolicyTemplate: async (_root, scope, request) => f.request({ ...request, scopeId: scope, principal: f.principal }),
    })).toBe(0);
    expect(printed).toContain(notice); // A genuine pre-apply preview prints the full notice.

    expect(preview.status).toBe('preview');
    expect(await f.request({ ...input, mode: 'apply' })).toMatchObject({ status: 'upgraded' });
    const summary = f.records()[0]!.request.summary, binding = summary.split('\n')[0]!;
    const change = { schemaVersion: 1, changes: preview.rules.map(grant => ({ kind: 'grant.add', grant })) };
    const diff = describePolicyChange({ policy: { ...current, revision, grants: current.grants.filter((rule: PolicyGrant) => !removed.includes(rule.id)) }, bindings }, change, 2048 - binding.length - 1)!;
    const short = t('policy.aiExecution.previewShort', { actor: `${f.principal.issuer}/mcp/${f.principal.subject}`, scope: scopeId, scopes: scopeId }, locale);
    console.log('119-C2 measurement', JSON.stringify({ locale, version, only: only ?? 'default', issuer: f.principal.issuer.length, subject: f.principal.subject.length, scope: scopeId.length,
      binding: binding.length, diff: diff.length, full: notice.length, short: short.length, shortSummary: binding.length + 1 + diff.length + 1 + short.length, fullSummary: binding.length + 1 + diff.length + 1 + notice.length, sealed: summary.length }));
    expect(summary.slice(binding.length + 1, binding.length + 1 + diff.length)).toBe(diff);
    expect(summary.length).toBeLessThanOrEqual(2048);
    const room = 2048 - binding.length - diff.length - 2;
    expect(summary.slice(binding.length + diff.length + 1)).toBe(notice.length <= room ? `\n${notice}` : short.length <= room ? `\n${short}` : '');
  }
});

it.skipIf(process.platform !== 'linux')('119-C2 security: a genuine subset retains its breadth when other v21 cells are held or covered', async () => {
  const ids = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
  const f = await fixture(grants => [...grants.filter(rule => !ids.slice(1).includes(rule.id)),
    { ...grants.find(rule => rule.id === ids[1])!, id: 'custom-cancel-cover', scopes: 'all' }], false, 'ai-execution', 'en', 1_048_576);
  const preview = await f.request({ scopeId: 's', principal: f.principal, mode: 'preview', only: 'ai-execution', reason: 'partial upgrade' });
  expect(preview).toMatchObject({ status: 'preview', rules: [{ id: ids[2] }], covered: [{ ruleId: ids[1], heldBy: 'custom-cancel-cover' }] });
  expect(policyExecutionLines(preview.rules, 's', 'en')).toEqual([]);
  const notice = policyExecutionLines(preview.rules, 's', 'en', preview.executionContext)[0]!;
  expect(notice).toContain('This standing grant');
  expect(await f.apply()).toMatchObject({ status: 'upgraded' });
  expect(f.records()[0]!.request.summary).toContain(notice);
});

it.skipIf(process.platform !== 'linux')('119-C2 P2: genuine multi-scope governed and installer previews name the full planned breadth', async () => {
  for (const locale of ['en', 'tr'] as const) {
    const f = await fixture(grants => grants.filter(rule => !FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))
      .map(rule => rule.id === 'first-run-read-tools' ? { ...rule, scopes: ['s', 'other'] } : rule), false, 'ai-execution', locale);
    const before = await f.bytes();
    const governed = await f.request({ scopeId: 's', principal: f.principal, mode: 'preview', only: 'ai-execution', reason: 'multi-scope preview' });
    const installer = await upgradePolicyTemplate(f.source, { scopeId: 's', principal: f.principal, apply: false, owner: true, peopleLimit: 10,
      now: () => 1000, audit: () => undefined, toolNames: names });
    expect(governed).toMatchObject({ status: 'preview', rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id, scopes: ['s', 'other'] })) });
    expect(installer).toMatchObject({ status: 'preview', basis: 'first-run' });
    await mkdir(join(f.root, '.deckent'));
    const notice = t('policy.aiExecution.preview', { actor: `${f.principal.issuer}/mcp/${f.principal.subject}`, scope: 's', scopes: 's, other' }, locale);
    expect(notice).toContain(locale === 'en' ? 'Runs in s, other.' : 's, other kapsamında');
    expect(notice).toContain(locale === 'en' ? 'withdraws these managed permission lines in: s, other' : 'yönetilen izin satırlarını şu kapsamlarda kaldırır: s, other');
    for (const args of [['policy', 'upgrade', '--template', 'current', '--preview'], ['init', 'policy', '--upgrade', '--preview']]) {
      let printed = '';
      expect(await main([...args, '--scope', 's', '--lang', locale], { root: f.root, env: homeEnv(f.root), stdout: { write(value: string) { printed += value; } },
        upgradePolicyTemplate: async () => governed, upgradePolicyTemplateInstallation: async () => installer })).toBe(0);
      expect(printed).toContain(notice);
    }
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0);
  }
});

it.skipIf(process.platform !== 'linux')('119-F1a: older baseline and pending system rows publish before key21; archive rollback keeps baseline20 and rows; a step2 refusal preserves step1', async () => {
  const { CORE_SYSTEM_POLICY_ROWS } = await import('#engine/index.js');
  const f = await fixture(undefined, false, 'ai-execution', 'en', 1_048_576);
  const current = JSON.parse(await f.bytes()), policyPath = join(dirname(f.archive), 'policy.json'), bindingsPath = join(dirname(f.archive), 'bindings.json');
  const old = { ...current, revision: 'first-run-template-v19', grants: current.grants.filter((rule: PolicyGrant) => !deltaIds.includes(rule.id)) };
  await writeFile(policyPath, JSON.stringify(old));
  const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
  await writeFile(bindingsPath, JSON.stringify({ ...bindings, revision: 'first-run-template-v19-bindings' }));
  const input = { scopeId: 's', principal: f.principal, owner: true, peopleLimit: 10, now: () => 1000, audit: () => undefined, toolNames: names,
    systemRows: { data: CORE_SYSTEM_POLICY_ROWS.data, history: [], lookup: f.source.lookupAuthority.bind(f.source) } };
  const preview = await upgradePolicyTemplate(f.source, { ...input, apply: false });
  expect(preview).toMatchObject({ status: 'preview', publications: [20, 21] });
  expect(preview.rules.filter((rule: unknown) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes((rule as PolicyGrant).id))).toHaveLength(3);
  // This is exactly the wizard's baseline-only writer; declining the later execution offer cannot add a cell.
  const baseline = await upgradePolicyTemplate(f.source, { ...input, apply: false, baselineOnly: true });
  expect(baseline).toMatchObject({ status: 'preview', publications: [20] });
  expect(baseline.rules.some((rule: unknown) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes((rule as PolicyGrant).id))).toBe(false);
  const refused = await upgradePolicyTemplate({ lookupAuthority: f.source.lookupAuthority.bind(f.source), updateAuthority: (work, key) => f.source.updateAuthority(snapshot => work(key?.startsWith('policy-template-upgrade-v21-')
    ? { ...snapshot, policy: { ...(snapshot.policy as object), revision: 'moved-between-steps' } } : snapshot), key) }, { ...input, apply: true });
  expect(refused).toMatchObject({ status: 'conflict', baselineRevision: expect.any(String), executionStatus: 'not-added' });
  const baselineBytes = await f.bytes(), publishedBaseline = JSON.parse(baselineBytes), baselineBindings = await readFile(bindingsPath, 'utf8');
  expect(publishedBaseline.grants.some((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(false);
  expect(publishedBaseline.grants.filter((rule: PolicyGrant) => deltaIds.includes(rule.id))).toHaveLength(4);
  const baselineHistory = (await f.source.authorityHistory())!;
  expect(baselineHistory).toHaveLength(1); expect(baselineHistory[0]!.key).toMatch(/^spr1-/u);
  const retry = { ...input, systemRows: { ...input.systemRows, history: baselineHistory } };
  expect(await upgradePolicyTemplate(f.source, { ...retry, apply: false })).toMatchObject({ status: 'preview', publications: [21] });
  expect(await upgradePolicyTemplate(f.source, { ...retry, apply: true })).toMatchObject({ status: 'upgraded', publications: [21] });
  const entries = (await f.source.authorityHistory())!;
  expect(entries).toHaveLength(2); expect(entries.find(entry => entry.key?.startsWith('policy-template-upgrade-v21-'))).toBeDefined();
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(',') });
  expect(JSON.parse(await f.bytes()).grants).toEqual(publishedBaseline.grants);
  expect(await readFile(bindingsPath, 'utf8')).toBe(baselineBindings);
  // An otherwise canonical family in an unrelated publication is not managed custody.
  const untracked = JSON.parse(await f.bytes()), custom = { ...untracked, revision: 'a-combined',
    grants: [...untracked.grants, ...firstRunExecutionRules([], f.principal, ['s']).wanted] };
  await f.source.updateAuthority(() => ({ write: { policy: custom, bindings: null, order: 'policy-first' }, result: null }), 'unmerged-combined-publication');
  const unmanagedBytes = await f.bytes(), cards = f.cards;
  expect(await f.rollback()).toMatchObject({ status: 'nothing-to-roll-back', conflicts: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS });
  expect(await f.bytes()).toBe(unmanagedBytes); expect(f.cards).toBe(cards);
});

it.skipIf(process.platform !== 'linux')('119-F1a: governed hand-built upgrades use the verified named person; an unnamed caller gets the existing admin step', async () => {
  const f = await fixture(grants => grants.filter(rule => rule.id !== 'first-run-read-tools' && !FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id)), false, 'ai-execution');
  const preview = await f.request({ scopeId: 's', principal: f.principal, mode: 'preview', reason: 'hand-built preview', only: 'ai-execution' });
  expect(preview).toMatchObject({ status: 'preview', missing: [], rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id })) });
  expect(await f.apply()).toMatchObject({ status: 'upgraded' });
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(',') });
  const path = join(dirname(f.archive), 'policy.json'), before = JSON.parse(await f.bytes());
  await writeFile(path, JSON.stringify({ ...before, revision: 'hand-built-unnamed', grants: before.grants.map((rule: PolicyGrant) => ({ ...rule, principals: 'all' })) }));
  const bytes = await f.bytes(), cards = f.cards;
  expect(await f.apply()).toMatchObject({ status: 'unavailable', reason: 'person-not-named' });
  expect(await f.bytes()).toBe(bytes); expect(f.cards).toBe(cards);
});


async function twoStepInstaller() {
  const f = await fixture(undefined, false, 'ai-execution');
  const path = join(f.root, 'policy.json'), current = JSON.parse(await f.bytes());
  await writeFile(path, JSON.stringify({ ...current, revision: 'first-run-template-v19', grants: current.grants.filter((rule: PolicyGrant) => !deltaIds.includes(rule.id)) }));
  const input = { scopeId: 's', principal: f.principal, owner: true, peopleLimit: 10, now: () => 1000, audit: () => undefined, toolNames: names, apply: true, expect: 'first-run-template-v19' };
  return { ...f, input };
}

it.skipIf(process.platform !== 'linux')('119-F1a-2: two sequential publications verify step1 before step2; the initial expect binds only the pre-state', async () => {
  const f = await twoStepInstaller(), order: string[] = [];
  const writer = { updateAuthority: ((work, key) => { if (key) order.push(`publish:${key.split('-v')[1]?.split('-')[0]}`); return f.source.updateAuthority(work, key); }) as typeof f.source.updateAuthority,
    lookupAuthority: async (key: string) => { const held = await f.source.lookupAuthority(key); if (held?.status === 'applied') order.push(`verified:${key.split('-v')[1]?.split('-')[0]}`); return held; } };
  expect(await upgradePolicyTemplate(writer, { ...f.input, apply: false })).toMatchObject({ status: 'preview', publications: [20, 21], publicationsAtomic: false });
  expect(await upgradePolicyTemplate(writer, f.input)).toMatchObject({ status: 'upgraded', executionStatus: 'added', publicationsAtomic: false });
  expect(order).toEqual(['publish:20', 'verified:20', 'publish:21', 'verified:21']);
  expect((await f.source.authorityHistory())!.map(entry => entry.key?.split('-v')[1]?.split('-')[0]).sort()).toEqual(['20', '21']);
  expect(JSON.parse(await f.bytes()).grants.filter((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toHaveLength(3);
});

it.skipIf(process.platform !== 'linux')('119-F1a-2: a failure after the execution rename is reconciled on the same key as unknown or proven applied, never assumed absent', async () => {
  for (const torn of [true, false]) {
    const f = await twoStepInstaller(); let operationKey = '', writes = 0;
    const writer = { lookupAuthority: f.source.lookupAuthority.bind(f.source), updateAuthority: (async (work, key) => {
      const result = await f.source.updateAuthority(work, key);
      if (key?.startsWith('policy-template-upgrade-v21-')) {
        operationKey = key; writes++;
        expect(JSON.parse(await f.bytes()).grants.some((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(true);
        // A torn final receipt after the real policy rename makes this operation's outcome unknowable.
        if (torn) await writeFile(join(f.archive, `k-${key}.json`), '{');
        throw new Error('AFTER_EXECUTION_RENAME');
      }
      return result;
    }) as typeof f.source.updateAuthority };
    const result = await upgradePolicyTemplate(writer, f.input);
    expect(result).toMatchObject(torn ? { status: 'unavailable', baselineRevision: expect.any(String), executionStatus: 'unknown', publicationKey: operationKey }
      : { status: 'upgraded', executionStatus: 'added' });
    expect(await f.source.lookupAuthority(operationKey)).toEqual(torn ? null : { status: 'applied', version: (await f.source.load()).revision });
    expect(writes).toBe(1);
    expect(JSON.parse(await f.bytes()).grants.filter((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toHaveLength(3);
  }
});

it.skipIf(process.platform !== 'linux')('119-F1a-2: unverified step1 never starts step2; a foreign bindings write between publications conflicts without replanning', async () => {
  for (const unknown of [true, false]) {
    const f = await twoStepInstaller(); let executionWrites = 0, baselinePublished = false;
    const bindingsPath = join(f.root, 'bindings.json');
    const writer = { lookupAuthority: async (key: string) => unknown && baselinePublished ? null : f.source.lookupAuthority(key), updateAuthority: (async (work, key) => {
      if (key?.startsWith('policy-template-upgrade-v21-')) executionWrites++;
      const result = await f.source.updateAuthority(work, key);
      if (key?.startsWith('policy-template-upgrade-v20-')) baselinePublished = true;
      if (!unknown && key?.startsWith('policy-template-upgrade-v20-')) await f.source.updateAuthority(snapshot => ({ write: {
        policy: null, bindings: { ...(snapshot.bindings as object), revision: 'foreign-between-publications' }, order: 'bindings-first' }, result: null }), 'foreign-writer');
      return result;
    }) as typeof f.source.updateAuthority };
    const result = await upgradePolicyTemplate(writer, f.input);
    expect(result).toMatchObject(unknown ? { status: 'unavailable', publicationStatus: 'unknown' }
      : { status: 'conflict', baselineRevision: expect.any(String), executionStatus: 'not-added' });
    expect(baselinePublished).toBe(true);
    expect(executionWrites).toBe(unknown ? 0 : 1);
    if (!unknown) expect(JSON.parse(await readFile(bindingsPath, 'utf8')).revision).toBe('foreign-between-publications');
    expect(JSON.parse(await f.bytes()).grants.some((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toBe(false);
  }
});


it.skipIf(process.platform !== 'linux')('119-F1a-2: a proven absent step2 failure keeps baseline20; an unknown existing operation is never rewritten', async () => {
  const f = await twoStepInstaller(); let key21 = '', attempted = 0, uncertain = false;
  const writer = { lookupAuthority: async (key: string) => key === key21 && uncertain ? null : f.source.lookupAuthority(key),
    updateAuthority: (async (work, key) => {
      if (key?.startsWith('policy-template-upgrade-v21-')) { key21 = key; attempted++; throw new Error('BEFORE_ANY_EXECUTION_WRITE'); }
      return f.source.updateAuthority(work, key);
    }) as typeof f.source.updateAuthority };
  const absent = await upgradePolicyTemplate(writer, f.input);
  expect(absent).toMatchObject({ status: 'unavailable', executionStatus: 'not-added', baselineRevision: 'first-run-template-v20', publicationKey: key21 });
  expect(await f.source.lookupAuthority(key21)).toEqual({ status: 'absent' });
  const bytes = await f.bytes(); uncertain = true;
  // The explicit retry selects exactly the same execution identity, but cannot publish until it is reconciled.
  expect(await upgradePolicyTemplate(writer, { ...f.input, expect: 'first-run-template-v20' })).toMatchObject({ status: 'unavailable', executionStatus: 'unknown', publicationKey: key21 });
  expect(attempted).toBe(1); expect(await f.bytes()).toBe(bytes);
  for (const locale of ['en', 'tr']) {
    let printed = '';
    expect(await main(['init', 'policy', '--scope', 's', '--upgrade', '--apply', '--lang', locale], { root: f.root, env: homeEnv(f.root),
      upgradePolicyTemplateInstallation: async () => ({ ...absent, executionStatus: 'unknown' as const }), stdout: { write(value: string) { printed += value; } } })).toBe(0);
    expect(printed).toContain('unknown'); expect(printed).toContain('deckent policy status --scope s');
    expect(printed).not.toContain(t('cli.init.policyUpgrade.unavailable', {}, locale));
    expect(printed).not.toContain('not-added');
  }
});


it.skipIf(process.platform !== 'linux')('119-F1a-3: each governed or installer21 add proves custody above an unknown administered prefix', async () => {
  for (const producer of ['governed', 'installer'] as const) {
    const f = await fixture(undefined, false, 'ai-execution'), baseline = JSON.parse(await f.bytes());
    await writeFile(join(f.root, 'policy.json'), JSON.stringify({ ...baseline, revision: 'a-unknown-prefix' }));
    if (producer === 'governed') expect(await f.apply()).toMatchObject({ status: 'upgraded' });
    else expect(await upgradePolicyTemplate(f.source, { scopeId: 's', principal: f.principal, apply: true, owner: true, peopleLimit: 10,
      now: () => 1000, audit: () => undefined, toolNames: names })).toMatchObject({ status: 'upgraded', publications: [21] });
    expect(await f.source.authorityHistory()).toHaveLength(1);
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(','), conflicts: [] });
    expect(JSON.parse(await f.bytes()).grants).toEqual(baseline.grants);
  }
});

it.skipIf(process.platform !== 'linux')('119-F1a-3: gaps, duplicate/forked links and a cycle after add refuse; a genuine v20-only entry cannot forgive the gap', async () => {
  const f = await fixture(undefined, false, 'ai-execution'), baseline = JSON.parse(await f.bytes());
  await writeFile(join(f.root, 'policy.json'), JSON.stringify({ ...baseline, grants: baseline.grants.map((rule: PolicyGrant) => rule.scopes === 'all' ? rule : { ...rule, scopes: ['s', 'other'] }) }));
  expect(await f.apply()).toMatchObject({ status: 'upgraded' });
  const added = JSON.parse(await f.bytes());
  await f.source.updateAuthority(() => ({ write: { policy: { ...added, revision: 'a-after-add' }, bindings: null, order: 'policy-first' }, result: null }), 'after-add');
  await f.source.updateAuthority(() => ({ write: { policy: { ...added, revision: 'a-without-proposals', grants: added.grants.filter((rule: PolicyGrant) => !deltaIds.includes(rule.id)) }, bindings: null, order: 'policy-first' }, result: null }), 'remove-proposals');
  expect(await f.request({ scopeId: 's', principal: f.principal, only: 'ai-proposals', mode: 'apply', reason: 're-enable20' })).toMatchObject({ status: 'upgraded' });
  const history = (await f.source.authorityHistory())!, before = await f.bytes(), cards = f.cards, events = f.events.length;
  const add = history.find(entry => !entry.before.grants.some(rule => rule.id === FIRST_RUN_CURRENT_UPGRADE_RULE_IDS[0]) && entry.after.grants.some(rule => rule.id === FIRST_RUN_CURRENT_UPGRADE_RULE_IDS[0]))!;
  const middle = history.find(entry => entry.after.schemaVersion === 2 && entry.after.policyRevision === 'a-after-add')!;
  const remove = history.find(entry => entry.after.schemaVersion === 2 && entry.after.policyRevision === 'a-without-proposals')!;
  const proposals = history.find(entry => !entry.before.grants.some(rule => rule.id === deltaIds[0]) && entry.after.grants.some(rule => rule.id === deltaIds[0]))!;
  expect(add).toBeDefined(); expect(middle).toBeDefined(); expect(proposals).toBeDefined();
  const broken: readonly (readonly AuthorityRevision[])[] = [
    history.filter(entry => entry !== add), // latest link is real governed v20, but the v21 add is beyond the gap
    history.filter(entry => entry !== middle),
    [...history, { ...middle, key: 'duplicate' }],
    [...history, { ...middle, key: 'fork', after: { ...middle.after, revision: 'a-fork' } }],
    history.map(entry => entry === middle ? { ...entry, before: remove.after } : entry), // cycle below current, not back to current
  ];
  for (const entries of broken) {
    const upgrade = new PolicyTemplateUpgrade({ administration: f.administration, approve: f.approve,
      policy: { load: () => f.source.load(), authorityHistory: async () => entries } }, names);
    expect(await upgrade.run({ scopeId: 's', principal: f.principal, mode: 'rollback', reason: 'damaged custody' })).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(cards); expect(f.events).toHaveLength(events);
  }
});

it.skipIf(process.platform !== 'linux')('119-F1a-3: partial add witnesses do not own held, custom or role grants; edit then restore remains a conflict', async () => {
  const ids = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, f = await fixture(undefined, false, 'ai-execution'), baseline = JSON.parse(await f.bytes());
  const family = firstRunExecutionRules([], f.principal, ['s']).wanted;
  const role = { id: 'role-execution', permissions: [{ id: 'cancel', effect: 'allow', actions: ['cancel'], resource: { kind: 'run', ids: 'all' } }] };
  const bindingsPath = join(f.root, 'bindings.json'), bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
  await writeFile(join(f.root, 'policy.json'), JSON.stringify({ ...baseline, revision: 'a-unretained', roles: [...baseline.roles, role],
    grants: [...baseline.grants, family[0], { ...family[1], id: 'custom-cancel', scopes: 'all' }] }));
  await writeFile(bindingsPath, JSON.stringify({ ...bindings, bindings: [...bindings.bindings,
    { id: 'role-held', roles: ['role-execution'], scopes: ['s'], principals: [mcpPrincipalRef(f.principal)] }] }));
  expect(await f.apply()).toMatchObject({ status: 'upgraded', rules: [{ id: ids[2] }] });
  expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: ids[2], conflicts: [ids[0]] });
  const after = JSON.parse(await f.bytes());
  expect(after.grants).toEqual([...baseline.grants, family[0], { ...family[1], id: 'custom-cancel', scopes: 'all' }]);
  expect(after.roles).toEqual([...baseline.roles, role]); expect(JSON.parse(await readFile(bindingsPath, 'utf8')).bindings).toEqual([...bindings.bindings,
    { id: 'role-held', roles: ['role-execution'], scopes: ['s'], principals: [mcpPrincipalRef(f.principal)] }]);
  const restored = await fixture(undefined, false, 'ai-execution');
  const initial = JSON.parse(await restored.bytes());
  await writeFile(join(restored.root, 'policy.json'), JSON.stringify({ ...initial, revision: 'a-old-prefix', grants: initial.grants.map((rule: PolicyGrant) => rule.scopes === 'all' ? rule : { ...rule, scopes: ['s', 'other'] }) }));
  expect(await restored.apply()).toMatchObject({ status: 'upgraded' });
  const granted = JSON.parse(await restored.bytes());
  for (const revision of ['a-edit', 'a-restore']) await restored.source.updateAuthority(() => ({ write: { policy: { ...granted, revision,
    grants: granted.grants.map((rule: PolicyGrant) => rule.id === ids[0] && revision === 'a-edit' ? { ...rule, scopes: ['other'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), revision);
  expect(await restored.rollback()).toMatchObject({ status: 'rolled-back', reason: ids.slice(1).join(','), conflicts: [ids[0]] });
  expect(JSON.parse(await restored.bytes()).grants).toEqual(granted.grants.filter((rule: PolicyGrant) => !ids.slice(1).includes(rule.id)));
});

it.skipIf(process.platform !== 'linux')('119-F1a-3: v20 keeps its missing-history refusal; installer version21 alone is not custody', async () => {
  const proposals = await fixture(undefined, false), original = JSON.parse(await proposals.bytes());
  await writeFile(join(proposals.root, 'policy.json'), JSON.stringify({ ...original, revision: 'a-old', grants: original.grants.filter((rule: PolicyGrant) => !deltaIds.includes(rule.id)) }));
  expect(await proposals.apply()).toMatchObject({ status: 'upgraded' });
  const before = await proposals.bytes();
  expect(await proposals.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await proposals.bytes()).toBe(before); expect(proposals.cards).toBe(1);
  const f = await fixture(undefined, false, 'ai-execution'), initial = JSON.parse(await f.bytes());
  await writeFile(join(f.root, 'policy.json'), JSON.stringify({ ...initial, revision: 'a-prefix' }));
  await f.source.updateAuthority(snapshot => ({ write: { policy: { ...(snapshot.policy as object), revision: 'a-tag-only',
    grants: [...initial.grants, ...firstRunExecutionRules([], f.principal, ['s']).wanted] }, bindings: null, order: 'policy-first' }, result: null }), `policy-template-upgrade-v21-${'a'.repeat(64)}`);
  const bytes = await f.bytes();
  expect(await f.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable', conflicts: [] });
  expect(await f.bytes()).toBe(bytes); expect(f.cards).toBe(0);
});

it.skipIf(process.platform !== 'linux')('119-C2-R: genuine governed and installer multi-scope adds roll back every scope with EN/TR preview and decision cards', async () => {
  for (const [producer, locale] of [['governed', 'en'], ['installer', 'tr']] as const) {
    const f = await fixture(undefined, false, 'ai-execution', locale), initial = JSON.parse(await f.bytes());
    const baseline = { ...initial, revision: 'a-unknown-prefix', grants: initial.grants.map((rule: PolicyGrant) => rule.scopes === 'all' ? rule : { ...rule, scopes: ['s', 'other'] }) };
    await writeFile(join(f.root, 'policy.json'), JSON.stringify(baseline));
    const preview = await f.request({ scopeId: 's', principal: f.principal, only: 'ai-execution', mode: 'preview', reason: 'multi-scope add' });
    const notice = policyExecutionLines(preview.rules, 's', locale, preview.executionContext, 'full', preview.executionScopes)[0]!;
    if (producer === 'governed') expect(await f.apply()).toMatchObject({ status: 'upgraded' });
    else expect(await upgradePolicyTemplate(f.source, { scopeId: 's', principal: f.principal, apply: true, owner: true, peopleLimit: 10,
      now: () => 1000, audit: () => undefined, toolNames: names })).toMatchObject({ status: 'upgraded', publications: [21] });
    const granted = JSON.parse(await f.bytes());
    expect(granted.grants.filter((rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id))).toEqual(preview.rules);
    // Today's anchor is narrower; only the historical before determines the managed add's scopes.
    await f.source.updateAuthority(() => ({ write: { policy: { ...granted, revision: 'a-narrower-anchor', grants: granted.grants.map((rule: PolicyGrant) =>
      rule.id === 'first-run-read-tools' ? { ...rule, scopes: ['s'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), 'narrow-anchor');
    const before = JSON.parse(await f.bytes());
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.join(','), conflicts: [] });
    expect(JSON.parse(await f.bytes()).grants).toEqual(before.grants.filter((rule: PolicyGrant) => !FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id)));
    expect(notice).toContain(locale === 'en' ? 'withdraws these managed permission lines in: s, other' : 'yönetilen izin satırlarını şu kapsamlarda kaldırır: s, other');
    const card = f.records().find(record => record.request.summary.includes('- grant first-run-mcp-progress-run-reserve'))!;
    const removal = locale === 'en' ? 'Managed permission line first-run-mcp-progress-run-reserve will be withdrawn in: s, other.' : 'Yönetilen izin satırı first-run-mcp-progress-run-reserve şu kapsamlarda kaldırılacak: s, other.';
    expect(card.request.summary).toContain(removal);
    let body = '';
    await answerOnCard(card, undefined, 's', {}, async view => { body = view.body!.join('\n'); return null; }, locale);
    expect(body).toContain(removal);
    const lines = approvalWindowLines({ approvalId: card.request.approvalId, summary: card.request.summary, requester: 'person', runId: '-', taskId: '-', expiresAt: 99_999 }, workSurfaceLabels(locale).approvalWindow, 1_000);
    expect(lines.map(line => line.spans.map(span => span.text).join('')).join('\n')).toContain(removal);
  }
});

it.skipIf(process.platform !== 'linux')('119-C2-R: multi-scope removal needs current delegation in other; no grant, deny or restriction writes nothing', async () => {
  for (const bound of ['no-grant', 'deny', 'restriction'] as const) {
    const f = await fixture(undefined, false, 'ai-execution'), initial = JSON.parse(await f.bytes());
    const baseline = { ...initial, grants: initial.grants.map((rule: PolicyGrant) => rule.scopes === 'all' ? rule : { ...rule, scopes: ['s', 'other'] }) };
    await writeFile(join(f.root, 'policy.json'), JSON.stringify(baseline));
    expect(await f.apply()).toMatchObject({ status: 'upgraded' });
    const granted = JSON.parse(await f.bytes());
    const denial = { id: 'other-execution-denied', actions: ['reserve'], scopes: ['other'], principals: [{ issuer: f.principal.issuer, subject: f.principal.subject }], resource: { kind: 'run', ids: 'all' } };
    await f.source.updateAuthority(() => ({ write: { policy: { ...granted, revision: `a-${bound}`, grants: bound === 'no-grant' ? granted.grants.map((rule: PolicyGrant) =>
      ['run', 'attempt'].includes(rule.resource.kind) && rule.principals !== 'all' && rule.principals.some(actor => actor.issuer === f.principal.issuer && actor.subject === f.principal.subject) && rule.scopes !== 'all' ? { ...rule, scopes: ['s'] } : rule)
      : bound === 'deny' ? [...granted.grants, { ...denial, effect: 'deny' }] : granted.grants, restrictions: bound === 'restriction' ? [...granted.restrictions, denial] : granted.restrictions }, bindings: null, order: 'policy-first' }, result: null }), `restrict-${bound}`);
    const bytes = await f.bytes(), history = await f.source.authorityHistory(), cards = f.cards, events = f.events.length;
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: ['delegation'], conflicts: [] });
    expect(await f.bytes()).toBe(bytes); expect(await f.source.authorityHistory()).toEqual(history); expect(f.cards).toBe(cards); expect(f.events).toHaveLength(events);
  }
});

it.skipIf(process.platform !== 'linux')('119-C2-R: canonical widened after scopes cannot witness a before whose planner only named s', async () => {
  const f = await fixture(undefined, false, 'ai-execution'), initial = JSON.parse(await f.bytes());
  expect(await f.apply()).toMatchObject({ status: 'upgraded' });
  const history = (await f.source.authorityHistory())!, add = history[0]!;
  const widened = firstRunExecutionRules([], f.principal, ['s', 'other']).wanted;
  await f.source.updateAuthority(() => ({ write: { policy: { ...initial, revision: 'a-fake-widening', grants: [...initial.grants, ...widened] }, bindings: null, order: 'policy-first' }, result: null }), 'fake-widening');
  const current = await f.source.load(), bytes = await f.bytes(), cards = f.cards;
  // Retain the real single-scope key but present a canonical widened after. Shape alone would accept it.
  const forged = [{ ...add, after: current }];
  const upgrade = new PolicyTemplateUpgrade({ administration: f.administration, approve: f.approve, policy: { load: () => f.source.load(), authorityHistory: async () => forged } }, names);
  expect(await upgrade.run({ scopeId: 's', principal: f.principal, mode: 'rollback', reason: 'forged multi-scope add' })).toMatchObject({ status: 'nothing-to-roll-back', conflicts: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS });
  expect(await f.bytes()).toBe(bytes); expect(f.cards).toBe(cards);
});
