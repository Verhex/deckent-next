import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore } from '#adapters/index.js';
import { parseModelCatalogCommand, parseProviderCatalogDocument } from '#domain/index.js';
import { admitWorkerModels, type ModelCatalogAdmission } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const raw = async () => JSON.parse(await readFile(new URL('../../../assets/model-catalog/cursor-cli-subscription.json', import.meta.url), 'utf8'));
const actor = { id: 'local-os:1000', issuer: 'local-os', subject: '1000', assurance: 'os-user' as const };
function admission(input: unknown): ModelCatalogAdmission {
  const command = parseModelCatalogCommand(input);
  const targets = command.action === 'register' ? command.catalog.providers.map(p => ({ channelId: p.id, modelId: null })) : [{ channelId: command.channelId, modelId: command.modelId }];
  return { command, actor, admittedAtMs: 1, authorizations: targets.map(target => ({ target, action: 'activate', level: command.action === 'register' ? 'installation' : 'scope', authorization: { revision: 'p', ruleId: 'g' } })) };
}
const NOW = Date.parse('2026-10-22');
const channelId = 'cursor-cli-subscription';

const NAMES: Readonly<Record<string, string>> = { auto: 'Auto', 'composer-2.5': 'Composer 2.5', 'claude-opus-5-thinking-high': 'Claude Opus 5 300K High',
  'claude-sonnet-5-thinking-high': 'Claude Sonnet 5 300K High', 'claude-sonnet-5-thinking-xhigh': 'Claude Sonnet 5 300K Extra High',
  'gpt-5.6-sol-high': 'GPT-5.6 Sol 272K High', 'gpt-5.6-sol-xhigh': 'GPT-5.6 Sol 272K Extra High' };
describe('packaged Cursor catalog seed (CURSOR-ISCI C4)', () => {
  it('validates with the owner K2 narrow set, model-id effort bindings and measured session-start names only', async () => {
    const doc = parseProviderCatalogDocument(await raw());
    expect(doc.schemaVersion).toBe(3);
    const models = doc.providers[0]!.models;
    expect(models.map(m => m.nativeId).sort()).toEqual(['auto', 'claude-opus-5-thinking-high', 'claude-sonnet-5-thinking-high', 'claude-sonnet-5-thinking-xhigh',
      'composer-2.5', 'gpt-5.6-sol-high', 'gpt-5.6-sol-xhigh']);
    const by = Object.fromEntries(models.map(m => [m.nativeId, m as Record<string, unknown>]));
    expect(by['auto']).toMatchObject({ selection: 'provider', efforts: [], reportedNames: [{ name: 'Auto' }] });
    expect(by['composer-2.5']).toMatchObject({ efforts: [], reportedNames: [{ name: 'Composer 2.5', cliVersion: '2026.10.19-6bbf2c4', source: 'cursor-agent stream-json system/init' }] });
    expect(by['composer-2.5']!['effortBinding']).toBeUndefined();
    expect(by['gpt-5.6-sol-xhigh']).toMatchObject({ efforts: ['xhigh'], effortBinding: { mode: 'fixed-model', level: 'xhigh' } });
    expect(by['claude-sonnet-5-thinking-high']).toMatchObject({ efforts: ['high'], effortBinding: { mode: 'fixed-model', level: 'high' } });
    // Each name is the exact `system/init` model string measured on the logged-in host (proof CURSOR-2026-10-22/init-names), not the --list-models text.
    for (const [id, name] of Object.entries(NAMES)) expect(by[id]).toMatchObject({ reportedNames: [{ name, cliVersion: '2026.10.19-6bbf2c4', source: 'cursor-agent stream-json system/init' }] });
    expect(models.some(m => m.nativeId.endsWith('-fast'))).toBe(false);
  });
  it('registers like --seed does, activates and admits named models with names and auto as provider-chosen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-cursor-')); roots.push(root); const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
    const store = await openSqliteModelCatalogStore(path, options, 'forbid'); let n = 0;
    const apply = (command: object) => store.apply(admission({ schemaVersion: 1, commandId: `c${++n}`, scopeId: 's', ...command }));
    try {
      await apply({ action: 'register', catalog: await raw() });
      await apply({ action: 'activate', channelId, modelId: null, expectedRevision: 0 });
      for (const modelId of ['auto', 'composer-2.5', 'gpt-5.6-sol-high']) await apply({ action: 'activate', channelId, modelId, expectedRevision: 0 });
      const reader = await openSqliteModelCatalogReader(path, options);
      try {
        const task = (modelId: string, pin: object, effort?: object) => [{ taskId: 't', profile: { parameters: { nativeSubscription: { schemaVersion: 4, provider: 'cursor',
          preflight: { cliVersion: '2026.10.19-6bbf2c4' }, ...(effort ? { reasoningEffort: effort, effortMode: 'model-id' } : {}),
          model: { channelId, modelId, auxiliaryModelIds: [], ...pin } } } } }];
        const others = (own: string) => Object.values(NAMES).filter(name => name !== own).sort();
        await expect(admitWorkerModels(task('auto', { reportedNames: ['Auto'], otherReportedNames: others('Auto'), providerChosen: true }), 's', reader, NOW)).resolves.toEqual([]);
        await expect(admitWorkerModels(task('auto', { reportedNames: ['Auto'], otherReportedNames: others('Auto') }), 's', reader, NOW))
          .rejects.toMatchObject({ code: 'WORKER_MODEL_BINDING_MISMATCH' });
        await expect(admitWorkerModels(task('composer-2.5', { reportedNames: ['Composer 2.5'], otherReportedNames: others('Composer 2.5') }), 's', reader, NOW)).resolves.toEqual([]);
        await expect(admitWorkerModels(task('composer-2.5', { reportedNames: ['Auto'], otherReportedNames: others('Auto') }), 's', reader, NOW))
          .rejects.toMatchObject({ code: 'WORKER_MODEL_BINDING_MISMATCH' });
        const high = { schemaVersion: 1, level: 'high', source: 'explicit', status: 'selected' };
        await expect(admitWorkerModels(task('gpt-5.6-sol-high', { reportedNames: [NAMES['gpt-5.6-sol-high']], otherReportedNames: others(NAMES['gpt-5.6-sol-high']) }, high), 's', reader, NOW)).resolves.toEqual([]);
        await expect(admitWorkerModels(task('gpt-5.6-sol-high', { reportedNames: [NAMES['gpt-5.6-sol-high']], otherReportedNames: others(NAMES['gpt-5.6-sol-high']) }, { ...high, level: 'xhigh' }), 's', reader, NOW))
          .rejects.toMatchObject({ code: 'WORKER_EFFORT_UNSUPPORTED' });
        await expect(admitWorkerModels(task('gpt-5.6-sol-xhigh', {}), 's', reader, NOW)).rejects.toMatchObject({ code: 'WORKER_MODEL_NOT_ACTIVE' });
      } finally { reader.close(); }
    } finally { store.close(); }
  });
});
