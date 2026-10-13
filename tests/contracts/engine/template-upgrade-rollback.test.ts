import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource, LocalOsSessionAuthority, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { firstRunPolicyTemplate, type AuditEvent, type PolicyGrant } from '#domain/index.js';
import { ApprovalApplication, PolicyAdministrationApplication, PolicyTemplateUpgrade } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const executionIds = ['first-run-runs', 'first-run-pools', 'first-run-attempts', 'first-run-work-targets'];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(edit: (grants: readonly PolicyGrant[]) => readonly unknown[] = grants => grants) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-template-rollback-')); closers.push(() => rm(root, { recursive: true, force: true }));
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const }, ledger = join(root, 'ledger.db');
  openSqliteLedger(ledger, sqlite).close();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock), { principal } = await sessions.verifySession(undefined);
  const template = firstRunPolicyTemplate({ scopeId: 's', principal, ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json'), archive = join(root, 'authority-revisions');
  await writeFile(policyPath, JSON.stringify({ ...template.policy, grants: edit(template.policy.grants) }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: archive, ownerUid: process.getuid!(), maxBytes: 65_536 });
  const effects = await openSqliteAttemptStore(ledger, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid'); closers.push(() => effects.close());
  const journal = openSqliteApprovalStore(ledger, sqlite); closers.push(() => journal.close());
  const integrity = createHmacIntegrity('key', randomBytes(32)), events: AuditEvent[] = [];
  const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
    requestTtlMs: 60_000, audit: event => { events.push(event); } });
  let cards = 0;
  const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => {
    cards++;
    expect(journal.store.list('s', null, 10)).toHaveLength(1);
    return new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, source, integrity, clock, 'local-runtime', 10)
      .decide({ schemaVersion: 1, scopeId: 's', approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
  };
  const upgrade = new PolicyTemplateUpgrade({ administration, approve, policy: source }, names);
  return { events, archive, get cards() { return cards; }, bytes: () => readFile(policyPath, 'utf8'),
    rollback: (expect?: string) => upgrade.run({ scopeId: 's', principal, mode: 'rollback', reason: 'v10 rollback', ...(expect ? { expect } : {}) }) };
}

describe.skipIf(process.platform !== 'linux')('v10 rollback through the real approval and archived authority writer', () => {
  it('approves the operation card, removes only v10 rules, preserves the only administration grants, and refuses stale replay', async () => {
    const f = await fixture(), before = JSON.parse(await f.bytes());
    expect(await f.rollback('stale')).toMatchObject({ status: 'conflict' });
    expect(f.cards).toBe(0); expect(await f.bytes()).toBe(JSON.stringify(before));
    expect(await f.rollback()).toMatchObject({ status: 'rolled-back', reason: executionIds.join(',') });
    expect(f.cards).toBe(1);
    const after = JSON.parse(await f.bytes());
    expect(after.grants).toEqual(before.grants.filter((grant: { id: string }) => !executionIds.includes(grant.id)));
    expect(after.grants.some((grant: { id: string }) => grant.id === 'first-run-policy-administer')).toBe(true);
    expect(after.grants.some((grant: { id: string }) => grant.id === 'first-run-approvals')).toBe(true);
    expect(f.events.filter(event => event.subject.kind === 'authority-change')).toHaveLength(1);
    const entries = await readdir(f.archive); expect(entries).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(f.archive, entries[0]!), 'utf8'));
    expect(receipt).toMatchObject({ state: 'committed', before: { policy: before }, after: { policy: after } });
    const kept = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'nothing-to-roll-back' });
    expect(await f.bytes()).toBe(kept); expect(f.cards).toBe(1);
  });

  it('keeps the lockout guard when a custom current-version id carries the only administration authority', async () => {
    const f = await fixture(grants => grants.filter(rule => rule.id !== 'first-run-policy-administer').map(rule => rule.id === 'first-run-runs'
      ? { ...rule, actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] } } : rule));
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: expect.arrayContaining(['lockout']) });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0); expect(f.events).toEqual([]);
  });

  it('refuses rollback through I2 when a narrower Run card restricts current execution authority', async () => {
    const f = await fixture(grants => [...grants, { ...grants.find(rule => rule.id === 'first-run-runs')!, id: 'run-card',
      effect: 'require-approval', actions: ['create'], resource: { kind: 'run', ids: ['one'] } }]);
    const before = await f.bytes();
    expect(await f.rollback()).toMatchObject({ status: 'refused', missing: ['delegation'] });
    expect(await f.bytes()).toBe(before); expect(f.cards).toBe(0); expect(f.events).toEqual([]);
  });
});
