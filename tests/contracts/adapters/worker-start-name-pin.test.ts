import { describe, expect, it } from 'vitest';
import { assertNativeWorkerBinding, bindNativeWorkerEffort, compileNativeCodingDockerProfile, resolveDockerTaskProfile, sealWorkerEventLog } from '#adapters/index.js';
import { catalogPinModelEvidence, parseModelCatalogCommand, planModelCatalogRegistration, readWorkerModelPin, workerEventSchema, type CatalogModel } from '#domain/index.js';
import { admitWorkerModels, prepareWorkerEffortAdmission, type ModelCatalogReader } from '#engine/index.js';
import { renderWorkerModelLine } from '#surfaces/core/monitor/index.js';

/** Frozen-pin custody of the catalog start-name evidence (owner K1/K2 2026-10-22). Fixture catalog only; the packaged Cursor seed is lane C4. */
const template = () => ({ id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
  tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } });
const invocation = (provider: string, modelId: string, channelId = `${provider}-cli-subscription`) => ({ schemaVersion: 4, provider, cliVersion: '1.0.0',
  discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: { channelId, modelId, auxiliaryModelIds: [] }, prompt: 'Edit note.txt.' });
const provenance = { sourceUrl: 'https://example.com/models', fetchedOn: '2026-10-22' };
const observed = (name: string) => ({ name, cliVersion: '2026.10.19-6bbf2c4', source: 'cursor-agent stream-json system/init', observedAt: '2026-10-22' });
const model = (nativeId: string, extra: Record<string, unknown> = {}) => ({ id: nativeId, version: 1, nativeId, protocols: [{ family: 'cursor-stream-json', version: 'v1', capabilities: [] }],
  lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, efforts: [], aliases: [],
  channelModelId: nativeId, vendorId: 'fixture', canonicalModelId: nativeId, displayName: nativeId, modalities: { input: ['text'], output: ['text'] },
  contextWindow: null, maxOutputTokens: null, reasoning: { supportedEfforts: [], defaultEffort: null },
  capabilities: { tools: 'unknown', vision: 'unknown', pdf: 'unknown', structuredOutput: 'unknown', promptCaching: 'unknown', streaming: 'unknown' },
  pricing: { kind: 'subscription', source: provenance, asOf: '2026-10-22' }, minClientVersion: null, provenance, ...extra });
const plan = planModelCatalogRegistration(parseModelCatalogCommand({ schemaVersion: 1, scopeId: 's', commandId: 'c', action: 'register', catalog: { schemaVersion: 3,
  revision: 'fixture-cursor', providers: [{ id: 'cursor-cli-subscription', version: 1, channel: { kind: 'native-cli', cli: 'cursor', aliases: [], client: 'cursor',
    billing: 'subscription', protocolFamily: 'cursor-stream-json', aliasesRefused: [], provenance },
  models: [model('composer-2.5', { reportedNames: [observed('Composer 2.5')] }), model('auto', { reportedNames: [observed('Auto')], selection: 'provider' }), model('gpt-5.2')] }] } }),
{ channel: () => null, models: () => [] });
const catalogModels = plan.models.map(row => row.model) as readonly CatalogModel[];
const reader: ModelCatalogReader = { async channels() { return plan.channels; }, async channel(id) { return plan.channels.find(row => row.channelId === id) ?? null; },
  async models(id) { return plan.models.filter(row => row.channelId === id); }, close() { /* in memory */ },
  async activation(scopeId, channelId, modelId) { return { schemaVersion: 1, scopeId, channelId, modelId, revision: 1, state: 'active' }; } };
const pinOf = (profile: ReturnType<typeof compileNativeCodingDockerProfile>) => (profile.parameters.nativeSubscription as { model: Record<string, unknown> }).model;
const effort = { schemaVersion: 1 as const, level: null, source: 'cli-default' as const, status: 'cli-default' as const };

describe('frozen pin carries catalog start-name evidence only when the catalog records it', () => {
  it('keeps Claude/Codex profile bytes identical without evidence (absent or empty)', () => {
    for (const provider of ['claude', 'codex']) {
      const plain = JSON.stringify(compileNativeCodingDockerProfile(template(), invocation(provider, 'exact-model-1')));
      expect(JSON.stringify(compileNativeCodingDockerProfile(template(), invocation(provider, 'exact-model-1'), undefined, {}))).toBe(plain);
      expect(JSON.stringify(compileNativeCodingDockerProfile(template(), invocation(provider, 'exact-model-1'), undefined, catalogPinModelEvidence([], 'exact-model-1')))).toBe(plain);
    }
  });
  it('round-trips a Cursor pin with names and the provider-choice flag through the docker profile, binding check and pin reader', () => {
    const profile = compileNativeCodingDockerProfile(template(), invocation('cursor', 'auto'), undefined, catalogPinModelEvidence(catalogModels, 'auto'));
    expect(pinOf(profile)).toEqual({ channelId: 'cursor-cli-subscription', modelId: 'auto', auxiliaryModelIds: [], reportedNames: ['Auto'],
      otherReportedNames: ['Composer 2.5'], providerChosen: true });
    expect(() => assertNativeWorkerBinding(profile)).not.toThrow();
    expect(resolveDockerTaskProfile(profile).nativeSubscription).toMatchObject({ modelUsageEvidence: 'session-start-name', model: { providerChosen: true } });
    expect(readWorkerModelPin(profile.parameters)).toMatchObject({ evidenceCapability: 'session-start-name', pin: { reportedNames: ['Auto'], providerChosen: true } });
  });
  it('bind replaces stale or forged pin evidence with the catalog data and leaves evidence-free pins byte-identical', () => {
    const forged = compileNativeCodingDockerProfile(template(), invocation('cursor', 'gpt-5.2'), undefined, { reportedNames: ['Composer 2.5'] });
    expect(pinOf(bindNativeWorkerEffort(forged, effort, catalogPinModelEvidence(catalogModels, 'gpt-5.2'))))
      .toEqual({ channelId: 'cursor-cli-subscription', modelId: 'gpt-5.2', auxiliaryModelIds: [], otherReportedNames: ['Auto', 'Composer 2.5'] });
    const claude = compileNativeCodingDockerProfile(template(), invocation('claude', 'exact-model-1'));
    expect(JSON.stringify(pinOf(bindNativeWorkerEffort(claude, effort, {})))).toBe(JSON.stringify(pinOf(claude)));
  });
});

