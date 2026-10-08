import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolveTerminalModel } from '#adapters/index.js';
import { configuredTerminalModel, createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { describeTerminalChat } from '#composition/core/terminal-chat/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { clearConfigCache, getConfigFieldDefault, loadConfig, prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';

// T4-B D1 (owner 2026-10-08, Jev d84b248d): `terminal.defaultModel` is the person's own default (user layer only); the terminal's model follows
// one precedence — session pin > project `terminal.chat.reference` > user `terminal.defaultModel` > user `terminal.chat.reference` — and the
// default is written by the governed `/config` writer (policy, approval, audit), creating the user file when there is none.
const ref = (modelId: string) => ({ providerId: 'p', providerVersion: 1, modelId, modelVersion: 1 });
const chat = (modelId: string) => ({ schemaVersion: 1, reference: ref(modelId), maxCompletionTokens: 64 });

describe('terminal model precedence (pure)', () => {
  it('pin > project chat.reference > user defaultModel > user chat.reference > none', () => {
    const global = { terminal: { defaultModel: ref('mine'), chat: chat('user') } }, project = { terminal: { chat: chat('team') } };
    expect(resolveTerminalModel({ global, project }, ref('pinned'))).toEqual({ reference: ref('pinned'), source: 'session' });
    expect(resolveTerminalModel({ global, project })).toEqual({ reference: ref('team'), source: 'project' });
    expect(resolveTerminalModel({ global, project: {} })).toEqual({ reference: ref('mine'), source: 'user-default' });
    // A project that authors only another chat member (not the reference) does not choose the model.
    expect(resolveTerminalModel({ global, project: { terminal: { chat: { maxCompletionTokens: 32 } } } })).toEqual({ reference: ref('mine'), source: 'user-default' });
    expect(resolveTerminalModel({ global: { terminal: { chat: chat('user') } }, project: {} })).toEqual({ reference: ref('user'), source: 'user' });
    expect(resolveTerminalModel({ global: {}, project: {} })).toBeNull();
    // A malformed authored value never chooses (the loader refuses it on its own path).
    expect(resolveTerminalModel({ global: { terminal: { defaultModel: { modelId: 'x' } } }, project: {} })).toBeNull();
  });
});

beforeEach(context => {
  if (process.platform !== 'linux') context.skip('LOCAL_OS_SESSION: deciding needs the Linux live OS session identity (/proc), as the approval suites');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type Grant = Record<string, unknown>;
async function setup(grants: (principals: unknown) => readonly Grant[]) {
  const root = await mkdtemp(join(tmpdir(), 'default-model-')); roots.push(root);
  const globalHome = join(root, 'global'), options = { env: { DECKENT_GLOBAL_HOME: globalHome } };
  await applyPolicyTemplateInstallation(root, 'installation');
  const layout = resolveProductLayout({ projectRoot: root });
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close();
  await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
  const principal = await resolveConfiguredConfigPrincipal(root, 'installation', options);
  const policyPath = productResourcePath(layout, 'policy'), principals = [{ issuer: principal.issuer, subject: principal.subject }];
  const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: Grant[] };
  // The first-run config rule is replaced by the test's own (allow, or ask for the user default).
  policy.grants = [...policy.grants.filter(grant => grant['id'] !== 'first-run-config'), ...grants(principals),
    { id: 'test-approvals', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['installation'], principals, resource: { kind: 'approval', ids: 'all' } }];
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
  const audits = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT record FROM audit_events ORDER BY rowid').all()
    .map(row => (JSON.parse(String(row['record'])) as { event: { subject: Record<string, unknown> } }).event.subject); } finally { db.close(); } };
  const app = createConfiguredConfigApplication(root, options);
  return { root, options, app, globalHome, principal, audits };
}
const findGlobalFile = async (home: string) => {
  const { resolveGlobalConfigPaths } = await import('#platform/index.js');
  return resolveGlobalConfigPaths({ DECKENT_GLOBAL_HOME: home }).platformPath;
};

