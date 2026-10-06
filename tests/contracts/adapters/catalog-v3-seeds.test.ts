import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore, readMonitorLedger } from '#adapters/index.js';
import { parseModelCatalogCommand, parseProviderCatalogDocument } from '#domain/index.js';
import { admitWorkerModels, type ModelCatalogAdmission } from '#engine/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const seed = async (name: string) => JSON.parse(await readFile(new URL(`../../../assets/model-catalog/${name}.json`, import.meta.url), 'utf8'));
const actor = { id: 'local-os:1000', issuer: 'local-os', subject: '1000', assurance: 'os-user' as const };
function admission(input: unknown): ModelCatalogAdmission {
  const command = parseModelCatalogCommand(input);
  const targets = command.action === 'register' ? command.catalog.providers.map(p => ({ channelId: p.id, modelId: null })) : [{ channelId: command.channelId, modelId: command.modelId }];
  return { command, actor, admittedAtMs: 1, authorizations: targets.map(target => ({ target, action: 'activate', level: command.action === 'register' ? 'installation' : 'scope', authorization: { revision: 'p', ruleId: 'g' } })) };
}
describe('catalog v3 packaged seeds through ledger and admission', () => {
  it('has exactly the visible Codex selection, source provenance, ultra, retirement and recommendations', async () => {
    const raw = await seed('codex-cli-subscription'); const doc = parseProviderCatalogDocument(raw);
    expect(doc.schemaVersion).toBe(3);
    expect(doc.providers[0]!.models.map(m => m.nativeId).sort()).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].sort());
    expect(raw.providers[0].channel).toMatchObject({ client: 'codex', billing: 'subscription', provenance: { fetchedOn: expect.any(String), etag: expect.any(String), clientVersion: expect.stringMatching(/^0\.\d+\.\d+$/) } });
    expect(raw.providers[0].models.find((m: { nativeId: string }) => m.nativeId === 'gpt-5.5').lifecycle).toMatchObject({ state: 'deprecated', retiredOn: '2026-10-14', replacementModelId: 'gpt-6.1-sol' });
    expect(raw.recommendedActivations[0].modelIds.sort()).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'].sort());
    for (const m of raw.providers[0].models) expect(m).toMatchObject({ canonicalModelId: m.nativeId, vendorId: 'openai', contextWindow: 272000, maxOutputTokens: null, minClientVersion: '0.159.2', pricing: { kind: 'subscription' } });
  });
  it('keeps Claude recommendations passive at register and includes owner retirement', async () => {
    const raw = await seed('claude-cli-subscription'); expect(raw.schemaVersion).toBe(3);
    expect(raw.recommendedActivations[0].modelIds.sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'].sort());
    expect(raw.providers[0].models.find((m: { nativeId: string }) => m.nativeId === 'claude-haiku-4-5-20251001').lifecycle.retiredOn).toBe('2026-10-15');
  });
  it('reads and replays a v2 receipt after registering v3 facts without a ledger migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-v2-replay-')); roots.push(root); const path = join(root, 'ledger.db');
    openSqliteLedger(path, options).close(); const store = await openSqliteModelCatalogStore(path, options, 'forbid');
    try {
      const catalog = JSON.parse(await readFile(new URL('../../fixtures/catalog/claude-v2.json', import.meta.url), 'utf8'));
      const old = admission({ schemaVersion: 1, scopeId: 's', commandId: 'old', action: 'register', catalog });
      const receipt = await store.apply(old);
      await store.apply(admission({ schemaVersion: 1, scopeId: 's', commandId: 'new', action: 'register', catalog: await seed('claude-cli-subscription') }));
      expect(await store.apply(old)).toEqual({ ...receipt, replayed: true });
    } finally { store.close(); }
  });
  it('persists metadata, refuses passive/alias/old-client and admits only the exact active scoped pin; monitor exposes provider and billing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-v3-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
    const store = await openSqliteModelCatalogStore(path, options, 'forbid'); let n = 0;
    const apply = (command: object) => store.apply(admission({ schemaVersion: 1, commandId: `c${++n}`, scopeId: 's', ...command }));
    const channelId = 'codex-cli-subscription', modelId = 'gpt-6.1-sol';
    try {
      await apply({ action: 'register', catalog: await seed(channelId) });
      const reader = await openSqliteModelCatalogReader(path, options);
      try {
        expect(await reader.activation('s', channelId, modelId)).toBeNull();
        expect((await reader.models(channelId)).find(m => m.modelId === modelId)!.model).toMatchObject({ vendorId: 'openai', canonicalModelId: modelId });
        const task = (id = modelId, cliVersion = 'codex-cli 0.159.2') => [{ taskId: 't', profile: { parameters: { nativeSubscription: { schemaVersion: 4, provider: 'codex', preflight: { cliVersion }, model: { channelId, modelId: id, auxiliaryModelIds: [] } } } } }];
        await apply({ action: 'activate', channelId, modelId: null, expectedRevision: 0 });
        await expect(admitWorkerModels(task(), 's', reader, Date.parse('2026-10-02'))).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
        await expect(admitWorkerModels(task('default'), 's', reader, Date.parse('2026-10-02'))).rejects.toMatchObject({ code: 'WORKER_MODEL_ALIAS_REFUSED' });
        await apply({ action: 'activate', channelId, modelId, expectedRevision: 0 });
        await expect(admitWorkerModels(task(modelId, 'codex-cli 0.159.1'), 's', reader, Date.parse('2026-10-02'))).rejects.toMatchObject({ code: 'WORKER_MODEL_CLI_TOO_OLD' });
        // Admitted with no caveat: admission now resolves to its typed warnings (WORKER-AUTO-REFRESH), none without a refresh in flight.
        await expect(admitWorkerModels(task(), 's', reader, Date.parse('2026-10-02'))).resolves.toEqual([]);
        await expect(admitWorkerModels(task(), 'other', reader, Date.parse('2026-10-02'))).rejects.toMatchObject({ code: 'WORKER_CHANNEL_NOT_ACTIVE' });
      } finally { reader.close(); }
      const map = (await readMonitorLedger(path, { busyTimeoutMs: 1000, maxRuns: 10 })).map;
      expect(map!.models.find(m => m.modelId === modelId)).toMatchObject({ vendorId: 'openai', billing: 'subscription', active: true });
      expect(map!.models.find(m => m.modelId === 'gpt-5.6-terra')!.active).toBe(false);
    } finally { store.close(); }
  });
});
