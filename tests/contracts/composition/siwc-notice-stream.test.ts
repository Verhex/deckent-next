import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: 0, continuations: 0, order: [] as string[] }));
vi.mock('../../../src/composition/core/model-invocation/internal/context.js', () => ({
  loadPeerInvocationContext: async () => ({ config: { language: 'en' }, principal: {}, policy: {} }),
  loadInvocationContext: vi.fn(),
}));
vi.mock('../../../src/composition/core/model-invocation/internal/native.js', () => ({ createConfiguredModelInvocationNative: () => ({ natives: {} }) }));
vi.mock('../../../src/composition/core/model-invocation/internal/continuation.js', () => ({
  configuredContinuationPin: () => undefined, siwcLimitContinuation: vi.fn(),
  prepareConfiguredSiwcContinuation: async (_context: unknown, _options: unknown, command: { commandId: string; reference: unknown }, _result: unknown,
    preview: (next: unknown) => Promise<unknown>, notice: (reference: unknown) => void) => {
    state.continuations++;
    const next = { ...command, commandId: 'paid-call' };
    await preview(next); notice(command.reference); return next;
  },
}));
vi.mock('#engine/index.js', async original => ({ ...await original<object>(), ModelInvocationApplication: class {
  async preview() { state.order.push('preview'); }
  async invoke(_command: unknown, _credential: unknown, _signal: unknown, _delivery: unknown, onDelta?: (delta: { kind: string; text: string }) => void) {
    state.calls++;
    if (state.calls === 2) { state.order.push('model'); onDelta?.({ kind: 'text', text: 'model answer' }); }
    return { receipt: { outcome: { state: state.calls === 1 ? 'rejected' : 'responded' } } };
  }
} }));
import { invokePeerConfiguredFeatureModel } from '#composition/core/model-invocation/index.js';
import { modelInvocationCommandSchema } from '#domain/index.js';
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
});
