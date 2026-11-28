import * as witnessAdapters from '#adapters/index.js';
import { personMarkersUnset } from '../support/person-env.js';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitModelActivation, applyModelCatalog, inspectModelActivation, inspectModelBinding, inspectModelCatalog } from '../../../src/index.js';
import { activateConfiguredWorkerModel } from '#composition/core/model-activation/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { modelActivationTargetId, modelCatalogTargetId } from '#engine/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
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
    const run = () => main(['models', 'catalog', ...argv], { root: project, env, initialize() {}, stdout: { write(value: string) { out.push(value); } },
      stderr: { write(value: string) { err.push(value); } }, applyModelCatalog: applyModelCatalog as never, inspectModelCatalog: inspectModelCatalog as never });
    const code = argv[0] === 'activate' ? await asPerson(run) : await run();
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
  it('registers the Codex seed through CLI and renders v3 facts in both human languages with help discovery', async () => {
    const f = await fixture();
    expect((await f.cli('register', '--scope', 's', '--command-id', 'codex-seed', '--seed', 'codex-cli-subscription')).code).toBe(0);
    expect(f.tables()[2]).toEqual([]); // Recommendations never activate anything.
    for (const lang of ['en', 'tr']) {
      const listed = await f.cli('list', '--scope', 's', '--lang', lang);
      expect(listed.code).toBe(0);
      for (const text of ['openai', 'gpt-6.1-sol', 'subscription', '272000', 'ultra', '0.159.2', '2026-10-14']) expect(listed.stdout).toContain(text);
      expect(listed.stdout).toContain(lang === 'en' ? 'canonical gpt-6.1-sol' : 'kanonik kimlik gpt-6.1-sol');
      expect(listed.stdout).toContain(lang === 'en' ? 'not active' : 'etkin değil');
      expect(listed.stdout).not.toContain('"schemaVersion"');
      const help = await f.cli('--help', '--lang', lang);
      expect(help.stdout).toContain('--seed'); expect(help.stdout).toContain('codex-cli-subscription'); expect(help.stdout).toContain('cursor-cli-subscription');
    }
  });
  it('registers the packaged Cursor seed through CLI without activating anything', async () => {
    const f = await fixture();
    expect((await f.cli('register', '--scope', 's', '--command-id', 'cursor-seed', '--seed', 'cursor-cli-subscription')).code).toBe(0);
    expect(f.tables()[2]).toEqual([]);
    const listed = await f.cli('list', '--scope', 's');
    expect(listed.code).toBe(0);
    for (const text of ['cursor-cli-subscription', 'composer-2.5', 'gpt-5.6-sol-xhigh', 'auto']) expect(listed.stdout).toContain(text);
  });
  it('seeds the packaged document idempotently: same command id replays, a new command id changes nothing', async () => {
    const f = await fixture();
    const first = await f.cli('register', '--scope', 's', '--command-id', 'seed-1', '--seed', 'claude-cli-subscription', '--json');
    expect(first.code).toBe(0);
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({ replayed: false, receipt: { command: { action: 'register', commandId: 'seed-1' }, authorizations: [{ level: 'installation' }] } });
    expect(receipt.receipt.changes.map((change: { kind: string; modelId: string | null }) => `${change.kind}:${change.modelId}`)).toEqual([`channel:null`,
      'model:claude-fable-5-1', 'model:claude-fable-5-2', 'model:claude-haiku-4-5-20251001', 'model:claude-haiku-5-5', 'model:claude-opus-5-5', 'model:claude-sonnet-5-5']);
    const facts = f.tables();
    const replay = JSON.parse((await f.cli('register', '--scope', 's', '--command-id', 'seed-1', '--seed', 'claude-cli-subscription', '--json')).stdout);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(f.tables()).toEqual(facts);
    const again = JSON.parse((await f.cli('register', '--scope', 's', '--command-id', 'seed-2', '--seed', 'claude-cli-subscription', '--json')).stdout);
    expect(again.receipt.changes).toEqual([]);
    const [channels, models, activations, receipts] = f.tables();
    expect([channels, models, activations]).toEqual(facts.slice(0, 3)); expect(receipts).toHaveLength(2);
    // The packaged seed is the asset the SDK tests read; a name outside the packaged set is a usage error, a missing one a typed read error.
    expect((await f.cli('register', '--scope', 's', '--command-id', 'x', '--seed', '../package')).code).toBe(2);
    expect(await f.cli('register', '--scope', 's', '--command-id', 'x', '--seed', 'missing-seed')).toMatchObject({ code: 2, stderr: expect.stringContaining('CLI_CATALOG_INPUT_UNAVAILABLE') });
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
    const policyPath = join(admin.project, 'd', 'policy.json'), scopedPolicy = JSON.parse(await readFile(policyPath, 'utf8'));
    for (const modelId of [null, 'claude-sonnet-5-5']) {
      const blockedChild = modelId === null ? 'claude-sonnet-5-5' : null;
      await writeFile(policyPath, JSON.stringify({ ...scopedPolicy, revision: `deny-child-${modelId}`, grants: [...scopedPolicy.grants,
        { ...scopedPolicy.grants[1], id: 'deny-child', effect: 'deny', actions: ['activate'],
          resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: blockedChild })] } }] }));
      const command = { schemaVersion: 1, commandId: `child-denied-${modelId}`, scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId, expectedRevision: 0 };
      await expect(asPerson(() => applyModelCatalog(admin.project, command, admin.options))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(admin.tables()).toEqual(before);
    }
    await admin.policy(['s']);
    // … while it manages its own scope's activation rows, never another scope's.
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--command-id', 'on', '--expected-revision', '0')).code).toBe(0);
    expect((await admin.cli('activate', '--scope', 'b', '--channel', SEED_CHANNEL, '--command-id', 'on-b', '--expected-revision', '0')).stderr).toContain('POLICY_DENIED');
    await admin.policy('all');
    const english = await admin.cli('list', '--scope', 's', '--lang', 'en');
    expect(english.stdout).toContain(`Channel ${SEED_CHANNEL} (native-cli, CLI claude)`); expect(english.stdout).toContain('active in this scope');
    expect(english.stdout).toMatch(/claude-sonnet-5-5 · lifecycle available \(retire 2027-09-28\) · CLI ≥ 2\.1\.284/);
    const turkish = await admin.cli('list', '--scope', 'b', '--lang', 'tr');
    expect(turkish.stdout).toContain('bu kapsamda etkin değil'); expect(turkish.stdout).toContain('b kapsamının gördüğü model kataloğu');
    const json = JSON.parse((await admin.cli('list', '--scope', 's', '--json')).stdout);
    expect(json.channels[0]).toMatchObject({ channelId: SEED_CHANNEL, access: 'allowed', activation: { state: 'active', revision: 1 } });
    expect(json.channels[0].models.find((model: { modelId: string }) => model.modelId === 'claude-sonnet-5-5')).toMatchObject({ activation: { state: 'active', revision: 1 }, model: { minCliVersion: '2.1.284' } });
    // The seed's retired model (its recorded retirement day has passed) is never turned on by the channel.
    expect(json.channels[0].models.find((model: { modelId: string }) => model.modelId === 'claude-haiku-4-5-20251001')).toMatchObject({ activation: null });
    // U2-S4: the channel's activation turned on its never-touched, priced models (rev 1). Deactivation, a stale revision and an unknown model are typed; a replay returns the receipt.
    const stale = await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm2', '--expected-revision', '0');
    expect(stale.stderr).toContain('MODEL_CATALOG_REVISION_CONFLICT');
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-9-9', '--command-id', 'm3', '--expected-revision', '0')).stderr).toContain('MODEL_CATALOG_NOT_FOUND');
    const off = JSON.parse((await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm4', '--expected-revision', '1', '--json')).stdout);
    expect(off.receipt).toMatchObject({ authorizations: [{ level: 'scope', action: 'deactivate' }], changes: [{ kind: 'activation', revision: 2 }] });
    expect(JSON.parse((await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-sonnet-5-5', '--command-id', 'm4', '--expected-revision', '1', '--json')).stdout).replayed).toBe(true);
    // Lead 2026-10-26: a person's explicit activation of a retired model is refused with its retirement day (EN/TR); turning it off stays possible.
    const retiredArgs = ['activate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-haiku-4-5-20251001', '--command-id', 'r1', '--expected-revision', '0'];
    const refusedEn = await admin.cli(...retiredArgs, '--lang', 'en'), refusedTr = await admin.cli(...retiredArgs, '--lang', 'tr');
    expect(refusedEn.code).toBe(1); expect(refusedEn.stderr).toContain('Model claude-haiku-4-5-20251001 was retired on 2026-10-15; it cannot be activated');
    expect(refusedTr.stderr).toContain('claude-haiku-4-5-20251001 modeli 2026-10-15 tarihinde emekliye ayrıldı');
    // A model turned on before its retirement is still turned off: activate it while current, record its retirement, then deactivate.
    const register = async (commandId: string, retiredOn: string | null) => { const catalog = await seedCatalog(); catalog.revision = commandId;
      Object.assign(catalog.providers[0].models.find((model: { nativeId: string }) => model.nativeId === 'claude-haiku-4-5-20251001').lifecycle,
        retiredOn ? { state: 'retired', retiredOn, retireNotBefore: retiredOn } : { state: 'active', retiredOn: null, retireNotBefore: '2099-01-01' });
      await applyModelCatalog(admin.project, { schemaVersion: 1, commandId, scopeId: 's', action: 'register', catalog }, admin.options); };
    await register('current', null);
    expect((await admin.cli('activate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-haiku-4-5-20251001', '--command-id', 'r2', '--expected-revision', '0')).code).toBe(0);
    await register('retired', '2026-10-15');
    expect((await admin.cli('deactivate', '--scope', 's', '--channel', SEED_CHANNEL, '--model', 'claude-haiku-4-5-20251001', '--command-id', 'r3', '--expected-revision', '1')).code).toBe(0);
    // Reopening a channel would also make its already-active worker reachable again.
    const channelArgs = ['--scope', 's', '--channel', SEED_CHANNEL];
    expect((await admin.cli('activate', ...channelArgs, '--model', 'claude-sonnet-5-5',
      '--command-id', 'reactivate-worker', '--expected-revision', '2')).code).toBe(0);
    expect((await admin.cli('deactivate', ...channelArgs, '--command-id', 'close-channel', '--expected-revision', '1')).code).toBe(0);
    const closed = admin.tables();
    await writeFile(policyPath, JSON.stringify({ ...scopedPolicy, revision: 'deny-existing-child', grants: [...scopedPolicy.grants,
      { ...scopedPolicy.grants[1], id: 'deny-existing-child', effect: 'deny', actions: ['activate'],
        resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5' })] } }] }));
    const reopened = await admin.cli('activate', ...channelArgs, '--command-id', 'reopen-channel', '--expected-revision', '2');
    expect(reopened.code).toBe(1); expect(reopened.stderr).toContain('POLICY_DENIED');
    expect(admin.tables()).toEqual(closed);
    await admin.policy('all');
    // Usage errors never reach the application.
    for (const argv of [['activate', '--scope', 's', '--channel', SEED_CHANNEL, '--command-id', 'x'], ['register', '--scope', 's', '--command-id', 'x'],
      ['register', '--scope', 's', '--command-id', 'x', '--seed', 'a', '--file', 'b'], ['list']]) expect((await admin.cli(...argv)).code).toBe(2);
  });
  it('deactivates without an audit seal and preserves the parent-first partial result', async () => {
    const f = await declaredFixture();
    const command = { schemaVersion: 1, commandId: 'on', scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId: f.model.nativeId, expectedRevision: 0 };
    const before = f.tables();
    const unavailable = () => vi.spyOn(witnessAdapters, 'openSqliteAuditStore').mockRejectedValue(ErrorRegistry.createError('AUDIT_UNAVAILABLE'));
    let audit = unavailable();
    try {
      await expect(asPerson(() => applyModelCatalog(f.project, command, f.options))).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
      expect(f.tables()).toEqual(before);
    } finally { audit.mockRestore(); }
    await asPerson(() => applyModelCatalog(f.project, command, f.options));
    const off = { ...command, action: 'deactivate', commandId: 'off', expectedRevision: 1 };
    audit = unavailable();
    try {
      const result = await applyModelCatalog(f.project, off, f.options).catch(error => error);
      expect.soft(result).toMatchObject({ replayed: false, receipt: { changes: [{ kind: 'activation', revision: 2 }] } });
      if (result.replayed === false) await expect(applyModelCatalog(f.project, off, f.options)).resolves.toEqual({ ...result, replayed: true });
    } finally { audit.mockRestore(); }
    // An unsealed parent receipt is verified before its re-run is reported complete.
    const ledger = new DatabaseSync(f.path);
    try {
      const record = JSON.parse(String(ledger.prepare("SELECT record FROM model_catalog_receipts WHERE command_id='off'").get()!['record']));
      record.changes[0].revision += 5;
      ledger.prepare("UPDATE model_catalog_receipts SET record=? WHERE command_id='off'").run(JSON.stringify(record));
    } finally { ledger.close(); }
    await expect.soft(applyModelCatalog(f.project, off, f.options)).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' });
    // A parent receipt the writer returns as a concurrent replay is verified before any child is written.
    const again = { ...command, commandId: 'on-again', expectedRevision: 2 }, openCatalog = witnessAdapters.openSqliteModelCatalogStore;
    const raced = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openCatalog(...args), write = store.apply.bind(store);
      store.apply = async admission => {
        if (admission.command.commandId !== again.commandId) return write(admission);
        await write(admission);
        const db = new DatabaseSync(f.path);
        try {
          const record = JSON.parse(String(db.prepare("SELECT record FROM model_catalog_receipts WHERE command_id='on-again'").get()!['record']));
          record.changes.push({ ...record.changes[0], modelId: null });
          db.prepare("UPDATE model_catalog_receipts SET record=? WHERE command_id='on-again'").run(JSON.stringify(record));
        } finally { db.close(); }
        return write(admission);
      };
      return store;
    });
    try { await expect.soft(asPerson(() => applyModelCatalog(f.project, again, f.options))).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' }); }
    finally { raced.mockRestore(); }
    expect.soft(await inspectModelActivation(f.project, { schemaVersion: 1, scopeId: 's', reference: f.reference }, f.options))
      .toMatchObject({ activation: { state: 'inactive' } });
    // A replay the writer returns passes the replay permission for that target, on the policy read again when it arrives.
    const fPolicy = join(f.project, 'd', 'policy.json'), fRules = await readFile(fPolicy, 'utf8'), rules = JSON.parse(fRules);
    const later = { ...off, commandId: 'off-again', expectedRevision: 3 };
    const revoked = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openCatalog(...args), write = store.apply.bind(store);
      store.apply = async admission => {
        if (admission.command.commandId !== later.commandId) return write(admission);
        await write(admission);
        await writeFile(fPolicy, JSON.stringify({ ...rules, grants: [...rules.grants, { ...rules.grants[1], id: 'deny-replay', effect: 'deny', actions: ['deactivate', 'inspect'],
          resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: f.model.nativeId })] } }] }));
        return write(admission);
      };
      return store;
    });
    try { await expect.soft(applyModelCatalog(f.project, later, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); }
    finally { revoked.mockRestore(); await writeFile(fPolicy, fRules); }
    // That fresh decision also gates the child write still due: inspect removed after the replay was checked stops the chat child.
    const fourth = { ...command, commandId: 'on-fourth', expectedRevision: 4 }, openReader = witnessAdapters.openSqliteModelCatalogReader;
    let armed = false;
    const replayed = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openCatalog(...args), write = store.apply.bind(store);
      store.apply = async admission => {
        if (admission.command.commandId !== fourth.commandId) return write(admission);
        await write(admission); armed = true;
        return write(admission);
      };
      return store;
    });
    const reading = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogReader').mockImplementation(async (...args) => {
      const reader = await openReader(...args), close = reader.close.bind(reader);
      if (!armed) return reader;
      armed = false;
      reader.close = () => {
        close();
        writeFileSync(fPolicy, JSON.stringify({ ...rules, grants: [...rules.grants, { ...rules.grants[1], id: 'deny-late-replay', effect: 'deny', actions: ['inspect'],
          resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: f.model.nativeId })] } }] }));
      };
      return reader;
    });
    try { await expect.soft(asPerson(() => applyModelCatalog(f.project, fourth, f.options))).rejects.toMatchObject({ code: 'POLICY_DENIED' }); }
    finally { replayed.mockRestore(); reading.mockRestore(); await writeFile(fPolicy, fRules); }
    // A replay with nothing left to write is checked at its return: the writer's receipt and the durable one must be the same record.
    const fifth = { ...off, commandId: 'off-fifth', expectedRevision: 5 };
    const diverged = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openCatalog(...args), write = store.apply.bind(store);
      store.apply = async admission => {
        if (admission.command.commandId !== fifth.commandId) return write(admission);
        await write(admission);
        const second = await write(admission), db = new DatabaseSync(f.path);
        try {
          const record = JSON.parse(String(db.prepare("SELECT record FROM model_catalog_receipts WHERE command_id='off-fifth'").get()!['record']));
          db.prepare("UPDATE model_catalog_receipts SET record=? WHERE command_id='off-fifth'").run(JSON.stringify({ ...record, admittedAtMs: record.admittedAtMs + 1 }));
        } finally { db.close(); }
        return second;
      };
      return store;
    });
    try { await expect.soft(applyModelCatalog(f.project, fifth, f.options)).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' }); }
    finally { diverged.mockRestore(); }
    expect.soft(await inspectModelActivation(f.project, { schemaVersion: 1, scopeId: 's', reference: f.reference }, f.options))
      .toMatchObject({ activation: { state: 'inactive' } });

    const partial = await declaredFixture();
    await asPerson(() => applyModelCatalog(partial.project, command, partial.options));
    const policyPath = join(partial.project, 'd', 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: [...policy.grants,
      { ...policy.grants[1], id: 'deny-child-off', effect: 'deny', actions: ['deactivate'],
        resource: { kind: 'model-activation', ids: [modelActivationTargetId(partial.reference)] } }] }));
    await expect(applyModelCatalog(partial.project, off, partial.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const [,, activations, receipts] = partial.tables();
    expect.soft(activations).toEqual(expect.arrayContaining([expect.objectContaining({ model_id: f.model.nativeId, state: 'inactive', revision: 2 })]));
    expect.soft(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ command_id: 'off' })]));
    const listed = await inspectModelCatalog(partial.project, { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL }, partial.options);
    expect(listed.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: f.model.nativeId, chatState: 'active' })]) });
    const preserved = partial.tables();
    await expect.soft(applyModelCatalog(partial.project, off, partial.options)).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT' });
    expect(partial.tables()).toEqual(preserved);

    const direct = await declaredFixture();
    await asPerson(() => applyModelCatalog(direct.project, command, direct.options));
    const directPolicy = join(direct.project, 'd', 'policy.json');
    await writeFile(directPolicy, JSON.stringify({ ...policy, grants: [...policy.grants,
      { ...policy.grants[1], id: 'deny-worker-off', effect: 'deny', actions: ['deactivate'],
        resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: f.model.nativeId })] } }] }));
    const binding = await inspectModelBinding(direct.project, direct.reference, direct.options);
    if (binding.status !== 'declared') throw new Error('fixture binding absent');
    const query = { schemaVersion: 1 as const, scopeId: 's', reference: direct.reference };
    const beforeWorker = direct.tables();
    await expect(admitModelActivation(direct.project, { ...query, action: 'deactivate', commandId: 'direct-off',
      expectedBinding: binding.binding, expectedRevision: 1 }, direct.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await inspectModelActivation(direct.project, query, direct.options)).toMatchObject({ activation: { state: 'inactive', revision: 2 } });
    expect(direct.tables()).toEqual(beforeWorker);
  });

  it('allows an unselected model revision to change before a named activation', async () => {
    const f = await declaredFixture();
    const edit = await seedCatalog();
    edit.revision = 'concurrent-catalog';
    edit.providers[0].models[0].lifecycle.state = 'deprecated';
    edit.providers[0].models[0].lifecycle.deprecatedOn = '2026-09-30';
    const command = { schemaVersion: 1, commandId: 'named', scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId: f.model.nativeId, expectedRevision: 0 };
    const apply = () => applyModelCatalog(f.project, command, f.options);
    const result = await asPerson(apply, async () => {
      await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'edit-sibling', scopeId: 's', action: 'register', catalog: edit }, f.options);
      return true;
    }).catch(error => error);
    expect.soft(result).toMatchObject({ replayed: false, receipt: { changes: [{ modelId: f.model.nativeId, revision: 1 }] } });

    const direct = await declaredFixture();
    await asPerson(() => applyModelCatalog(direct.project, command, direct.options));
    const policyPath = join(direct.project, 'd', 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: [...policy.grants,
      { ...policy.grants[1], id: 'deny-unchanged-worker', effect: 'deny', actions: ['activate'],
        resource: { kind: 'model-activation', ids: [null, f.model.nativeId].map(modelId => modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId })) } }] }));
    const binding = await inspectModelBinding(direct.project, direct.reference, direct.options);
    if (binding.status !== 'declared') throw new Error('fixture binding absent');
    const admit = () => admitModelActivation(direct.project, { schemaVersion: 1, scopeId: 's', commandId: 'direct-again',
      action: 'activate', reference: direct.reference, expectedRevision: 1, expectedBinding: binding.binding, catalogRevision: binding.catalogRevision }, direct.options);
    await expect(asPerson(admit)).resolves.toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 2 } } });
    // A re-run of the direct command returns its receipt only to a caller who may still read the activation.
    const unreadable = JSON.parse(await readFile(policyPath, 'utf8'));
    await writeFile(policyPath, JSON.stringify({ ...unreadable, grants: [...unreadable.grants, { ...policy.grants[1], id: 'deny-direct-inspect', effect: 'deny',
      actions: ['inspect'], resource: { kind: 'model-activation', ids: [modelActivationTargetId(direct.reference)] } }] }));
    // Without inspect a caller learns nothing from the receipt: without the witness it gets the witness refusal, as for a command with none.
    const fresh = (commandId: string, expectedRevision: number) => () => admitModelActivation(direct.project, { schemaVersion: 1, scopeId: 's', commandId,
      action: 'activate', reference: direct.reference, expectedRevision, expectedBinding: binding.binding, catalogRevision: binding.catalogRevision }, direct.options);
    await expect.soft(admit()).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect.soft(fresh('direct-fresh', 2)()).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect.soft(asPerson(admit)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // A replay the writer returns (a concurrent twin of the same command) needs inspect too.
    const openActivation = witnessAdapters.openSqliteModelActivationStore;
    const twin = vi.spyOn(witnessAdapters, 'openSqliteModelActivationStore').mockImplementation(async (...args) => {
      const store = await openActivation(...args), write = store.admit.bind(store);
      store.admit = async admission => { await write(admission); return write(admission); };
      return store;
    });
    try { await expect.soft(asPerson(fresh('direct-race', 2))).rejects.toMatchObject({ code: 'POLICY_DENIED' }); } finally { twin.mockRestore(); }
    // The replay decision uses the policy read again when the replay arrives: inspect removed during the call is honoured.
    await writeFile(policyPath, JSON.stringify(policy));
    const lateDeny = JSON.stringify({ ...policy, grants: [...policy.grants, { ...policy.grants[1], id: 'deny-late-inspect', effect: 'deny',
      actions: ['inspect'], resource: { kind: 'model-activation', ids: [modelActivationTargetId(direct.reference)] } }] });
    const late = vi.spyOn(witnessAdapters, 'openSqliteModelActivationStore').mockImplementation(async (...args) => {
      const store = await openActivation(...args), write = store.admit.bind(store);
      store.admit = async admission => { await write(admission); await writeFile(policyPath, lateDeny); return write(admission); };
      return store;
    });
    try { await expect.soft(asPerson(fresh('direct-late', 3))).rejects.toMatchObject({ code: 'POLICY_DENIED' }); } finally { late.mockRestore(); }
    // A child receipt whose row no longer holds its change refuses before any write, after the witness.
    await writeFile(policyPath, JSON.stringify(policy));
    const child = fresh('direct-child', 4);
    const remove = (where: string) => { const db = new DatabaseSync(direct.path); try { db.prepare(`DELETE FROM model_catalog_activations${where}`).run(); } finally { db.close(); } };
    remove(` WHERE model_id='${f.model.nativeId}'`);
    await expect(child()).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(asPerson(child)).resolves.toMatchObject({ replayed: false, receipt: { record: { revision: 5 } } });
    remove('');
    const tampered = direct.tables();
    await expect.soft(child()).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect.soft(asPerson(child)).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT' });
    expect.soft(direct.tables()).toEqual(tampered);
    // A conflict on the first child does not cut off the planning of the next one: that child's policy refusal keeps its place.
    await expect(asPerson(fresh('direct-model', 5))).resolves.toMatchObject({ replayed: false, receipt: { record: { revision: 6 } } });
    remove(" WHERE model_id=''");
    await expect(asPerson(fresh('direct-first', 6))).resolves.toMatchObject({ replayed: false, receipt: { record: { revision: 7 } } });
    remove('');
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: [...policy.grants, { ...policy.grants[1], id: 'deny-second-child', effect: 'deny', actions: ['activate'],
      resource: { kind: 'model-activation', ids: [modelCatalogTargetId({ channelId: SEED_CHANNEL, modelId: f.model.nativeId })] } }] }));
    await expect.soft(fresh('direct-first', 6)()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect.soft(asPerson(fresh('direct-first', 6))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Two deliveries of the same command: the second finds the children the first completed between its listing and its receipt reads.
    // The wanted state exists, so it succeeds without writing a child again.
    await writeFile(policyPath, JSON.stringify(policy));
    const openChildReader = witnessAdapters.openSqliteModelCatalogReader;
    let opened = 0, running = false, afterFirst: unknown;
    const concurrent = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogReader').mockImplementation(async (...args) => {
      if (!running && ++opened === 2) {
        running = true;
        try { await fresh('direct-concurrent', 7)(); } finally { running = false; }
        afterFirst = direct.tables();
      }
      return openChildReader(...args);
    });
    try { await expect.soft(asPerson(fresh('direct-concurrent', 7))).resolves.toMatchObject({ replayed: true, receipt: { record: { revision: 8 } } }); }
    finally { concurrent.mockRestore(); }
    expect.soft(direct.tables()).toEqual(afterFirst);
    // The other order: the second delivery looks the child receipt up before the first delivery writes the child, then reads the new revision.
    // The same command's verified receipt and the row agree, so it also succeeds without writing the child again.
    remove('');
    let delivered = false, lateFirst: unknown;
    const reordered = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogReader').mockImplementation(async (...args) => {
      const reader = await openChildReader(...args), lookup = reader.loadReceipt?.bind(reader);
      if (lookup && !running && !delivered) reader.loadReceipt = async (scope, id) => {
        const found = await lookup(scope, id);
        if (!found && id.startsWith('model-state-') && !delivered) {
          delivered = running = true;
          try { await fresh('direct-late-order', 8)(); } finally { running = false; }
          lateFirst = direct.tables();
        }
        return found;
      };
      return reader;
    });
    try { await expect.soft(asPerson(fresh('direct-late-order', 8))).resolves.toMatchObject({ replayed: true, receipt: { record: { revision: 9 } } }); }
    finally { reordered.mockRestore(); }
    expect.soft(direct.tables()).toEqual(lateFirst);
    // A child receipt used as evidence of completion is verified: with its changes emptied it is broken evidence, not a completed child.
    remove('');
    opened = 0;
    const children = [0, 1].map(index => `model-state-${createHash('sha256').update('direct-broken').digest('hex')}-${index}`);
    const broken = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogReader').mockImplementation(async (...args) => {
      if (!running && ++opened === 2) {
        running = true;
        try { await fresh('direct-broken', 9)(); } finally { running = false; }
        const db = new DatabaseSync(direct.path);
        try {
          for (const id of children) {
            const row = db.prepare('SELECT record FROM model_catalog_receipts WHERE command_id=?').get(id)!;
            db.prepare('UPDATE model_catalog_receipts SET record=? WHERE command_id=?').run(JSON.stringify({ ...JSON.parse(String(row['record'])), changes: [] }), id);
          }
        } finally { db.close(); }
      }
      return openChildReader(...args);
    });
    try { await expect.soft(asPerson(fresh('direct-broken', 9))).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' }); }
    finally { broken.mockRestore(); }
    // The third stage: the writer is the first to see the child receipt (another delivery of the same named-worker command completed the
    // children after this one planned them). Completed without writing is reported as not written; a target closed meanwhile is a conflict.
    remove('');
    const worker = (commandId: string) => () => activateConfiguredWorkerModel(direct.project, 's', direct.reference, commandId, direct.options);
    const openWorkerStore = witnessAdapters.openSqliteModelCatalogStore;
    let fired = false, firstWrote: Awaited<ReturnType<typeof activateConfiguredWorkerModel>> | undefined;
    const behind = (commandId: string, after?: () => Promise<unknown>) => vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      if (!running && !fired) {
        fired = running = true;
        try { firstWrote = await worker(commandId)(); await after?.(); } finally { running = false; }
      }
      return openWorkerStore(...args);
    });
    let writer = behind('worker-behind');
    // The completed delivery wrote nothing; it names the channel revision the first delivery's channel child wrote (1: the row was removed),
    // read from that child's verified receipt of this command and actor. The first one opened the channel itself.
    try { await expect.soft(asPerson(worker('worker-behind'))).resolves.toEqual({ written: false, channel: 1 }); } finally { writer.mockRestore(); }
    expect.soft(firstWrote).toEqual({ written: true, channel: 1 });
    remove(''); fired = false;
    writer = behind('worker-closed', () => applyModelCatalog(direct.project, { schemaVersion: 1, commandId: 'close-meanwhile', scopeId: 's', action: 'deactivate',
      channelId: SEED_CHANNEL, modelId: f.model.nativeId, expectedRevision: 1 }, direct.options));
    try { await expect.soft(asPerson(worker('worker-closed'))).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT' }); } finally { writer.mockRestore(); }
    const closed = await inspectModelCatalog(direct.project, { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL }, direct.options);
    expect.soft(closed.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: f.model.nativeId, activation: { state: 'inactive', revision: 2 } })]) });
  });

  it('settles missing catalog children after interruption, then replays their receipts without another write', async () => {
    const f = await declaredFixture();
    const { declare } = f;
    const command = { schemaVersion: 1, commandId: 'interrupted', scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId: null, expectedRevision: 0 };
    const apply = () => applyModelCatalog(f.project, command, f.options);
    const openStore = witnessAdapters.openSqliteModelCatalogStore;
    let writes = 0;
    const interrupted = vi.spyOn(witnessAdapters, 'openSqliteModelCatalogStore').mockImplementation(async (...args) => {
      const store = await openStore(...args);
      if (++writes === 3) vi.spyOn(store, 'apply').mockRejectedValueOnce(new Error('fixture interruption'));
      return store;
    });
    try { await expect(asPerson(apply)).rejects.toThrow(); } finally { interrupted.mockRestore(); }
    const partial = f.tables();
    expect(partial[2]).toHaveLength(2);
    const withoutTerminal = vi.spyOn(witnessAdapters, 'attestLocalInteractiveTerminal').mockResolvedValue(false);
    try { await expect(apply()).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); } finally { withoutTerminal.mockRestore(); }
    expect(f.tables()).toEqual(partial);
    await declare('changed-after-interruption');
    await expect(asPerson(apply)).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT' });
    expect(f.tables()).toEqual(partial);
    await declare('original');
    // A resumed command verifies its whole parent receipt (an extra change) before it writes the missing child.
    const parent = (record?: string) => {
      const ledger = new DatabaseSync(f.path);
      try {
        const kept = String(ledger.prepare("SELECT record FROM model_catalog_receipts WHERE command_id='interrupted'").get()!['record']);
        const changed = JSON.parse(kept);
        changed.changes[0].revision += 5;
        ledger.prepare("UPDATE model_catalog_receipts SET record=? WHERE command_id='interrupted'").run(record ?? JSON.stringify(changed));
        return kept;
      } finally { ledger.close(); }
    };
    const kept = JSON.parse(parent()), extra = { ...kept, changes: [...kept.changes, { ...kept.changes[0], modelId: 'claude-sonnet-5-5' }] };
    parent(JSON.stringify(extra));
    const corrupt = f.tables();
    await expect.soft(asPerson(apply)).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' });
    expect.soft(f.tables()).toEqual(corrupt);
    parent(JSON.stringify(kept));
    const completed = await asPerson(apply);
    expect(completed.replayed).toBe(true);
    const settled = f.tables();
    expect(settled[2]).toEqual(expect.arrayContaining([expect.objectContaining({ model_id: 'claude-sonnet-5-5', state: 'active', revision: 1 })]));
    const inspected = await inspectModelCatalog(f.project, { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL }, f.options);
    expect(inspected.channels[0]).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ modelId: 'claude-sonnet-5-5', chatState: 'active' })]) });
    expect(await apply()).toEqual(completed);
    expect(f.tables()).toEqual(settled);
    const policyPath = join(f.project, 'd', 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: policy.grants.map((grant: { actions: string[] }) =>
      ({ ...grant, actions: grant.actions.filter(action => action === 'inspect') })) }));
    await expect(apply()).resolves.toEqual(completed);
    expect(f.tables()).toEqual(settled);
    const readable = await readFile(policyPath, 'utf8'), readers = JSON.parse(readable);
    await writeFile(policyPath, JSON.stringify({ ...readers, grants: [...readers.grants,
      { ...readers.grants[1], id: 'deny-child-inspect', effect: 'deny',
        resource: { kind: 'model-activation', ids: [modelActivationTargetId(f.reference)] } }] }));
    await expect(apply()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.tables()).toEqual(settled);
    await writeFile(policyPath, readable);
    // The sealed parent receipt is verified before the re-run reports the command complete.
    const original = parent();
    await expect.soft(apply()).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' });
    // Its stored authority entries name the command's own target too.
    const entries = JSON.parse(original);
    entries.authorizations[0].target.modelId = 'claude-sonnet-5-5';
    parent(JSON.stringify(entries));
    await expect.soft(apply()).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' });
    parent(original);
    const db = new DatabaseSync(f.path);
    try { db.prepare("UPDATE model_activation_receipts SET record = '{}'").run(); } finally { db.close(); }
    await expect(apply()).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_CORRUPT' });
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
      // The same refusal over MCP names the successor the catalog records (the retired model's replacement).
      const successor = await seedCatalog(); successor.revision = 'with-successor';
      successor.providers[0].models.find((model: { nativeId: string }) => model.nativeId === 'claude-haiku-4-5-20251001').lifecycle.replacementModelId = 'claude-haiku-5-5';
      expect((await session.client.callTool({ name: 'apply_model_catalog', arguments: { schemaVersion: 1, commandId: 'mcp-successor', scopeId: 's', action: 'register', catalog: successor } })).isError).not.toBe(true);
      const retired = await session.client.callTool({ name: 'apply_model_catalog', arguments: { schemaVersion: 1, commandId: 'mcp-retired', scopeId: 's', action: 'activate',
        channelId: SEED_CHANNEL, modelId: 'claude-haiku-4-5-20251001', expectedRevision: 0 } });
      expect(retired.isError).toBe(true); expect(JSON.stringify(retired.content)).toContain('MODEL_CATALOG_MODEL_RETIRED');
      expect(JSON.stringify(retired.content)).toContain('The current model of its family is claude-haiku-5-5.');
    } finally { await session.close(); }
  });
});

