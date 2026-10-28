import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const quota = vi.hoisted(() => ({ body: Buffer.from(JSON.stringify({ schemaVersion: 1, refusal: 'quota', status: 429, resetsAtMs: null })).toString('base64') }));
// Only the subscription receipt-body read and account lease are synthetic. Pin minting, config, policy, activation, counter and Brain are real.
vi.mock('../../../src/composition/core/model-invocation/internal/inspect.js', async original => ({ ...await original<object>(),
  inspectionApplication: () => ({ inspect: async () => ({ responseContent: { kind: 'response-body', data: quota.body } }) }) }));
vi.mock('#composition/core/siwc/index.js', () => ({ withConfiguredSiwc: async (_root: string, _scope: string, _options: unknown, _operation: string,
  use: (app: unknown) => Promise<unknown>) => use({ inspectForLease: async () => {} }) }));
import * as terminalChat from '#composition/core/terminal-chat/index.js';
import * as httpTransport from '#adapters/core/provider-http-json/index.js';
import { readLocalOsIdentity, openLocalIntegrityAuthority, startLocalRuntimeSocketServer, requestLocalRuntime, SIWC_INFERENCE } from '#adapters/index.js';
import { modelInvocationProfileSchema, type ModelInvocationCommand } from '#domain/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, createModelInvocationResponseEvidence, modelInvocationProfileDigest, type ModelInvocationResult } from '#engine/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { carryContinuationPin, measurePeerConfiguredModel, measureConfiguredModel, invokeConfiguredFeatureModel, prepareConfiguredSiwcContinuation, previewConfiguredModel } from '#composition/core/model-invocation/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { proposalFixture } from '../support/run-proposal.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(drift: 'consent' | 'target' | null) {
  const f = await brainProviderFixture({ standing: true, tokenCount: { count: 10 } }); cleanups.push(f.close);
  const config = f.config as Record<string, unknown> & { provider_invocation_profiles: { profiles: unknown[] } };
  const target = modelInvocationProfileSchema.parse({ ...config.provider_invocation_profiles.profiles[0] as object, schemaVersion: 2, billingAxis: 'metered' });
  const os = readLocalOsIdentity(), owner = { issuer: os.issuer, subject: os.subject };
  const source = modelInvocationProfileSchema.parse({ ...target, id: 'subscription-source', reference: { ...f.reference, modelId: 'subscription-source' }, billingAxis: 'subscription',
    adapter: { ...SIWC_INFERENCE.adapter, definition: { schemaVersion: 2, connectionId: '00000000-0000-4000-8000-000000000001', owner,
      rawUse: 'person', delegatedUse: { consentedBy: owner, atMs: 1, classes: ['ai'] }, apiContinuation: { reference: f.reference, profileDigest: modelInvocationProfileDigest(target) } } } });
  config.provider_invocation_profiles.profiles = [source, target];
  const save = async () => { await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify(config)); clearConfigCache(); }; await save();
  const prepare = terminalChat.prepareTerminalChatCommand;
  const initial = await prepare({ projectRoot: f.project, scopeId: 's', messages: [{ role: 'user', content: 'fixture' }], options: f.options }, false, f.reference);
  const original: ModelInvocationCommand = { ...initial.command, reference: source.reference };
  const evidence = createModelInvocationResponseEvidence(SIWC_INFERENCE.adapter, 'http-status', 429, Buffer.from('fixture'), true);
  const result = { receipt: { profile: source, claim: { invocationId: 'source' }, outcome: { state: 'rejected', evidence } } } as unknown as ModelInvocationResult;
  const scoped = await loadConfiguredScopeContext(f.project, 's', f.options, 'write');
  const context = { ...scoped, policy: createLayoutPolicySource(scoped.layout, process.getuid!(), scoped.config.inspection.policyMaxBytes), freshConfig: () => loadConfig(f.project, { ...f.options, heal: false }) };
  await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
  const pin = await prepareConfiguredSiwcContinuation(context, f.options, original, result,
    command => previewConfiguredModel(f.project, command, f.options), () => {});
  expect(pin).not.toBeNull();
  const send = vi.mocked(httpTransport.sendNativeJsonHttp), effect = send.getMockImplementation()!;
  send.mockImplementation(async (...args) => {
    const response = await effect(...args);
    if (f.posts === 1 && args[0].definition.endpoint.endsWith('/chat') && drift) {
      config.provider_invocation_profiles.profiles = drift === 'consent'
        ? [{ ...source, adapter: { ...source.adapter, definition: { ...source.adapter.definition as object, apiContinuation: null } } }, target]
        : [source, { ...target, adapter: { ...target.adapter, definition: { ...target.adapter.definition as object, endpoint: 'https://127.0.0.1:1234/changed' } } }];
      await save();
    }
    return response;
  });
  const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business');
  f.setOutput(() => f.posts === 1 ? 'bad-json' : JSON.stringify({ graph, budgetCeiling, requiredPermissions }));
  const correction = { ...pin!, commandId: pin!.commandId + '-correction', nativeRequest: { ...pin!.nativeRequest,
    messages: [{ role: 'user', content: 'fixture; previous reply: bad-json; return the corrected plan' }] } };
  return { f, pin: pin!, correction };
}
async function peerMeasure(f: Awaited<ReturnType<typeof brainProviderFixture>>, input: ModelInvocationCommand) {
  const parent = join(f.data, 'peer'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const options = { endpoint: join(parent, 'measure.sock'), maxConnections: 2, inputMaxBytes: 4096, responseMaxBytes: 4096,
    headerTimeoutMs: 2000, responseTimeoutMs: 2000, acceptRetryDelayMs: 25, acceptRetryLimit: 3 };
  const server = await startLocalRuntimeSocketServer(options, async (request, peer) => {
    expect(peer.pid).toBeGreaterThan(0); expect(peer.isConnectionActive?.()).toBe(true);
    try { return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: await measurePeerConfiguredModel(f.project, input, peer, f.options, undefined, 'feature') }; }
    catch (error) { return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: false, error: { code: (error as { code: string }).code, category: 'error' } }; }
  });
  try {
    const result = await requestLocalRuntime(options, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'measure', operation: 'inspectRun', input: {} });
    if (!result.ok) throw result.error; return result.result;
  } finally { await server.dispose(); }
}
for (const route of ['direct', 'runtime-peer'] as const) for (const drift of ['consent', 'target'] as const) {
  it.skipIf(process.platform !== 'linux')(`RC-S2 ${route}: correction measurement refuses ${drift} drift before any correction counter or send`, async () => {
    const { f, pin, correction } = await fixture(drift);
    const measure = (input: ModelInvocationCommand) => route === 'direct' ? measureConfiguredModel(f.project, input, f.options, undefined, 'feature') : peerMeasure(f, input);
    await measure(pin);
    await invokeConfiguredFeatureModel(f.project, pin, f.options); // the allowed API reply is malformed; consent/profile then drifts
    carryContinuationPin(pin, correction); // the actual host-only WeakMap transfer, as the planner's admitCorrection does
    await expect(measure(correction)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
    expect(f.posts).toBe(1); expect(f.counterBodies).toHaveLength(1);
  });
}
it.skipIf(process.platform === 'win32')('RC-S2: unchanged profile and consent permit correction measurement and inference', async () => {
  const { f, pin, correction } = await fixture(null);
  await measureConfiguredModel(f.project, pin, f.options, undefined, 'feature'); await invokeConfiguredFeatureModel(f.project, pin, f.options);
  carryContinuationPin(pin, correction);
  await expect(measureConfiguredModel(f.project, correction, f.options, undefined, 'feature')).resolves.toMatchObject({ promptTokens: 10 });
  await expect(invokeConfiguredFeatureModel(f.project, correction, f.options)).resolves.toMatchObject({ receipt: { outcome: { state: 'responded' } } });
  expect(f.posts).toBe(2); expect(f.counterBodies).toHaveLength(2);
});
