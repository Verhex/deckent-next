import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, ready: true, preflights: 0 }));
vi.mock('../../../src/composition/core/model-invocation/internal/context.js', () => ({
  loadInvocationContext: async () => ({ config: {}, document: {}, freshConfig: async () => state.config }),
}));
vi.mock('../../../src/composition/core/model-invocation/internal/delivery-audit.js', () => ({ configuredModelInvocationDeliverySurfaces: () => [] }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(), effectiveTerminalOutputCap: () => 32 }));
vi.mock('../../../src/composition/core/model-invocation/internal/invoke.js', () => ({ application: (...args: unknown[]) => ({
  preview: async (_command: unknown, _credential: unknown, _signal: unknown, checks: { credentialPresent(profile: unknown): Promise<boolean> }) => {
    expect(args[3]).toBe(true); expect(args[4]).toBe('feature');
    // The composition must route a session reference through native admission, never through a named API-key lookup.
    expect(await checks.credentialPresent({ adapter: { id: 'siwc-responses', definition: {} } })).toBe(true);
    state.preflights++;
    if (!state.ready) throw Object.assign(new Error(), { code: 'OAUTH_CONNECTION_REAUTHORIZE' });
  },
}) }));
import { inspectConfiguredInvocableModels } from '../../../src/composition/core/model-invocation/index.js';

it('lets SIWC readiness reach its local native custody check and never reports a failed check as usable', async () => {
  state.config = { provider_catalog: { schemaVersion: 1, revision: 'catalog', providers: [{ id: 'plan', version: 1,
    models: [{ id: 'chat', version: 1, nativeId: 'chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
      capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] }] }] } };
  state.ready = true; state.preflights = 0;
  expect((await inspectConfiguredInvocableModels('/fixture', 'scope')).models[0]?.availability.invocable).toBe(true);
  state.ready = false;
  expect((await inspectConfiguredInvocableModels('/fixture', 'scope')).models[0]?.availability.invocable).toBe(false);
  expect(state.preflights).toBe(2);
});
