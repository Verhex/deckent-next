import { describe, expect, it } from 'vitest';
import { catalogPinModelEvidence, modelVerificationSchemaVersion, parseModelCatalogCommand, parseProviderCatalogDocument, planModelCatalogRegistration,
  readWorkerModelPin, summarizeWorkerEvents, taskEvaluationModelSchema, taskModelConclusion, verifyWorkerModels, viewWorkerModels, workerEventSchema,
  workerModelPinSchema, type CatalogModel } from '#domain/index.js';

/** Test fixture catalog (lane C2; the packaged Cursor seed is lane C4). Names are the `system/init.model` form measured 2026-10-22. */
const provenance = { sourceUrl: 'https://example.com/models', fetchedOn: '2026-10-22' };
const observed = (name: string) => ({ name, cliVersion: '2026.10.19-6bbf2c4', source: 'cursor-agent stream-json system/init', observedAt: '2026-10-22' });
const model = (nativeId: string, extra: Record<string, unknown> = {}) => ({ id: nativeId, version: 1, nativeId, protocols: [{ family: 'cursor-stream-json', version: 'v1', capabilities: [] }],
  lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, efforts: [], aliases: [],
  channelModelId: nativeId, vendorId: 'fixture', canonicalModelId: nativeId, displayName: nativeId, modalities: { input: ['text'], output: ['text'] },
  contextWindow: null, maxOutputTokens: null, reasoning: { supportedEfforts: [], defaultEffort: null },
  capabilities: { tools: 'unknown', vision: 'unknown', pdf: 'unknown', structuredOutput: 'unknown', promptCaching: 'unknown', streaming: 'unknown' },
  pricing: { kind: 'subscription', source: provenance, asOf: '2026-10-22' }, minClientVersion: null, provenance, ...extra });
const catalog = (models: object[], kind: 'native-cli' | 'http-api' = 'native-cli') => ({ schemaVersion: 3, revision: 'fixture-cursor', providers: [{ id: 'cursor-cli-subscription', version: 1,
  channel: { kind, cli: kind === 'native-cli' ? 'cursor' : null, aliases: [], client: kind === 'native-cli' ? 'cursor' : null, billing: 'subscription',
    protocolFamily: 'cursor-stream-json', aliasesRefused: [], provenance }, models }] });
const fixture = () => [model('composer-2.5', { reportedNames: [observed('Composer 2.5')] }), model('auto', { reportedNames: [observed('Auto')], selection: 'provider' }),
  model('claude-opus-5-thinking-high', { reportedNames: [observed('Claude Opus 5 1M Thinking')] }), model('gpt-5.2')];
const parsedModels = () => parseProviderCatalogDocument(catalog(fixture())).providers[0]!.models as readonly CatalogModel[];

