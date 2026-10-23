import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, PolicyAdministrationApplication, PolicyTemplateUpgrade, upgradePolicyTemplate } from '#engine/index.js';
import { createHmacIntegrity, sha256 } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, policyChangeSchema, policyGrantSchema } from '#domain/index.js';

const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer', executionEnvironmentIds: ['docker'] };
// S4B-1 + S4B-3 (alpha.55): the rolled-back delta is v15's ten rules (person propose, distiller D1–D4, agent catalog, person review, evaluator V1–V5); it was v14's two memory reads through v14, v13's seven through v13.
const deltaIds: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(edit: (grants: readonly PolicyGrant[]) => readonly unknown[] = grants => grants, seededUpgrade = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-template-rollback-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const }, ledger = join(root, 'ledger.db');
  openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock), { principal } = await sessions.verifySession(undefined);
  const template = firstRunPolicyTemplate({ scopeId: 's', principal, ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'authority-revisions');
  const original = { ...template.policy, revision: 'first-run-template-v10', grants: template.policy.grants.filter(rule => !deltaIds.includes(rule.id)) };
  await writeFile(policyPath, JSON.stringify(seededUpgrade ? original : template.policy), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  // 128 KiB (product default 1 MiB): an archive entry holds the policy twice, and the v15 template (S4B-3) outgrew a 64 KiB entry.
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 131_072 });
  if (seededUpgrade) expect(await upgradePolicyTemplate(source, { scopeId: 's', principal, apply: true, owner: true, peopleLimit: 10, now: () => 1000, audit: () => undefined,
    toolNames: { ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'], scratchWriteOperationId: 'workspace.scratch.write',
      editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' } })).toMatchObject({ status: 'upgraded' });
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
  return { principal, apply: () => upgrade.run({ scopeId: 's', principal, mode: 'apply', reason: 'v14 upgrade' }), source, events, archive, get cards() { return cards; }, bytes: () => readFile(policyPath, 'utf8'),
    rollback: (expect?: string) => upgrade.run({ scopeId: 's', principal, mode: 'rollback', reason: 'v14 rollback', ...(expect ? { expect } : {}) }) };
}

describe.skipIf(process.platform !== 'linux')('v15 rollback through the real approval and archived authority writer', () => {
  it('approves the operation card, removes only v15 rules, preserves the only administration grants, and refuses stale replay', async () => {
    const f = await fixture(), beforeBytes = await f.bytes(), before = JSON.parse(beforeBytes);
    expect(deltaIds).toEqual(['first-run-memory-propose', 'first-run-memory-distiller', 'first-run-memory-distiller-runs', 'first-run-memory-distiller-output', 'first-run-agent-catalog', 'first-run-mcp-observe-agent-catalog',
      'first-run-memory-review', 'first-run-memory-evaluator', 'first-run-memory-evaluator-runs', 'first-run-memory-evaluator-model', 'first-run-memory-purge']);
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
    // The person keeps catalog authority through a hand rule, so removing the MCP catalog read stays inside their own authority (I2).
    const f = await fixture(grants => [...grants.filter(rule => rule.id !== 'first-run-policy-administer').map(rule => rule.id === 'first-run-agent-catalog'
      ? { ...rule, actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } } : rule),
      { ...grants.find(rule => rule.id === 'first-run-agent-catalog')!, id: 'hand-agent-catalog' }]);
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', conflicts: ['first-run-agent-catalog'] });
    const after = JSON.parse(await f.bytes());
    expect(after.grants.find((rule: { id: string }) => rule.id === 'first-run-agent-catalog')).toEqual(JSON.parse(before).grants.find((rule: { id: string }) => rule.id === 'first-run-agent-catalog'));
    expect(f.cards).toBe(1);
  });

  it('refuses rollback through I2 when a narrower memory card restricts current memory authority', async () => {
    const f = await fixture(grants => [...grants, { ...grants.find(rule => rule.id === 'first-run-memory-inspect')!, id: 'run-card',
      effect: 'require-approval', actions: ['inspect'], resource: { kind: 'memory', ids: ['one'] } }]);
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: ['delegation'] });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0); expect(f.events).toEqual([]);
  });
});