describe('terminal.defaultModel through the governed writer', () => {
  it('creates the user file when there is none, audits the change, and the project layer can never hold the key', async () => {
    const f = await setup(principals => [{ id: 'allow-config', effect: 'allow', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: 'all' } }]);
    const path = await findGlobalFile(f.globalHome);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const outcome = await f.app.submit('set', { principal: f.principal, scopeId: 'installation', commandId: 'default-1', layer: 'global', keyPath: 'terminal.defaultModel', value: ref('mine') });
    expect(outcome).toMatchObject({ status: 'applied', result: { layer: 'global', keyPath: 'terminal.defaultModel', beforeDigest: null } });
    expect(JSON.parse(await readFile(path, 'utf8')).terminal.defaultModel).toEqual(ref('mine'));
    expect(f.audits().filter(subject => subject['kind'] === 'config-change')).toEqual([expect.objectContaining({ layer: 'global', keyPath: 'terminal.defaultModel', action: 'set', commandId: 'default-1' })]);
    // The project file cannot carry it: the write is refused, and a hand-edited project file is refused at load.
    await expect(f.app.submit('set', { principal: f.principal, scopeId: 'installation', commandId: 'default-2', layer: 'project', keyPath: 'terminal.defaultModel', value: ref('team') }))
      .rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
    await writeFile(join(f.root, '.deckent/config.json'), JSON.stringify({ terminal: { defaultModel: ref('team') } }));
    clearConfigCache();
    await expect(loadConfig(f.root, { ...f.options, heal: false })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION', message: expect.stringContaining('TERMINAL_DEFAULT_MODEL_PROJECT_LAYER') });
  });

  it('a require-approval rule turns the write into a pending card; after allow the same command applies once', async () => {
    const f = await setup(principals => [
      { id: 'allow-config', effect: 'allow', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: ['project:language'] } },
      { id: 'ask-default', effect: 'require-approval', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: ['global:terminal.defaultModel'] } }]);
    const input = { principal: f.principal, scopeId: 'installation', commandId: 'default-ask', layer: 'global' as const, keyPath: 'terminal.defaultModel', value: ref('mine') };
    const pending = await f.app.submit('set', input);
    expect(pending).toMatchObject({ status: 'approval-pending', layer: 'global', keyPath: 'terminal.defaultModel' });
    if (pending.status !== 'approval-pending') throw new Error('expected pending');
    await expect(readFile(await findGlobalFile(f.globalHome), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await configuredApproval(f.root, 'decide', { schemaVersion: 1, scopeId: 'installation', approvalId: pending.approval.approvalId, commandId: 'decide-1', expectedRevision: 0,
      decision: 'allow', reason: 'Allowed in the terminal', channel: 'local-terminal-card' }, f.options);
    const applied = await f.app.submit('set', { ...input, expect: pending.expect });
    expect(applied).toMatchObject({ status: 'applied', approvalId: pending.approval.approvalId });
    expect(f.audits().filter(subject => subject['kind'] === 'config-change')).toEqual([expect.objectContaining({ keyPath: 'terminal.defaultModel', approvalId: pending.approval.approvalId })]);
  });

  it('the terminal plan and the turn read the same winner: project chat model, else the user default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'default-model-plan-')); roots.push(root);
    const home = join(root, 'global'), options = { env: { DECKENT_GLOBAL_HOME: home } };
    const catalog = { schemaVersion: 1, revision: 'c1', providers: [{ id: 'p', version: 1, models: ['team', 'mine'].map(id => ({ id, version: 1, nativeId: `n-${id}`,
      protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] })) }] };
    await mkdir(join(root, '.deckent'), { recursive: true });
    const globalPath = await findGlobalFile(home); await mkdir(join(globalPath, '..'), { recursive: true });
    await writeFile(globalPath, JSON.stringify({ terminal: { defaultModel: ref('mine'), chat: chat('user') }, provider_catalog: catalog }));
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { chat: chat('team') } }));
    clearConfigCache();
    expect(await describeTerminalChat(root, options)).toMatchObject({ status: 'ready', reference: ref('team'), source: 'project' });
    expect(await configuredTerminalModel(root, options, ref('pinned'))).toEqual({ reference: ref('pinned'), source: 'session' });
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({}));
    clearConfigCache();
    expect(await describeTerminalChat(root, options)).toMatchObject({ status: 'ready', reference: ref('mine'), source: 'user-default', maxCompletionTokens: 64 });
  });
});
