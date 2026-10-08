import { configPanelPort } from '#surfaces/core/config/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { approvalSubject, type ApprovalRecord } from '#domain/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';

// T3 L2 CONFIG-APPROVAL (Jev f0214347 + 9181d2be) through the real configured path: the installed policy, the ledger's approval store, the
// one decision path (`configuredApproval`, which the terminal window and /approvals use) and the atomic config writer with its sealed audit.
beforeEach(context => {
  if (process.platform !== 'linux') context.skip('LOCAL_OS_SESSION: deciding needs the Linux live OS session identity (/proc), as the approval suites');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Grant = Record<string, unknown>;
async function setup(extra: (principals: unknown) => readonly Grant[] = principals => [
  { id: 'company-config-approval', effect: 'require-approval', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:max_workers'] } }]) {
  const root = await mkdtemp(join(tmpdir(), 'config-approval-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  await applyPolicyTemplateInstallation(root, 'installation');
  const layout = resolveProductLayout({ projectRoot: root });
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close();
  // First-start bootstrap in miniature: the approval integrity key exists before any read of the approval list (decisions only read it).
  await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
  const principal = await resolveConfiguredConfigPrincipal(root, 'installation', options);
  const policyPath = productResourcePath(layout, 'policy');
  const writePolicy = async (grants: (principals: unknown) => readonly Grant[]) => {
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: Grant[] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
    policy.grants = [...policy.grants.filter(grant => !String(grant['id']).startsWith('company-') && grant['id'] !== 'test-approvals'), ...grants(principals),
      { id: 'test-approvals', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['installation'], principals, resource: { kind: 'approval', ids: 'all' } }];
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
  };
  await writePolicy(extra);
  const app = createConfiguredConfigApplication(root, options), path = join(root, '.deckent/config.json');
  const audits = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT record FROM audit_events ORDER BY rowid').all()
    .map(row => JSON.parse(String(row['record'])) as { event: { subject: Record<string, unknown> } }); } finally { db.close(); } };
  const assurance = async (rule: Record<string, unknown> | null) => {
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { approvalAssurance?: Record<string, unknown>[] };
    policy.approvalAssurance = [...(policy.approvalAssurance ?? []).filter(item => item['id'] !== 'company-config-assurance'), ...(rule ? [rule] : [])];
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
  };
  const auditCount = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return Number(db.prepare('SELECT count(*) AS n FROM audit_events').get()!['n']); } finally { db.close(); } };
  const list = async () => await configuredApproval(root, 'list', { schemaVersion: 1, scopeId: 'installation', afterId: null, limit: 50 }, options) as ApprovalRecord[];
  const decide = (approvalId: string, decision: 'allow' | 'deny', commandId: string) => configuredApproval(root, 'decide', { schemaVersion: 1, scopeId: 'installation', approvalId,
    commandId, expectedRevision: 0, decision, reason: decision === 'allow' ? 'Allowed in the terminal' : 'Denied in the terminal', channel: 'local-terminal-card' }, options);
  const command = { principal, scopeId: 'installation', layer: 'project' as const };
  return { root, options, app, path, command, auditCount, audits, assurance, list, decide, writePolicy };
}
const bytesOf = async (path: string) => { try { return await readFile(path, 'utf8'); } catch { return null; } };

describe('config-change approval: request, decision, apply', () => {
  it('opens a pending config-change approval and writes nothing; the window/approvals record says what changes; an allow applies the same command once, audited', async () => {
    const f = await setup();
    await f.app.set({ ...f.command, commandId: 'seed', keyPath: 'language', value: 'en' }); // an allowed key writes directly, as before
    const before = await bytesOf(f.path), audits = f.auditCount();
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-1', keyPath: 'max_workers', value: 2 });
    expect(pending).toMatchObject({ status: 'approval-pending', commandId: 'cmd-1', keyPath: 'max_workers', layer: 'project', approval: { revision: 0 } });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    expect(pending.approval.summary).toBe('Setting will change: max_workers auto → 2 (project)');
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits);
    // Visible where every approval is decided: the same list the terminal's /approvals and the approval window read.
    const [record] = (await f.list()).filter(item => approvalSubject(item.request).kind === 'config-change');
    expect(record!.request.approvalId).toBe(pending.approval.approvalId);
    expect(approvalSubject(record!.request)).toMatchObject({ kind: 'config-change', commandId: 'cmd-1', action: 'set', layer: 'project', keyPath: 'max_workers',
      before: '"auto"', after: '2', expectDigest: pending.expect, ruleId: 'company-config-approval' });
    // Asking again before a decision is the same request (no second card).
    expect(await f.app.submit('set', { ...f.command, commandId: 'cmd-1', keyPath: 'max_workers', value: 2, expect: pending.expect })).toEqual(pending);
    await f.decide(pending.approval.approvalId, 'allow', 'decide-1');
    const applied = await f.app.submit('set', { ...f.command, commandId: 'cmd-1', keyPath: 'max_workers', value: 2, expect: pending.expect });
    expect(applied).toMatchObject({ status: 'applied', approvalId: pending.approval.approvalId, result: { keyPath: 'max_workers', layer: 'project', beforeDigest: pending.expect } });
    expect(JSON.parse((await bytesOf(f.path))!).max_workers).toBe(2); expect(f.auditCount()).toBe(audits + 1);
    // Lead 2026-10-07 (karar 3): the applied write's audit record names the approval it consumed, next to its command id; a write
    // that needed no approval keeps the earlier shape (no approvalId member at all).
    const written = f.audits().map(item => item.event.subject).filter(subject => subject['kind'] === 'config-change');
    expect(written.at(-1)).toMatchObject({ action: 'set', keyPath: 'max_workers', commandId: 'cmd-1', approvalId: pending.approval.approvalId, beforeDigest: pending.expect });
    expect(written.find(subject => subject['commandId'] === 'seed')).not.toHaveProperty('approvalId');
    // Single use: the layer moved, so the same command never applies twice (typed, nothing written).
    const after = await bytesOf(f.path);
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-1', keyPath: 'max_workers', value: 2, expect: pending.expect })).rejects.toMatchObject({ code: 'CONFIG_APPROVAL_STALE' });
    // Without --expect the same command id previews the new layer: another change, another request — never the old allow.
    expect(await f.app.submit('set', { ...f.command, commandId: 'cmd-1', keyPath: 'max_workers', value: 2 })).toMatchObject({ status: 'approval-pending' });
    expect(await bytesOf(f.path)).toBe(after); expect(f.auditCount()).toBe(audits + 1);
  });

  it('unset is approval-held the same way (after = removed, no value digest)', async () => {
    const f = await setup(() => []); await f.app.set({ ...f.command, commandId: 'seed', keyPath: 'max_workers', value: 3 });
    await f.writePolicy(principals => [{ id: 'company-config-approval', effect: 'require-approval', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:max_workers'] } }]);
    const pending = await f.app.submit('unset', { ...f.command, commandId: 'cmd-unset', keyPath: 'max_workers' });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    expect(pending.approval.summary).toBe("Setting will be removed: max_workers 3 → the next layer's value (project)");
    const [record] = (await f.list()).filter(item => approvalSubject(item.request).kind === 'config-change');
    expect(approvalSubject(record!.request)).toMatchObject({ action: 'unset', before: '3', after: null, valueDigest: null });
    await f.decide(pending.approval.approvalId, 'allow', 'decide-unset');
    expect(await f.app.submit('unset', { ...f.command, commandId: 'cmd-unset', keyPath: 'max_workers', expect: pending.expect })).toMatchObject({ status: 'applied' });
    expect(JSON.parse((await bytesOf(f.path))!).max_workers).toBeUndefined();
  });
});

describe('config permissions read for the /config window (T3 L4)', () => {
  it('one policy read says allow, require-approval (with its rule) and deny per key and layer; secrets are refused; nothing is written or audited', async () => {
    const f = await setup(principals => [
      { id: 'company-config-approval', effect: 'require-approval', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:max_workers'] } },
      { id: 'company-config-deny', effect: 'deny', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:language'] } }]);
    const before = await bytesOf(f.path), audits = f.auditCount();
    const read = await f.app.permissions({ principal: f.command.principal, scopeId: 'installation', keys: ['max_workers', 'language', 'terminal.theme', 'secrets.token'], layers: ['project'] });
    expect(read).toEqual([
      { keyPath: 'max_workers', layer: 'project', decision: 'require-approval', ruleId: 'company-config-approval' },
      { keyPath: 'language', layer: 'project', decision: 'deny', ruleId: null },
      { keyPath: 'terminal.theme', layer: 'project', decision: 'allow', ruleId: expect.any(String) },
      { keyPath: 'secrets.token', layer: 'project', decision: 'refused', ruleId: null }]);
    // The same decisions the write meets: the denied key is refused, the approval-held one opens a card instead of writing.
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-deny', keyPath: 'language', value: 'tr' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits);
  });
});

describe('config-change approval: negative paths (nothing is written)', () => {
  it('no policy permission: POLICY_DENIED before any card; the secrets section is refused before policy', async () => {
    const f = await setup(principals => [{ id: 'company-config-deny', effect: 'deny', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:max_workers'] } }]);
    const before = await bytesOf(f.path), audits = f.auditCount();
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-d', keyPath: 'max_workers', value: 2 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-s', keyPath: 'secrets.backend', value: 'should-never-print' })).rejects.toMatchObject({ code: 'CONFIG_SECRET_SECTION_REFUSED' });
    // Another principal (not the verified one) is refused whatever the policy says.
    await expect(f.app.submit('set', { ...f.command, principal: { ...f.command.principal, subject: 'other' }, commandId: 'cmd-o', keyPath: 'max_workers', value: 2 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits); expect(await f.list()).toEqual([]);
  });

  it('a denied approval is a typed refusal on resubmission; an invalid value never opens a card', async () => {
    const f = await setup(), before = await bytesOf(f.path);
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-bad', keyPath: 'max_workers', value: -1 })).rejects.toThrow();
    expect(await f.list()).toEqual([]);
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-deny', keyPath: 'max_workers', value: 2 });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    await f.decide(pending.approval.approvalId, 'deny', 'decide-deny');
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-deny', keyPath: 'max_workers', value: 2, expect: pending.expect })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(await bytesOf(f.path)).toBe(before);
  });

  it('expiry: a request not decided within approvals.requestTtlMs writes nothing; the resubmission is APPROVAL_EXPIRED', async () => {
    const f = await setup();
    await f.app.set({ ...f.command, commandId: 'seed-ttl', keyPath: 'approvals.requestTtlMs', value: 50 }); // an allowed key: a short request lifetime
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-ttl', keyPath: 'max_workers', value: 2 });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    expect(pending.approval.expiresAt - Date.now()).toBeLessThanOrEqual(50);
    const before = await bytesOf(f.path), audits = f.auditCount();
    await new Promise(resolve => setTimeout(resolve, 120));
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-ttl', keyPath: 'max_workers', value: 2, expect: pending.expect })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits);
    const [record] = (await f.list()).filter(item => approvalSubject(item.request).kind === 'config-change');
    expect(record!.status).toBe('expired');
  });

  it('a raised assurance (policy approvalAssurance on config-change) must be met: a peer-session allow is refused, the request stays pending, nothing is written', async () => {
    const f = await setup();
    await f.assurance({ id: 'company-config-assurance', scopes: 'all', subject: 'config-change', minimum: 'turn-bound' });
    const before = await bytesOf(f.path), audits = f.auditCount();
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-assure', keyPath: 'max_workers', value: 2 });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    const [record] = (await f.list()).filter(item => approvalSubject(item.request).kind === 'config-change');
    expect(record!.request).toMatchObject({ facts: { requiredAssurance: 'turn-bound' } });
    // The decider here is a session peer (no turn-bound capability): below the raised minimum, the allow is refused at decision time.
    await expect(f.decide(pending.approval.approvalId, 'allow', 'decide-assure')).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
    expect((await f.list()).find(item => item.request.approvalId === pending.approval.approvalId)!.status).toBe('pending');
    expect(await f.app.submit('set', { ...f.command, commandId: 'cmd-assure', keyPath: 'max_workers', value: 2, expect: pending.expect })).toMatchObject({ status: 'approval-pending' });
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits);
    // The same rule on another subject kind leaves config approvals at Core's minimum: a peer-session allow then applies.
    await f.assurance({ id: 'company-config-assurance', scopes: 'all', subject: 'operation', minimum: 'turn-bound' });
    const other = await f.app.submit('set', { ...f.command, commandId: 'cmd-peer', keyPath: 'max_workers', value: 3 });
    if (other.status !== 'approval-pending') throw new Error('expected pending');
    await f.decide(other.approval.approvalId, 'allow', 'decide-peer');
    expect(await f.app.submit('set', { ...f.command, commandId: 'cmd-peer', keyPath: 'max_workers', value: 3, expect: other.expect })).toMatchObject({ status: 'applied' });
  });

  it('digest race: the layer changed after the preview — the allowed change is not applied (CONFIG_APPROVAL_STALE), the other writer’s bytes stay', async () => {
    const f = await setup();
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-race', keyPath: 'max_workers', value: 2 });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    await f.decide(pending.approval.approvalId, 'allow', 'decide-race');
    await writeFile(f.path, `${JSON.stringify({ schema_version: 4, language: 'tr' })}\n`); const changed = await bytesOf(f.path), audits = f.auditCount();
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-race', keyPath: 'max_workers', value: 2, expect: pending.expect })).rejects.toMatchObject({ code: 'CONFIG_APPROVAL_STALE' });
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-race', keyPath: 'max_workers', value: 2 })).resolves.toMatchObject({ status: 'approval-pending' });
    expect(await bytesOf(f.path)).toBe(changed); expect(f.auditCount()).toBe(audits);
  });

  it('policy is checked again at apply: a deny after the allow refuses the write', async () => {
    const f = await setup(), before = await bytesOf(f.path);
    const pending = await f.app.submit('set', { ...f.command, commandId: 'cmd-p', keyPath: 'max_workers', value: 2 });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    await f.decide(pending.approval.approvalId, 'allow', 'decide-p');
    await f.writePolicy(principals => [{ id: 'company-config-deny', effect: 'deny', actions: ['write'], scopes: ['installation'], principals, resource: { kind: 'config', ids: ['project:max_workers'] } }]);
    await expect(f.app.submit('set', { ...f.command, commandId: 'cmd-p', keyPath: 'max_workers', value: 2, expect: pending.expect })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await bytesOf(f.path)).toBe(before);
  });

  it('a mode-eligible rule is still held for a human: no permission mode (full-auto, full-access) lowers a config approval', async () => {
    const f = await setup(principals => [{ id: 'company-config-approval', effect: 'require-approval', modeEligible: true, actions: ['write'], scopes: ['installation'], principals,
      resource: { kind: 'config', ids: ['project:max_workers'] } }]);
    const before = await bytesOf(f.path);
    expect(await f.app.submit('set', { ...f.command, commandId: 'cmd-mode', keyPath: 'max_workers', value: 2 })).toMatchObject({ status: 'approval-pending' });
    expect(await bytesOf(f.path)).toBe(before);
  });

  it('the allow-only paths keep their contract: set/unset (toolchain refresh) still refuse require-approval as POLICY_APPROVAL_UNSUPPORTED', async () => {
    const f = await setup(), before = await bytesOf(f.path);
    await expect(f.app.set({ ...f.command, commandId: 'cmd-legacy', keyPath: 'max_workers', value: 2 })).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(await bytesOf(f.path)).toBe(before); expect(await f.list()).toEqual([]);
    expect((await readdir(join(f.root, '.deckent'))).filter(name => name.includes('.bak.'))).toHaveLength(0);
  });
});


describe('CS-1 selection through the real governed panel port', () => {
  it('the picked value waits for approval, resubmits the same command after allow, and writes one sealed audit event', async () => {
    const f = await setup();
    await f.app.set({ ...f.command, commandId: 'seed-scope', keyPath: 'terminal.scopeId', value: 'installation' });
    const port = configPanelPort(f.root, { configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal }, f.options, 'en');
    const view = await port.inspect(), workers = view.fields.find(field => field.key === 'max_workers')!;
    expect(workers.free).toBe(false); expect(workers.choices.some(choice => choice.value === 'auto')).toBe(true);
    expect(workers.locks.project.note).toContain('approval');
    const picked = workers.choices.find(choice => choice.value === 2)!;
    const before = await bytesOf(f.path), audits = f.auditCount();
    const request = { action: 'set' as const, keyPath: workers.key, value: picked.value, layer: 'project' as const };
    const pending = await port.write(request);
    expect(pending.status).toBe('approval-pending'); expect(pending.approvalId).toBeTruthy();
    expect(await bytesOf(f.path)).toBe(before); expect(f.auditCount()).toBe(audits);
    await f.decide(pending.approvalId!, 'allow', 'allow-panel-selection');
    const applied = await port.write(request); expect(applied).toMatchObject({ status: 'applied', approvalId: pending.approvalId });
    expect(JSON.parse((await bytesOf(f.path))!).max_workers).toBe(2); expect(f.auditCount()).toBe(audits + 1);
    expect(f.audits().at(-1)!.event.subject).toMatchObject({ kind: 'config-change', approvalId: pending.approvalId, keyPath: 'max_workers' });
  });
});