it.skipIf(process.platform !== 'linux')('POLICY-V12 rule, v15 delta: a delta the installer added under template v15 is rollbackable; an older or future key does not count', async () => {
  const seed = async (version: number) => {
    const f = await fixture(undefined, false), current = JSON.parse(await f.bytes());
    await f.source.updateAuthority(() => ({ write: { policy: { ...current, revision: 'a-older', grants: current.grants.filter((rule: { id: string }) => !deltaIds.includes(rule.id)) },
      bindings: null, order: 'policy-first' }, result: null }), 'fixture-older');
    // The installer upgrade's own key shape (`policy-template-upgrade-v<version>-<64 hex>`), as a v15 installer writes it.
    await f.source.updateAuthority(() => ({ write: { policy: { ...current, revision: 'a-upgraded' }, bindings: null, order: 'policy-first' }, result: null }),
      `policy-template-upgrade-v${version}-${'a'.repeat(64)}`);
    return f;
  };
  const v15 = await seed(15);
  expect(await v15.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(','), conflicts: [] });
  for (const version of [14, 16]) {
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
  const resolved = 'a-older+first-run-template-v15-bindings';
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
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = 'a-older+first-run-template-v15-bindings';
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
  const tag = `template-v5:${rules.map((rule: { id: string }) => rule.id).join(',')}`, resolved = 'a-older+first-run-template-v15-bindings';
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

it.skipIf(process.platform !== 'linux')('rollback keeps fresh-install rules, detects changed-then-restored content, and refuses missing history without a card or write', async () => {
  // J3: a fresh install written by the current template has no upgrade to undo — "nothing to roll back" with its typed reason, never "not a first-run policy".
  const fresh = await fixture(undefined, false), initial = await fresh.bytes();
  expect(await fresh.rollback()).toMatchObject({ status: 'nothing-to-roll-back', reason: 'no-upgrade-recorded' });
  expect(await fresh.bytes()).toBe(initial); expect(fresh.cards).toBe(0);
  // NEGATIVE: the same template policy with an older bindings revision (an exact installer upgrade whose archive is gone) is not provably fresh.
  const bindingsPath = join(dirname(fresh.archive), 'bindings.json'), bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
  await writeFile(bindingsPath, JSON.stringify({ ...bindings, revision: 'first-run-template-v12-bindings' }), { mode: 0o600 });
  expect(await fresh.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await fresh.bytes()).toBe(initial); expect(fresh.cards).toBe(0);
  // NEGATIVE (Astra 2672 N1): the template's revision and bindings but one expected v15 rule deleted by hand, no archive: not provably fresh.
  const edited = await fixture(undefined, false), policyPath = join(dirname(edited.archive), 'policy.json'), held = JSON.parse(await readFile(policyPath, 'utf8'));
  await writeFile(policyPath, JSON.stringify({ ...held, grants: held.grants.filter((rule: { id: string }) => rule.id !== deltaIds[1]) }), { mode: 0o600 });
  const editedBytes = await edited.bytes();
  expect(await edited.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await edited.bytes()).toBe(editedBytes); expect(edited.cards).toBe(0);
  const restored = await fixture(), before = JSON.parse(await restored.bytes());
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-edited', grants: before.grants.map((rule: { id: string }) =>
    rule.id === 'first-run-agent-catalog' ? { ...rule, actions: ['inspect'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-edited');
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-restored' }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-restored');
  expect(await restored.rollback()).toMatchObject({ status: 'rolled-back', conflicts: ['first-run-agent-catalog'] });
  expect(JSON.parse(await restored.bytes()).grants.some((rule: { id: string }) => rule.id === 'first-run-agent-catalog')).toBe(true);
  const handBuilt = await fixture(grants => grants.filter(rule => rule.id !== 'first-run-read-tools'));
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
