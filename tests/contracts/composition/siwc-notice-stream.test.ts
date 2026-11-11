import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: 0, continuations: 0, order: [] as string[], profiles: [] as string[], spending: 0, pins: 0, guarded: false, reference: {} as unknown }));
vi.mock('../../../src/composition/core/model-invocation/internal/context.js', () => ({
  loadPeerInvocationContext: async () => ({ config: { language: 'en' }, principal: {}, policy: {}, freshConfig: async () => ({}) }),
  loadInvocationContext: async () => ({ config: { language: 'en' }, principal: {}, policy: {}, freshConfig: async () => ({}) }),
}));
vi.mock('../../../src/composition/core/model-invocation/internal/native.js', () => ({ createConfiguredModelInvocationNative: () => ({ natives: {}, spending: { authorize: async () => ({}) } }) }));
vi.mock('../../../src/composition/core/model-invocation/internal/continuation.js', () => ({
  configuredContinuationPin: (command: { commandId: string }) => command.commandId === 'paid-call' ? async () => { state.pins++; } : undefined, siwcLimitContinuation: vi.fn(),
  prepareConfiguredSiwcContinuation: async (_context: unknown, _options: unknown, command: { commandId: string; reference: unknown }, _result: unknown,
    preview: (next: unknown) => Promise<unknown>, notice: (reference: unknown) => void) => {
    state.continuations++;
    const next = { ...command, commandId: 'paid-call' };
    await preview(next); notice(command.reference); return next;
  },
}));
vi.mock('#engine/index.js', async original => ({ ...await original<object>(), configuredInvocationProfiles: () => [{ scopeId: 's', reference: state.reference }], ModelInvocationApplication: class {
  constructor(...args: unknown[]) { this.profiles = args[4] as typeof this.profiles; this.spending = args[8] as typeof this.spending; }
  profiles!: { resolve(scopeId: string, reference: unknown): Promise<unknown> };
  spending!: { authorize(input: unknown): Promise<unknown> };
  async check() { if (state.guarded) { await this.profiles.resolve('s', state.reference); await this.spending.authorize({}); } }

  async preview() { await this.check(); state.order.push('preview'); }
  async invoke(_command: unknown, _credential: unknown, _signal: unknown, _delivery: unknown, onDelta?: (delta: { kind: string; text: string }) => void) {
    await this.check(); state.calls++;
    if (state.calls === 2) { state.order.push('model'); onDelta?.({ kind: 'text', text: 'model answer' }); }
    // beta.1.2: invoke reads the receipt's adapter id before the built-in plugin notice; a real receipt always carries its profile.
    return { receipt: { profile: { adapter: { id: 'fixture-adapter' } }, outcome: { state: state.calls === 1 ? 'rejected' : 'responded' } } };
  }
} }));
import { invokeConfiguredModelAs, invokePeerConfiguredFeatureModel, invokeConfiguredModelWithOptions as invoke } from '#composition/core/model-invocation/index.js';
import { ModelInvocationError, modelInvocationCommandSchema } from '#domain/index.js';
import { responsesFixture } from '../support/openai-responses.js';

it('delivers billing notices outside provider deltas and declines automatic continuation without that visible sink', async () => {
  // Host I/O is synthetic; this proves orchestration, not a provider response or real surface acceptance.
  const command = modelInvocationCommandSchema.parse(responsesFixture('https://example.invalid').command);
  const deltas: string[] = [], notices: string[] = [];
  state.calls = 0; state.continuations = 0; state.order = [];
  const result = await invokePeerConfiguredFeatureModel('/fixture', command, {} as never, {}, undefined, undefined,
    delta => { deltas.push(delta.text); }, undefined, text => { state.order.push('notice'); notices.push(text); });
  expect(result.receipt.outcome?.state).toBe('responded');
  expect(state.order).toEqual(['preview', 'notice', 'model']); expect(deltas).toEqual(['model answer']);
  expect(notices).toEqual([expect.stringContaining('ChatGPT')]);
  state.calls = 0; state.continuations = 0;
  expect((await invokePeerConfiguredFeatureModel('/fixture', command, {} as never, {}, undefined, undefined, () => undefined)).receipt.outcome?.state).toBe('rejected');
  expect(state.calls).toBe(1); expect(state.continuations).toBe(0);
  state.calls = 0; state.continuations = 0;
  await invokeConfiguredModelAs('/fixture', command, {} as never, {}, undefined, { profile: async () => undefined, spending: () => undefined });
  expect(state.calls).toBe(1); expect(state.continuations).toBe(0); // A37: the guarded production caller has no visible continuation sink.
  state.calls = 0; state.continuations = 0; state.guarded = true; state.reference = command.reference;
  const guard = { profile: async () => { state.profiles.push(state.calls === 1 ? 'continuation' : 'initial'); }, spending: () => { state.spending++; } };
  await invoke({ input: command, options: {}, entry: 'feature', guard, onDelta: () => undefined, onNotice: () => undefined,
    loadContext: async () => ({ config: { language: 'en' }, principal: {}, policy: {}, freshConfig: async () => ({}) }) as never });
  expect(state.calls).toBe(2); expect(state.profiles).toEqual(['initial', 'continuation', 'continuation']); expect(state.spending).toBe(3); expect(state.pins).toBe(1);
  state.calls = 0; let checks = 0;
  await expect(invoke({ input: command, options: {}, entry: 'feature', onDelta: () => undefined, onNotice: () => undefined,
    guard: { profile: async () => { if (++checks === 3) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT'); }, spending: () => undefined },
    loadContext: async () => ({ config: { language: 'en' }, principal: {}, policy: {}, freshConfig: async () => ({}) }) as never }))
    .rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  expect(state.calls).toBe(1);
  state.guarded = false;

});