async function declaredFixture() {
  const f = await fixture();
  const seed = await seedCatalog(), provider = seed.providers[0]!;
  const model = provider.models.find((item: { nativeId: string }) => item.nativeId === 'claude-sonnet-5-5')!;
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'seed', scopeId: 's', action: 'register', catalog: seed }, f.options);
  const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  const declaration = { schemaVersion: 1, revision: 'original', providers: [{ id: provider.id, version: provider.version,
    models: [{ id: model.id, version: model.version, nativeId: model.nativeId, protocols: model.protocols }] }] };
  const declare = (revision: string) => writeFile(configPath, JSON.stringify({ ...config, provider_catalog: { ...declaration, revision } }), { mode: 0o600 });
  await declare('original');
  return { ...f, declare, model, reference: { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version } };
}

async function asPerson<T>(operation: () => Promise<T>, attest = async () => true): Promise<T> {
  const witness = vi.spyOn(witnessAdapters, 'attestLocalInteractiveTerminal').mockImplementationOnce(attest).mockResolvedValue(true);
  const markers = Object.keys(personMarkersUnset()).filter(key => process.env[key] !== undefined);
  const values = markers.map(key => process.env[key]!);
  for (const key of markers) delete process.env[key];
  try { return await operation(); }
  finally {
    witness.mockRestore();
    for (const [index, key] of markers.entries()) process.env[key] = values[index]!;
  }
}
