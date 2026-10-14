import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, PolicyAdministrationApplication, PolicyTemplateUpgrade, upgradePolicyTemplate } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const deltaIds = ['first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt'];
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
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 65_536 });
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
  return { principal, apply: () => upgrade.run({ scopeId: 's', principal, mode: 'apply', reason: 'v11 upgrade' }), source, events, archive, get cards() { return cards; }, bytes: () => readFile(policyPath, 'utf8'),
    rollback: (expect?: string) => upgrade.run({ scopeId: 's', principal, mode: 'rollback', reason: 'v11 rollback', ...(expect ? { expect } : {}) }) };
}

describe.skipIf(process.platform !== 'linux')('v11 rollback through the real approval and archived authority writer', () => {
  it('approves the operation card, removes only v11 rules, preserves the only administration grants, and refuses stale replay', async () => {
    const f = await fixture(), beforeBytes = await f.bytes(), before = JSON.parse(beforeBytes);
    expect(await f.rollback('stale')).toMatchObject({ status: 'conflict' });
    expect(f.cards).toBe(0); expect(await f.bytes()).toBe(beforeBytes);
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: deltaIds.join(',') });
    expect(f.cards).toBe(1);
    const after = JSON.parse(await f.bytes());
    expect(after.grants).toEqual(before.grants.filter((grant: { id: string }) => !deltaIds.includes(grant.id)));
    expect(after.grants.some((grant: { id: string }) => grant.id === 'first-run-policy-administer')).toBe(true);
    for (const id of ['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets']) expect(after.grants.find((grant: { id: string }) => grant.id === id)).toEqual(before.grants.find((grant: { id: string }) => grant.id === id));
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
    const f = await fixture(grants => grants.filter(rule => rule.id !== 'first-run-policy-administer').map(rule => rule.id === 'first-run-integration'
      ? { ...rule, actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } } : rule));
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', conflicts: ['first-run-integration'] });
    const after = JSON.parse(await f.bytes());
    expect(after.grants.find((rule: { id: string }) => rule.id === 'first-run-integration')).toEqual(JSON.parse(before).grants.find((rule: { id: string }) => rule.id === 'first-run-integration'));
    expect(f.cards).toBe(1);
  });

  it('refuses rollback through I2 when a narrower integration card restricts current delivery authority', async () => {
    const f = await fixture(grants => [...grants, { ...grants.find(rule => rule.id === 'first-run-integration')!, id: 'run-card',
      effect: 'require-approval', actions: ['prepare-integration'], resource: { kind: 'attempt', ids: ['one'] } }]);
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: ['delegation'] });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0); expect(f.events).toEqual([]);
  });
});

it.skipIf(process.platform !== 'linux')('rollback keeps fresh-install rules, detects changed-then-restored content, and refuses missing history without a card or write', async () => {
  const fresh = await fixture(undefined, false), initial = await fresh.bytes();
  expect(await fresh.rollback()).toMatchObject({ status: 'unavailable', reason: 'history-unavailable' });
  expect(await fresh.bytes()).toBe(initial); expect(fresh.cards).toBe(0);
  const restored = await fixture(), before = JSON.parse(await restored.bytes());
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-edited', grants: before.grants.map((rule: { id: string }) =>
    rule.id === 'first-run-integration' ? { ...rule, actions: ['prepare-integration'] } : rule) }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-edited');
  await restored.source.updateAuthority(() => ({ write: { policy: { ...before, revision: 'a-restored' }, bindings: null, order: 'policy-first' }, result: null }), 'fixture-restored');
  expect(await restored.rollback()).toMatchObject({ status: 'rolled-back', conflicts: ['first-run-integration'] });
  expect(JSON.parse(await restored.bytes()).grants.some((rule: { id: string }) => rule.id === 'first-run-integration')).toBe(true);
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
