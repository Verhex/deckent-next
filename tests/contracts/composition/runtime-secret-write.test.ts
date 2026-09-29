import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, formatHumanError, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout, withConfigWriteLock } from '#platform/index.js';
import { createFileSecretStore, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';

// SECRET-WRITE (owner 2026-09-29, SECRET-K1 §5 option A + S3 = service socket): a secret change goes through the runtime service; the socket
// peer is the principal; the `secret`/`set|delete` policy cell decides it; every decision is a sealed `secret-change` audit event in the
// installation's ledger before any write; the value never reaches the ledger, an error or the service's output. Synthetic canaries only.
registerProviderConfig(); // as every composed entry does before configuration is loaded (the `secrets` section is registered there)
const CANARY = 'synthetic-canary-5c7a1e-not-a-real-key';
const me = { issuer: hostname(), subject: String(userInfo().uid) };
const colleague = { issuer: 'idp.example', subject: 'colleague' };
const roots: string[] = [];
const services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const secretGrant = (effect: 'allow' | 'deny' | 'require-approval', principals: readonly { issuer: string; subject: string }[] = [me],
  actions: 'all' | readonly string[] = ['set', 'delete'], ids: 'all' | readonly string[] = 'all') =>
  ({ id: `secret-${effect}`, effect, actions, scopes: ['installation'], principals, resource: { kind: 'secret', ids } });

async function fixture(input: { readonly backend?: 'file' | 'env' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-write-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  const env: Record<string, string> = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  // A fresh installation: `deckent init policy` (first-run template v2) is the only authority document.
  await applyPolicyTemplateInstallation(project, 'installation');
  // The service's own bounded limits (as every service fixture); the layout stays the default one under the project.
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['installation'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 8, maxConcurrentExecutions: 2,
      headerTimeoutMs: 1000, responseTimeoutMs: 10000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  if ((input.backend ?? 'file') === 'file') await writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.file@1' } }), { mode: 0o600 });
  // The ledger as every service fixture creates it (the service upgrades, it does not create one).
  (await openConfiguredAttemptStore(project, { env })).store.close(); clearConfigCache();
  const layout = resolveProductLayout({ projectRoot: project });
  const policyPath = productResourcePath(layout, 'policy'), ledger = productResourcePath(layout, 'ledger');
  const output: string[] = [];
  const service = await startConfiguredRuntimeService(project, { async onPage(...args: unknown[]) { output.push(JSON.stringify(args)); },
    async onError(...args: unknown[]) { output.push(JSON.stringify(args)); } }, { env });
  services.push(service);
  const client = createConfiguredRuntimeClient(project, { env });
  const file = createFileSecretStore({ root: globalRoot, platform: 'linux' });
  const audit = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row['record'])) as
        { event: { scopeId: string; principal: unknown; policyRevision: string; subject: Record<string, unknown> } }).event);
    } finally { db.close(); }
  };
  const replacePolicy = async (grants: readonly unknown[]) => {
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string }[] };
    await writeFile(policyPath, JSON.stringify({ ...policy, revision: `edited-${grants.length}`,
      grants: [...policy.grants.filter(grant => grant.id !== 'first-run-secret-store' && !grant.id.startsWith('secret-')), ...grants] }), { mode: 0o600 });
  };
  /** Every byte the installation and the service left behind: ledger files, the policy/bindings documents and the service's output. */
  const scanForCanary = async () => {
    const hits: string[] = [];
    for (const name of await readdir(dirname(ledger))) {
      if (!name.startsWith(ledger.split('/').at(-1)!)) continue;
      if ((await readFile(join(dirname(ledger), name))).includes(Buffer.from(CANARY))) hits.push(name);
    }
    if (JSON.stringify(audit()).includes(CANARY)) hits.push('audit-view');
    if (output.join('\n').includes(CANARY)) hits.push('service-output');
    return hits;
  };
  return { project, home, env, globalRoot, client, file, audit, replacePolicy, scanForCanary, output };
}
const changes = (events: readonly { subject: Record<string, unknown> }[]) => events.filter(event => event.subject['kind'] === 'secret-change').map(event => event.subject);