describe('admission stamps and checks the pin evidence against the ledger catalog', () => {
  const task = (profile: ReturnType<typeof compileNativeCodingDockerProfile>) => [{ taskId: 't', profile }];
  it('compiles the catalog evidence into the frozen profile during new-Run preparation', async () => {
    const compiled: unknown[] = [];
    const workInput = { schemaVersion: 1, task: 'Edit.', scope: { paths: ['note.txt'] }, acceptance: 'Exact.',
      model: { channelId: 'cursor-cli-subscription', modelId: 'composer-2.5', auxiliaryModelIds: [] } };
    const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind: 'feature', dependencies: [], acceptanceCriteria: ['exit'], workInput }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    const registry = { schemaVersion: 1, revision: 'r', profiles: [template()], kinds: [{ kind: 'feature', profile: { id: 'coding', version: 1 } }],
      evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
    const prepared = await prepareWorkerEffortAdmission(graph, registry, reader, { capability: () => null, bind: value => value,
      compile: (_template, _input, _effort, evidence) => { compiled.push(evidence); return template() as never; } });
    prepared.compile!(template() as never, workInput as never, 'feature', 't');
    expect(compiled).toEqual([{ reportedNames: ['Composer 2.5'], otherReportedNames: ['Auto'] }]);
  });
  it('admits the stamped pin and refuses a pin whose names or provider-choice flag differ from the catalog', async () => {
    const stamped = (modelId: string, evidence: object) => task(compileNativeCodingDockerProfile(template(), invocation('cursor', modelId), undefined, evidence));
    await expect(admitWorkerModels(stamped('composer-2.5', catalogPinModelEvidence(catalogModels, 'composer-2.5')), 's', reader, Date.parse('2026-10-22'))).resolves.toEqual([]);
    await expect(admitWorkerModels(stamped('auto', catalogPinModelEvidence(catalogModels, 'auto')), 's', reader, Date.parse('2026-10-22'))).resolves.toEqual([]);
    for (const [modelId, evidence] of [['composer-2.5', {}], ['gpt-5.2', { reportedNames: ['Composer 2.5'] }],
      ['auto', { reportedNames: ['Auto'], otherReportedNames: ['Composer 2.5'] }]] as const) {
      await expect(admitWorkerModels(stamped(modelId, evidence), 's', reader, Date.parse('2026-10-22'))).rejects.toMatchObject({ code: 'WORKER_MODEL_BINDING_MISMATCH' });
    }
  });
});

describe('sealed log and human text of the new verdicts', () => {
  it('seals a start-name verdict as v3 and a start-name substitution as v2, both readable', () => {
    const lines = (status: 'start-name-matched' | 'substituted') => sealWorkerEventLog([], { status, admitted: 'composer-2.5', observed: ['Composer 2.5'],
      unexpected: status === 'substituted' ? ['Composer 2.5'] : [], evidenceCapability: 'session-start-name' }, 0, 1_000_000).map(line => workerEventSchema.parse(JSON.parse(line)));
    expect(lines('start-name-matched')).toEqual([expect.objectContaining({ schemaVersion: 3, status: 'start-name-matched' })]);
    expect(lines('substituted')).toEqual([expect.objectContaining({ schemaVersion: 2, status: 'substituted' })]);
  });
  it.each([['en', 'start name matched', 'model choice left to the provider (cursor)'], ['tr', 'başlangıç adı eşleşti', 'model seçimi sağlayıcıya bırakıldı (cursor)']] as const)(
    'renders the %s verdict text with the provider id from data', (locale, matched, chosen) => {
      const view = { provider: 'cursor', evidenceCapability: 'session-start-name' as const, requested: { channelId: 'cursor-cli-subscription', modelId: 'auto', auxiliaryModelIds: [] },
        init: 'Auto', usage: null, unexpected: [], evidence: 'sealed' as const };
      expect(renderWorkerModelLine({ ...view, verdict: 'start-name-matched' }, locale)).toContain(matched);
      expect(renderWorkerModelLine({ ...view, verdict: 'provider-chosen' }, locale)).toContain(chosen);
      expect(renderWorkerModelLine({ ...view, verdict: 'provider-chosen' }, locale)).toContain('Auto');
    });
});
