import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ order: [] as string[], events: [] as unknown[], binding: null as unknown,
  actor: { id: 'caller', issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified', scopeIds: ['scope'] }, body: '' }));
vi.mock('../../../src/composition/core/model-invocation/internal/inspect.js', async original => ({
  ...await original<object>(), inspectionApplication: () => ({ inspect: async () => ({ responseContent: { kind: 'response-body', data: state.body } }) }),
}));
vi.mock('#engine/index.js', async original => ({ ...await original<object>(),
  ModelBindingApplication: class { async inspect() { return state.binding; } },
}));
vi.mock('#composition/core/siwc/index.js', () => ({
  withConfiguredSiwc: async (_root: string, _scope: string, _options: unknown, _operation: string,
    work: (app: unknown, caller: unknown) => Promise<unknown>) => work({ inspectForLease: async () => { state.order.push('custody'); } }, { principal: state.actor }),
}));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(),
  openLocalIntegrityAuthority: async () => {
    const { createHmacIntegrity } = await import('#platform/index.js'); return createHmacIntegrity('a'.repeat(64), Buffer.alloc(32, 1));
  },
  openSqliteAuditStore: async () => ({ append(_event: unknown, seal: (sequence: number) => { event: unknown }) {
    state.order.push('audit'); const record = seal(1); state.events.push(record.event); return record;
  }, close() {} }),
}));
import { configuredContinuationPin, prepareConfiguredSiwcContinuation } from '#composition/core/model-invocation/index.js';
import { SIWC_INFERENCE } from '#adapters/core/provider-siwc/index.js';
import { modelInvocationProfileSchema, auditEventSchema } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, type ModelInvocationResult } from '#engine/index.js';
import { responsesFixture } from '../support/openai-responses.js';

it('previews the exact paid target before a real typed audit and visible notice; refusal or withdrawn consent never switches', async () => {
  const f = responsesFixture(SIWC_INFERENCE.endpoint), owner = { issuer: 'host', subject: '1000' };
  const reference = { providerId: 'api-provider', providerVersion: 1, modelId: 'chosen-api', modelVersion: 1 };
  const target = modelInvocationProfileSchema.parse({ ...f.profile, id: 'paid-api', schemaVersion: 2, billingAxis: 'metered', reference });
  const source = modelInvocationProfileSchema.parse({ ...f.profile, schemaVersion: 2, billingAxis: 'subscription', adapter: { ...SIWC_INFERENCE.adapter,
    definition: { schemaVersion: 2, connectionId: '00000000-0000-4000-8000-000000000001', owner, rawUse: 'person',
      delegatedUse: { consentedBy: owner, atMs: 1, classes: ['ai'] }, apiContinuation: { reference, profileDigest: modelInvocationProfileDigest(target) } } } });
  let current = source;
  state.binding = { status: 'declared', catalogRevision: 'target-catalog', binding: f.command.expectedBinding,
    definition: { ...f.definition, model: { ...f.definition.model, nativeId: 'chosen-native-id' } } };
  state.body = Buffer.from(JSON.stringify({ schemaVersion: 1, refusal: 'quota', status: 429, resetsAtMs: null })).toString('base64');
  const evidence = createModelInvocationResponseEvidence(SIWC_INFERENCE.adapter, 'http-status', 429, Buffer.from('fixture'), true);
  const result = { receipt: { profile: source, claim: { invocationId: 'source-invocation' }, outcome: { state: 'rejected', evidence } } } as unknown as ModelInvocationResult;
  // The account/custody observation is synthetic; the audit schema, owner restrictions, seal and verification are real.
  const context = { principal: state.actor, config: { projectRoot: '/fixture', storage: { sqlite: {} }, approvals: { keyFile: 'fixture.key' } }, layout: {},
    policy: { load: async () => ({ schemaVersion: 1, revision: 'policy', grants: [], restrictions: [] }) }, path: async () => 'fixture-ledger',
    freshConfig: async () => ({ provider_invocation_profiles: { profiles: [current, target] }, provider_catalog: {} }) } as never;
  const command = f.command as never, preview = vi.fn(async () => { state.order.push('preview'); }), notice = vi.fn(() => { state.order.push('notice'); });
  state.order = []; state.events = [];
  const next = await prepareConfiguredSiwcContinuation(context, {}, command, result, preview, notice);
  expect(next).toMatchObject({ reference, nativeRequest: { model: 'chosen-native-id' }, catalogRevision: 'target-catalog' });
  expect(next!.commandId).not.toBe(f.command.commandId);
  const pinned = configuredContinuationPin(next!);
  expect(pinned).toBeTypeOf('function');
  await expect(pinned!(target)).resolves.toBeUndefined();
  await expect(pinned!(modelInvocationProfileSchema.parse({ ...target, id: 'changed-target' }))).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  expect(configuredContinuationPin({ ...next! })).toBeUndefined();
  expect(state.order).toEqual(['preview', 'custody', 'audit', 'notice']);
  const event = auditEventSchema.parse(state.events[0]);
  expect(event.principal).toEqual(owner); expect(event.subject).toMatchObject({ kind: 'subscription-api-continuation', actor: { issuer: 'host/mcp', subject: '1000' }, reference });
  state.order = []; state.events = [];
  await expect(prepareConfiguredSiwcContinuation(context, {}, command, result, async () => { throw new Error('budget-refused'); }, notice)).rejects.toThrow('budget-refused');
  expect(state.events).toHaveLength(0); expect(state.order).toHaveLength(0);
  current = modelInvocationProfileSchema.parse({ ...source, adapter: { ...source.adapter, definition: { ...source.adapter.definition, apiContinuation: null } } });
  await expect(pinned!(target)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  await expect(prepareConfiguredSiwcContinuation(context, {}, command, result, preview, notice)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  expect(state.events).toHaveLength(0);
});