describe.skipIf(process.platform !== 'linux')('secret set/delete through the runtime service (SECRET-WRITE)', () => {
  it('fresh install (template v2): the owner sets and deletes a secret over the socket; audited before each write; the value is only in the store', async () => {
    const f = await fixture();
    const set = await f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN', value: CANARY });
    expect(set).toEqual({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN', action: 'set', backend: 'core.secret-store.file@1', removed: null });
    expect(await f.file.get('PROVIDER_TOKEN')).toBe(CANARY);
    expect((await stat(join(f.globalRoot, 'secrets.json'))).mode & 0o777).toBe(0o600);
    const removed = await f.client.deleteSecret({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN' });
    expect(removed).toMatchObject({ action: 'delete', removed: true });
    expect(await f.client.deleteSecret({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN' })).toMatchObject({ removed: false });
    expect(await f.file.listNames()).toEqual([]);
    const events = f.audit();
    expect(changes(events)).toEqual(['set', 'delete', 'delete'].map(action => ({ kind: 'secret-change', action, name: 'PROVIDER_TOKEN',
      backend: 'core.secret-store.file@1', decision: { effect: 'allow', ruleId: 'first-run-secret-store' } })));
    // The principal is the socket peer (never a request field); the policy revision is the template's.
    expect(events[0]).toMatchObject({ scopeId: 'installation', principal: me, policyRevision: expect.stringContaining('first-run-template-v2') });
    expect(await f.scanForCanary()).toEqual([]);
  }, 60_000);

  it('an existing policy without the grant (a v1 install), another principal\'s grant, or a deny: typed refusal with the grant hint, nothing written, the refusal audited', async () => {
    const f = await fixture();
    await f.replacePolicy([]);
    const refused = await f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'OPENAI_API_KEY', value: CANARY }).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'SECRET_CHANGE_DENIED', params: { action: 'set', name: 'OPENAI_API_KEY' } });
    // The hint's data (action and name) travels as parameters; the catalog text names the exact grant to add (i18n delta, lead-owned) and
    // the error redactor must leave it readable (a name like OPENAI_API_KEY followed by a space would mask the next word).
    const text = formatHumanError(refused as Parameters<typeof formatHumanError>[0], { locale: 'en', env: {}, isTTY: false });
    expect(text).not.toContain('[REDACTED]'); expect(text).toContain('SECRET_CHANGE_DENIED');
    expect(JSON.stringify(refused)).not.toContain(CANARY); expect(text).not.toContain(CANARY);
    await f.replacePolicy([secretGrant('allow', [colleague])]);
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'OPENAI_API_KEY', value: CANARY })).rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED' });
    await f.replacePolicy([secretGrant('allow'), secretGrant('deny', [me], ['delete'], ['KEEP_ME'])]);
    await f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'KEEP_ME', value: CANARY });
    await expect(f.client.deleteSecret({ schemaVersion: 1, scopeId: 'installation', name: 'KEEP_ME' })).rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED', params: { action: 'delete' } });
    await f.replacePolicy([secretGrant('require-approval')]);
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'OTHER', value: CANARY })).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(await f.file.listNames()).toEqual(['KEEP_ME']);
    expect(changes(f.audit()).map(subject => [subject['action'], subject['name'], subject['decision']])).toEqual([
      ['set', 'OPENAI_API_KEY', { effect: 'deny', ruleId: null }], ['set', 'OPENAI_API_KEY', { effect: 'deny', ruleId: null }],
      ['set', 'KEEP_ME', { effect: 'allow', ruleId: 'secret-allow' }], ['delete', 'KEEP_ME', { effect: 'deny', ruleId: 'secret-deny' }],
      ['set', 'OTHER', { effect: 'require-approval', ruleId: 'secret-require-approval' }]]);
    expect(await f.scanForCanary()).toEqual([]);
  }, 60_000);

  it('the environment backend stays read-only: a typed refusal before any decision or audit', async () => {
    const f = await fixture({ backend: 'env' });
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN', value: CANARY }))
      .rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY', params: { backend: 'core.secret-store.env@1' } });
    await expect(f.client.deleteSecret({ schemaVersion: 1, scopeId: 'installation', name: 'PROVIDER_TOKEN' })).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
    expect(changes(f.audit())).toEqual([]);
    expect(await f.scanForCanary()).toEqual([]);
  }, 60_000);

  it('concurrent sets through the service lose nothing (the store\'s write lock); a held lock is a typed refusal after the audited intent', async () => {
    const f = await fixture();
    const names = ['A_ONE', 'A_TWO', 'A_THREE', 'A_FOUR'];
    await Promise.all(names.map((name, index) => f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name, value: `${CANARY}-${index}` })));
    expect(await f.file.listNames()).toEqual([...names].sort());
    for (const [index, name] of names.entries()) expect(await f.file.get(name)).toBe(`${CANARY}-${index}`);
    const held = await withConfigWriteLock(join(f.globalRoot, 'secrets.json'), () =>
      f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'LOCKED', value: CANARY }).then(() => null, (error: unknown) => error), 10_000);
    expect(held).toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
    expect(await f.file.get('LOCKED')).toBeUndefined();
    expect(changes(f.audit()).filter(subject => subject['name'] === 'LOCKED')).toHaveLength(1);
    expect(await f.scanForCanary()).toEqual([]);
  }, 60_000);

  it('the client refuses a malformed name or an empty/oversized value before anything is sent', async () => {
    const f = await fixture();
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'lower', value: CANARY })).rejects.toMatchObject({ code: 'SECRET_NAME_INVALID' });
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'A', value: '' })).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
    await expect(f.client.setSecret({ schemaVersion: 1, scopeId: 'installation', name: 'A', value: 'é'.repeat(40_000) })).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
    expect(changes(f.audit())).toEqual([]);
  }, 60_000);
});