describe('catalog session-start reported names (owner K1/K2 2026-10-22)', () => {
  it('accepts reported names and the provider-choice flag on a native CLI channel, keeping the exact-model entries unchanged', () => {
    const models = parsedModels();
    expect(models.find(entry => entry.nativeId === 'auto')).toMatchObject({ selection: 'provider', reportedNames: [{ name: 'Auto', cliVersion: '2026.10.19-6bbf2c4' }] });
    expect(models.find(entry => entry.nativeId === 'gpt-5.2')).not.toHaveProperty('reportedNames');
  });
  it('refuses one reported name claimed by two models, a repeated name, a padded name and names on a non-CLI channel', () => {
    const duplicate = [model('composer-2.5', { reportedNames: [observed('Composer 2.5')] }), model('composer-2', { reportedNames: [observed('Composer 2.5')] })];
    expect(() => parseProviderCatalogDocument(catalog(duplicate))).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(() => parseProviderCatalogDocument(catalog([model('composer-2.5', { reportedNames: [observed('Composer 2.5'), observed('Composer 2.5')] })])))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(() => parseProviderCatalogDocument(catalog([model('composer-2.5', { reportedNames: [observed(' Composer 2.5')] })]))).toThrow();
    expect(() => parseProviderCatalogDocument(catalog([model('composer-2.5', { reportedNames: [observed('x'.repeat(129))] })]))).toThrow();
    expect(() => parseProviderCatalogDocument(catalog([model('composer-2.5', { reportedNames: [observed('Composer 2.5')] })], 'http-api')))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(() => parseProviderCatalogDocument(catalog([model('auto', { selection: 'provider' })], 'http-api'))).toThrow();
    // The channel total is bounded so every frozen pin's other-name list fits its schema: 33 models x 16 names exceeds it.
    const crowded = Array.from({ length: 33 }, (_, m) => model(`m-${m}`, { reportedNames: Array.from({ length: 16 }, (_, n) => observed(`Model ${m}.${n}`)) }));
    expect(() => parseProviderCatalogDocument(catalog(crowded))).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(parseProviderCatalogDocument(catalog(crowded.slice(0, 32))).providers[0]!.models).toHaveLength(32);
  });
  it('refuses a partial register whose new name collides with a preserved model of the channel', () => {
    const first = planModelCatalogRegistration(parseModelCatalogCommand({ schemaVersion: 1, scopeId: 's', commandId: 'one', action: 'register', catalog: catalog(fixture()) }),
      { channel: () => null, models: () => [] });
    const second = parseModelCatalogCommand({ schemaVersion: 1, scopeId: 's', commandId: 'two', action: 'register',
      catalog: catalog([model('composer-3', { reportedNames: [observed('Composer 2.5')] })]) });
    expect(() => planModelCatalogRegistration(second, { channel: () => first.channels[0]!, models: () => first.models }))
      .toThrow(expect.objectContaining({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' }));
  });
  it('derives the frozen pin evidence: own names, other names, provider choice; nothing for a model without names', () => {
    const models = parsedModels();
    expect(catalogPinModelEvidence(models, 'composer-2.5')).toEqual({ reportedNames: ['Composer 2.5'], otherReportedNames: ['Auto', 'Claude Opus 5 1M Thinking'] });
    expect(catalogPinModelEvidence(models, 'auto')).toEqual({ reportedNames: ['Auto'], otherReportedNames: ['Claude Opus 5 1M Thinking', 'Composer 2.5'], providerChosen: true });
    expect(catalogPinModelEvidence(models, 'gpt-5.2')).toEqual({ otherReportedNames: ['Auto', 'Claude Opus 5 1M Thinking', 'Composer 2.5'] });
    expect(catalogPinModelEvidence([], 'claude-sonnet-5-5')).toEqual({});
  });
});

describe('session-start-name verdict (owner K1/K2 2026-10-22)', () => {
  const evidence = catalogPinModelEvidence(parsedModels(), 'composer-2.5');
  const admitted = { modelId: 'composer-2.5', auxiliaryModelIds: [], ...evidence };
  const verify = (startedModel: string | null, pin: typeof admitted | null = admitted) => verifyWorkerModels({ evidenceCapability: 'session-start-name', admitted: pin, startedModel, usedModels: null });
  it('seals start-name-matched for a name the catalog records for the admitted model, never verified', () => {
    expect(verify('Composer 2.5')).toEqual({ status: 'start-name-matched', admitted: 'composer-2.5', observed: ['Composer 2.5'], unexpected: [] });
  });
  it('seals substituted for a name the catalog records for another model of the channel, listing the name', () => {
    expect(verify('Claude Opus 5 1M Thinking')).toEqual({ status: 'substituted', admitted: 'composer-2.5', observed: ['Claude Opus 5 1M Thinking'], unexpected: ['Claude Opus 5 1M Thinking'] });
    expect(verify('Auto')).toMatchObject({ status: 'substituted', unexpected: ['Auto'] });
  });
  it('is unverified for an unrecorded name, no start name, a pin without names, or no admitted model', () => {
    expect(verify('Composer 2.5 (current)')).toEqual({ status: 'unverified', admitted: 'composer-2.5', observed: ['Composer 2.5 (current)'], unexpected: [] });
    expect(verify(null)).toEqual({ status: 'unverified', admitted: 'composer-2.5', observed: [], unexpected: [] });
    expect(verify('Composer 2.5', { modelId: 'composer-2.5', auxiliaryModelIds: [] } as typeof admitted)).toMatchObject({ status: 'unverified' });
    expect(verify('Composer 2.5', null)).toEqual({ status: 'unverified', admitted: null, observed: ['Composer 2.5'], unexpected: [] });
  });
  it('seals provider-chosen for a provider-choice pin, recording the reported name only as information', () => {
    const auto = { modelId: 'auto', auxiliaryModelIds: [], ...catalogPinModelEvidence(parsedModels(), 'auto') };
    expect(verify('Auto', auto)).toEqual({ status: 'provider-chosen', admitted: 'auto', observed: ['Auto'], unexpected: [] });
    expect(verify('Composer 2.5', auto)).toEqual({ status: 'provider-chosen', admitted: 'auto', observed: ['Composer 2.5'], unexpected: [] });
    expect(verify(null, auto)).toMatchObject({ status: 'provider-chosen', observed: [] });
  });
  it('leaves session-events and none verdicts untouched by pin names', () => {
    const named = { ...admitted, modelId: 'exact', reportedNames: ['exact'] };
    expect(verifyWorkerModels({ evidenceCapability: 'session-events', admitted: named, startedModel: 'exact', usedModels: ['exact'] }).status).toBe('verified');
    expect(verifyWorkerModels({ evidenceCapability: 'none', admitted: named, startedModel: 'exact', usedModels: null }).status).toBe('unverified');
  });
});

describe('recorded compatibility of the new verdicts', () => {
  const base = { sequence: 9, atMs: 1, kind: 'model.verification', admitted: 'composer-2.5', observed: ['Composer 2.5'], unexpected: [] };
  it('writes only the two new statuses as v3; every status a v2 reader knows stays v2 (or v1 without capability)', () => {
    expect(modelVerificationSchemaVersion({ status: 'start-name-matched', admitted: 'a', observed: [], unexpected: [], evidenceCapability: 'session-start-name' })).toBe(3);
    expect(modelVerificationSchemaVersion({ status: 'provider-chosen', admitted: 'a', observed: [], unexpected: [], evidenceCapability: 'session-start-name' })).toBe(3);
    expect(modelVerificationSchemaVersion({ status: 'substituted', admitted: 'a', observed: [], unexpected: ['b'], evidenceCapability: 'session-start-name' })).toBe(2);
    expect(modelVerificationSchemaVersion({ status: 'verified', admitted: 'a', observed: [], unexpected: [], evidenceCapability: 'session-events' })).toBe(2);
    expect(modelVerificationSchemaVersion({ status: 'unverified', admitted: 'a', observed: [], unexpected: [] })).toBe(1);
  });
  it('v3 accepts only the new statuses under session-start-name; v2/v1 refuse them', () => {
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 3, evidenceCapability: 'session-start-name', status: 'start-name-matched' }).success).toBe(true);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 3, evidenceCapability: 'session-start-name', status: 'verified' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 3, evidenceCapability: 'session-events', status: 'provider-chosen' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 2, evidenceCapability: 'session-start-name', status: 'provider-chosen' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 1, status: 'start-name-matched' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 2, evidenceCapability: 'session-start-name', status: 'substituted' }).success).toBe(true);
  });
  it('summarizes and views the sealed new verdict', () => {
    const sealed = workerEventSchema.parse({ ...base, schemaVersion: 3, evidenceCapability: 'session-start-name', status: 'provider-chosen' });
    const summary = summarizeWorkerEvents([sealed]);
    expect(summary.modelVerification).toEqual({ status: 'provider-chosen', unexpected: [] });
    const pin = workerModelPinSchema.parse({ channelId: 'cursor-cli-subscription', modelId: 'auto', auxiliaryModelIds: [], reportedNames: ['Auto'], providerChosen: true });
    expect(viewWorkerModels({ provider: 'cursor', pin, evidenceCapability: 'session-start-name', summary, evidence: 'sealed' })).toMatchObject({ verdict: 'provider-chosen' });
  });
  it('reads a frozen pin with and without evidence; an unknown pin field is still refused', () => {
    const plain = { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] };
    const read = (model: object, modelUsageEvidence = 'session-start-name') => readWorkerModelPin({ nativeSubscription: { schemaVersion: 2, provider: 'cursor', model, modelUsageEvidence } });
    expect(JSON.stringify(read(plain)!.pin)).toBe(JSON.stringify(plain));
    expect(read({ ...plain, reportedNames: ['Composer 2.5'], otherReportedNames: ['Auto'] })).toMatchObject({ evidenceCapability: 'session-start-name',
      pin: { reportedNames: ['Composer 2.5'], otherReportedNames: ['Auto'] } });
    expect(read({ ...plain, providerChosen: false })).toBe(null);
    expect(read({ ...plain, matchedName: 'x' })).toBe(null);
    // An unstamped legacy Cursor pin predates the capability and reads as `none`.
    expect(readWorkerModelPin({ nativeSubscription: { schemaVersion: 2, provider: 'cursor', model: plain } })).toMatchObject({ evidenceCapability: 'none' });
  });
});

