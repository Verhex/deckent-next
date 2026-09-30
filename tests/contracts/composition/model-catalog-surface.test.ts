import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, inspectModelCatalog } from '../../../src/index.js';
import { readPackagedModelCatalog } from '../../../src/composition/core/model-activation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

/** WORKER-CURRENCY-2: the ledger model catalog through CLI `models catalog`, MCP and SDK — one application contract, one authority. */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const TABLES = ['model_catalog_channels', 'model_catalog_models', 'model_catalog_activations', 'model_catalog_receipts'];

async function fixture(catalogScopes: 'all' | readonly string[] = 'all', inspect = true) {
  const project = await mkdtemp(join(tmpdir(), 'dn-catalog-surface-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const env = { HOME: join(project, 'h') }, options = { env };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const { store, path } = await openConfiguredAttemptStore(project, options); store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (scopes: 'all' | readonly string[]) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: `p-${String(scopes)}`, restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s', 'b'], principals, resource: { kind: 'scope', ids: ['s', 'b'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate', ...(inspect ? ['inspect'] : [])], scopes, principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  await policy(catalogScopes);
  const tables = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return TABLES.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()); } finally { db.close(); } };
  const cli = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(['models', 'catalog', ...argv], { root: project, env, initialize() {}, stdout: { write(value: string) { out.push(value); } },
      stderr: { write(value: string) { err.push(value); } }, applyModelCatalog: applyModelCatalog as never, inspectModelCatalog: inspectModelCatalog as never, readPackagedModelCatalog });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  return { project, options, path, tables, cli, policy };
}
async function mcp(applications: Partial<McpApplications>) {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; }, ...applications } as McpApplications,
    { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'catalog-surface-test', version: '1' }); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe.skipIf(process.platform === 'win32')('model catalog operator surface (WORKER-CURRENCY-2)', () => {
  it('seeds the packaged document idempotently: same command id replays, a new command id changes nothing', async () => {
    const f = await fixture();
    const first = await f.cli('register', '--scope', 's', '--command-id', 'seed-1', '--seed', 'claude-cli-subscription', '--json');
    expect(first.code).toBe(0);
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({ replayed: false, receipt: { command: { action: 'register', commandId: 'seed-1' }, authorizations: [{ level: 'installation' }] } });
    expect(receipt.receipt.changes.map((change: { kind: string; modelId: string | null }) => `${change.kind}:${change.modelId}`)).toEqual([`channel:null`,
      'model:claude-fable-5-1', 'model:claude-haiku-4-5-20251001', 'model:claude-opus-5-5', 'model:claude-sonnet-5-5']);
    const facts = f.tables();
    const replay = JSON.parse((await f.cli('register', '--scope', 's', '--command-id', 'seed-1', '--seed', 'claude-cli-subscription', '--json')).stdout);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(f.tables()).toEqual(facts);
    const again = JSON.parse((await f.cli('register', '--scope', 's', '--command-id', 'seed-2', '--seed', 'claude-cli-subscription', '--json')).stdout);
    expect(again.receipt.changes).toEqual([]);
    const [channels, models, activations, receipts] = f.tables();
    expect([channels, models, activations]).toEqual(facts.slice(0, 3)); expect(receipts).toHaveLength(2);
    // The packaged document and the one the SDK reads are the same bytes.
    expect(await readPackagedModelCatalog('claude-cli-subscription')).toEqual(await seedCatalog());
    for (const name of ['../package', 'missing-seed']) expect((await f.cli('register', '--scope', 's', '--command-id', 'x', '--seed', name)).code).toBe(2);
    // An operator document from a file: invalid JSON and an invalid catalog are typed; a valid edit writes only what changed.
    await writeFile(join(f.project, 'bad.json'), '{'); await writeFile(join(f.project, 'wrong.json'), JSON.stringify({ schemaVersion: 1 }));
    expect((await f.cli('register', '--scope', 's', '--command-id', 'f1', '--file', 'bad.json')).stderr).toContain('CLI_CATALOG_INPUT_INVALID');
    expect((await f.cli('register', '--scope', 's', '--command-id', 'f2', '--file', 'wrong.json')).stderr).toContain('MODEL_CATALOG_INVALID');
    const edited = await seedCatalog(); edited.revision = 'operator-edit'; edited.providers[0].models[0].lifecycle.state = 'deprecated';
    edited.providers[0].models[0].lifecycle.deprecatedOn = '2026-09-30'; await writeFile(join(f.project, 'edit.json'), JSON.stringify(edited));
    const changed = JSON.parse((await f.cli('register', '--scope', 's', '--command-id', 'f3', '--file', 'edit.json', '--json')).stdout);
    expect(changed.receipt.changes).toEqual([{ kind: 'model', channelId: SEED_CHANNEL, modelId: 'claude-fable-5-1', revision: 2 }]);
  });
  it('refuses register for a scope-only principal (installation facts unchanged) while it may activate in its scope; lists per scope in en/tr', async () => {
    const admin = await fixture();
    expect((await admin.cli('register', '--scope', 's', '--command-id', 'seed', '--seed', 'claude-cli-subscription')).code).toBe(0);
    // A model-activation grant limited to scope s: register (installation facts) is refused and writes nothing …
    await admin.policy(['s']); const before = admin.tables();
    const edited = await seedCatalog(); edited.providers[0].models[0].lifecycle.state = 'retired'; edited.providers[0].models[0].lifecycle.retiredOn = '2026-09-30';
    const refused = await admin.cli('register', '--scope', 's', '--command-id', 'scoped-register', '--seed', 'claude-cli-subscription', '--json');
    expect(refused.code).toBe(1); expect(refused.stderr).toContain('POLICY_DENIED');
    await expect(applyModelCatalog(admin.project, { schemaVersion: 1, commandId: 'sdk-register', scopeId: 's', action: 'register', catalog: edited }, admin.options))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(admin.tables()).toEqual(before);
    // … while it manages its own scope's activation rows, never another scope's.
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--command-id', 'on', '--expected-revision', '0')).code).toBe(0);
    expect((await admin.cli('activate', '--scope', 'b', '--channel', SEED_CHANNEL, '--command-id', 'on-b', '--expected-revision', '0')).stderr).toContain('POLICY_DENIED');
    await admin.policy('all');
    const english = await admin.cli('list', '--scope', 's', '--lang', 'en');
    expect(english.stdout).toContain(`Channel ${SEED_CHANNEL} (native-cli, CLI claude)`); expect(english.stdout).toContain('active in this scope');
    expect(english.stdout).toMatch(/claude-sonnet-5-5 · lifecycle active \(retire 2027-09-28\) · CLI ≥ 2\.1\.284/);
    const turkish = await admin.cli('list', '--scope', 'b', '--lang', 'tr');
    expect(turkish.stdout).toContain('bu kapsamda etkin değil'); expect(turkish.stdout).toContain('b kapsamının gördüğü model kataloğu');
    const json = JSON.parse((await admin.cli('list', '--scope', 's', '--json')).stdout);
    expect(json.channels[0]).toMatchObject({ channelId: SEED_CHANNEL, access: 'allowed', activation: { state: 'active', revision: 1 } });
    expect(json.channels[0].models.find((model: { modelId: string }) => model.modelId === 'claude-sonnet-5-5')).toMatchObject({ activation: null, model: { minCliVersion: '2.1.284' } });
    // Model activation, deactivation, a stale revision and an unknown model are typed; a replay returns the receipt.
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm1', '--expected-revision', '0')).code).toBe(0);
    const stale = await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm2', '--expected-revision', '0');
    expect(stale.stderr).toContain('MODEL_CATALOG_REVISION_CONFLICT');
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-9-9', '--command-id', 'm3', '--expected-revision', '0')).stderr).toContain('MODEL_CATALOG_NOT_FOUND');
    const off = JSON.parse((await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm4', '--expected-revision', '1', '--json')).stdout);
    expect(off.receipt).toMatchObject({ authorizations: [{ level: 'scope', action: 'deactivate' }], changes: [{ kind: 'activation', revision: 2 }] });
    expect(JSON.parse((await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm4', '--expected-revision', '1', '--json')).stdout).replayed).toBe(true);
    // Usage errors never reach the application.
    for (const argv of [['activate', '--scope', 's', '--channel', SEED_CHANNEL, '--command-id', 'x'], ['register', '--scope', 's', '--command-id', 'x'],
      ['register', '--scope', 's', '--command-id', 'x', '--seed', 'a', '--file', 'b'], ['list']]) expect((await admin.cli(...argv)).code).toBe(2);
  });
  it('shows a channel without inspect authority as denied, and serves the same contract over MCP', async () => {
    const f = await fixture('all', false);
    await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'seed', scopeId: 's', action: 'register', catalog: await seedCatalog() }, f.options);
    expect(await inspectModelCatalog(f.project, { schemaVersion: 1, scopeId: 's' }, f.options)).toEqual({ schemaVersion: 1, scopeId: 's', channels: [{ channelId: SEED_CHANNEL, access: 'denied' }] });
    const admin = await fixture();
    const session = await mcp({ inspectModelCatalog: query => inspectModelCatalog(admin.project, query, admin.options),
      applyModelCatalog: command => applyModelCatalog(admin.project, command, admin.options) as never });
    try {
      const catalog = await seedCatalog();
      const applied = await session.client.callTool({ name: 'apply_model_catalog', arguments: { schemaVersion: 1, commandId: 'mcp-seed', scopeId: 's', action: 'register', catalog } });
      expect(applied.isError).not.toBe(true);
      // The SDK replays the MCP command by its id: the same receipt, marked as a replay.
      expect({ ...(applied.structuredContent as object), replayed: true }).toEqual(await applyModelCatalog(admin.project, { schemaVersion: 1, commandId: 'mcp-seed', scopeId: 's', action: 'register', catalog }, admin.options));
      const listed = await session.client.callTool({ name: 'inspect_model_catalog', arguments: { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL } });
      expect(listed.structuredContent).toEqual(await inspectModelCatalog(admin.project, { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL }, admin.options));
      const bad = await session.client.callTool({ name: 'apply_model_catalog', arguments: { schemaVersion: 1, commandId: 'x', scopeId: 's', action: 'register', catalog: { schemaVersion: 1 } } });
      expect(bad.isError).toBe(true);
    } finally { await session.close(); }
  });
});
