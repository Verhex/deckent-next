import { expect, it, vi } from 'vitest';
import { OAuthConnectionError, PolicyAuthorizationError } from '#engine/index.js';
import { SystemTrustedClock } from '#platform/index.js';
const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, ready: true, preflights: 0, policyAvailable: true, inspectStore: vi.fn() }));
vi.mock('#composition/core/model-use/index.js', async original => ({ ...await original<object>(), resolveConfiguredModelUse: vi.fn() }));
vi.mock('#composition/core/siwc/index.js', async original => ({ ...await original<object>(), withConfiguredSiwcModel: state.inspectStore }));
vi.mock('#composition/core/root/index.js', () => ({ loadComposedConfig: async () => state.config }));
vi.mock('#composition/core/policy/index.js', () => ({ contextPolicySource: () => ({ load: async () => {
  if (!state.policyAvailable) throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
  return {};
} }) }));
vi.mock('#composition/core/scoped-request/index.js', async original => ({
  ...await original<object>(), loadConfiguredScopeContext: async () => ({ config: state.config, document: {} }),
}));
vi.mock('../../../src/composition/core/model-invocation/internal/delivery-audit.js', () => ({ configuredModelInvocationDeliverySurfaces: () => [] }));
vi.mock('#adapters/index.js', async original => ({ ...await original<object>(), effectiveTerminalOutputCap: () => 32 }));
vi.mock('../../../src/composition/core/model-invocation/internal/invoke.js', () => ({ application: (options: { readOnly: boolean; entry: string }) => ({
  preview: async (_command: unknown, _credential: unknown, _signal: unknown, checks: { credentialPresent(profile: unknown): Promise<boolean> }) => {
    expect(options.readOnly).toBe(true); expect(options.entry).toBe('feature');
    // The composition must route a session reference through native admission, never through a named API-key lookup.
    expect(await checks.credentialPresent({ adapter: { id: 'siwc-responses', definition: {} } })).toBe(true);
    state.preflights++;
    if (!state.ready) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
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
  expect((await inspectConfiguredInvocableModels('/fixture', 'scope')).models[0]?.availability).toEqual({
    invocable: false, reason: { kind: 'unavailable', code: 'OAUTH_CONNECTION_REAUTHORIZE' },
  });
  expect(state.preflights).toBe(2);
  state.ready = true; state.policyAvailable = false;
  await expect(inspectConfiguredInvocableModels('/fixture', 'scope')).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
  expect(state.preflights).toBe(2); // An unreadable policy must refuse before native admission can claim readiness.

  const { createConfiguredModelInvocationNative } = await vi.importActual<typeof import('../../../src/composition/core/model-invocation/internal/native.js')>(
    '../../../src/composition/core/model-invocation/internal/native.js');
  const { natives } = createConfiguredModelInvocationNative({ config: { projectRoot: '/fixture' } } as never, {}, new SystemTrustedClock());
  const profile = { adapter: { id: 'siwc-responses', definition: { schemaVersion: 1, connectionId: '00000000-0000-4000-8000-000000000001',
    owner: { issuer: 'fixture', subject: 'person' }, rawUse: 'person', delegatedUse: null, apiContinuation: null } } } as never;
  state.inspectStore.mockRejectedValueOnce(new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL', 'binding-changed'));
  await expect(natives.admit(profile)).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', params: { reason: 'binding-changed' } });
  const ambiguous = new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL', 'unbound-store');
  state.inspectStore.mockRejectedValueOnce(ambiguous);
  await expect(natives.admit(profile)).rejects.toBe(ambiguous);
});