describe('evaluation conclusion of session-start-name evidence', () => {
  const record = (verdict: string, evidenceCapability = 'session-start-name') => taskEvaluationModelSchema.parse({ provider: 'cursor',
    requested: { channelId: 'cursor-cli-subscription', modelId: 'composer-2.5', auxiliaryModelIds: [], reportedNames: ['Composer 2.5'] },
    init: 'Composer 2.5', usage: null, verdict, unexpected: verdict === 'substituted' ? ['Auto'] : [], evidence: 'sealed', evidenceCapability });
  it('accepts matched and provider-chosen by criteria, fails a mapped other model, holds an unrecorded or missing name', () => {
    expect(taskModelConclusion(record('start-name-matched'))).toBe(null);
    expect(taskModelConclusion(record('provider-chosen'))).toBe(null);
    expect(taskModelConclusion(record('substituted'))).toBe('fail');
    expect(taskModelConclusion(record('unverified'))).toBe('unknown');
  });
  it('keeps the shipped conclusions of the other capabilities', () => {
    expect(taskModelConclusion(record('unverified', 'none'))).toBe(null);
    expect(taskModelConclusion(record('unverified', 'session-events'))).toBe('unknown');
    expect(taskModelConclusion(record('verified', 'session-events'))).toBe(null);
  });
});
