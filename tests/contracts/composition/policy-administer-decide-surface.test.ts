import { terminalApplication } from '../support/approval-terminal.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { AUTHORITY_DOCUMENT_TARGET_KIND, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, POLICY_ADMINISTER_OPERATION } from '#domain/index.js';
import { PolicyAdministrationApplication } from '#engine/index.js';
import { clearConfigCache, productResourcePath, SystemTrustedClock } from '#platform/index.js';

// POLICY-HARDEN K3 at the composition surface: `configuredApproval` is the function the SDK, the CLI, the runtime service behind MCP
// the terminal card all call to decide approvals. A pending `policy.administer@1` approval (opened by the real
// authority producer over the real ledger) cannot be allowed through it; the request stays pending; the refusal is in the audit ledger.
// A deny is still accepted (it only withdraws the request).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] MCP/SDK/CLI/terminal approval decision: an authority-surface approval stays pending and the refusal is audited; a deny is accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-decide-surface-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options);
  const me = { issuer: hostname(), subject: String(userInfo().uid) };
  const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 2, revision: 'p1', separationOfDuties: [], restrictions: [], grants: [{ id: 'scope-member', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [me], resource: { kind: 'run', ids: 'all' } }],
    roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }] }), { mode: 0o600 });
  await writeFile(productResourcePath(opened.layout, 'bindings'), JSON.stringify({ schemaVersion: 2, revision: 'b1', modes: [],
    bindings: [{ id: 'root', principals: [me], roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] }), { mode: 0o600 });
  await mkdir(productResourcePath(opened.layout, 'audit'), { recursive: true, mode: 0o700 });
  const clock = new SystemTrustedClock();
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
  const integrity = await openLocalIntegrityAuthority(opened.layout, 'authority.key', true);
  const ledger = opened.path;
  const journal = openSqliteApprovalStore(ledger, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' });
  const source = createLayoutPolicySource(opened.layout, userInfo().uid, 65_536);
  const admin = new PolicyAdministrationApplication({ authority: source, policy: source, effects: opened.store, approvals: journal.store, integrity, sessions, clock,
    requestTtlMs: 60_000, audit: () => undefined });
  const ask = async (commandId: string) => {
    const pending = await admin.submit({ schemaVersion: 1, commandId, scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation, target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' },
      idempotencyKey: commandId, expectedVersion: 'p1+b1', input: { schemaVersion: 1, changes: [{ kind: 'grant.add', grant: { id: commandId, effect: 'allow', actions: ['invoke'], scopes: ['s'],
        principals: [me], resource: { kind: 'agent-tool', ids: ['read_file'] } } }] } });
    if (pending.status !== 'approval-pending') throw new Error('pending expected');
    return pending.approval;
  };
  const first = await ask('c1');
  const decide = (approvalId: string, decision: 'allow' | 'deny') => terminalApplication({ project, env: options.env ?? {} }, 'decide', 's', { schemaVersion: 1, scopeId: 's', approvalId, commandId: `d-${decision}-${approvalId}`,
    expectedRevision: 0, decision, reason: 'Reviewed' });
  try {
    await expect(decide(first.approvalId, 'allow')).rejects.toMatchObject({ code: 'APPROVAL_SURFACE_RESTRICTED' });
    expect(journal.store.load('s', first.approvalId)).toMatchObject({ status: 'pending', decision: null });
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      const rows = db.prepare("SELECT record FROM audit_events WHERE kind='authority-refusal'").all().map(row => JSON.parse(String(row.record)).event);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ principal: me, subject: { stage: 'decide', code: 'APPROVAL_SURFACE_RESTRICTED', commandId: 'c1', approvalId: first.approvalId } });
    } finally { db.close(); }
    const second = await ask('c2');
    await expect(decide(second.approvalId, 'deny')).resolves.toMatchObject({ status: 'decided', decision: { decision: 'deny' } });
  } finally { journal.close(); opened.store.close(); }
});
