import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { transitionModelActivation, type ModelActivationRecord } from '#domain/core/model-activation/index.js';
import { ModelActivationInspectionApplication, ModelActivationStoreError } from '#engine/core/model-activation/index.js';

const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const query = { schemaVersion: 1 as const, scopeId: 'scope-a', reference };
const principal = { id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['scope-a'] };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 2, nativeId: 'native/model',
    protocols: [{ family: 'responses', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex') };
const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate', scopeId: 'scope-a', reference,
  expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding };
const active = transitionModelActivation(null, activate, definition);
const inactive = transitionModelActivation(active, { schemaVersion: 1, action: 'deactivate', commandId: 'deactivate', scopeId: 'scope-a',
  reference, expectedRevision: 1, expectedBinding: binding });

function fixture(record: ModelActivationRecord | null, options: { deny?: boolean; returned?: unknown } = {}) {
  const state = { verified: 0, authorized: 0, opened: 0, loaded: 0, closed: 0 };
  const app = new ModelActivationInspectionApplication({ async verify() { state.verified++; return principal; } }, {
    async authorize(action, target) { state.authorized++; expect(action).toBe('inspect'); expect(target).toEqual({ scopeId: 'scope-a', reference });
      if (options.deny) throw new Error('POLICY_DENIED'); return { revision: 'policy-1', ruleId: 'inspect-model' }; },
  }, async () => { state.opened++; return {
    async loadRecord(scopeId, input) { state.loaded++; expect({ scopeId, input }).toEqual({ scopeId: 'scope-a', input: reference });
      return (options.returned === undefined ? record : options.returned) as ModelActivationRecord | null; },
    close() { state.closed++; },
  }; });
  return { app, state };
}

it('authorizes before opening and returns explicit missing, active, and inactive inspections without catalog access', async () => {
  for (const activation of [null, active, inactive]) {
    const { app, state } = fixture(activation);
    await expect(app.inspect(query)).resolves.toEqual({ schemaVersion: 1, scopeId: 'scope-a', reference,
      activation, availability: 'not-observed' });
    expect(state).toEqual({ verified: 1, authorized: 1, opened: 1, loaded: 1, closed: 1 });
  }
  const denied = fixture(active, { deny: true });
  await expect(denied.app.inspect(query)).rejects.toThrow('POLICY_DENIED');
  expect(denied.state).toEqual({ verified: 1, authorized: 1, opened: 0, loaded: 0, closed: 0 });
});

it('closes the reader and rejects malformed or mismatched stored results as corrupt', async () => {
  for (const returned of [{ ...active, scopeId: 'other-scope' }, { schemaVersion: 1 }]) {
    const { app, state } = fixture(active, { returned });
    await expect(app.inspect(query)).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_CORRUPT' } satisfies Partial<ModelActivationStoreError>);
    expect(state.closed).toBe(1);
  }
});

it('rejects untrusted query getters and cycles before authentication or reader opening', async () => {
  const { app, state } = fixture(null); let getters = 0;
  const getter = Object.defineProperty({ schemaVersion: 1, scopeId: 'scope-a' }, 'reference', {
    enumerable: true, get() { getters++; return reference; },
  });
  await expect(app.inspect(getter)).rejects.toThrow('MODEL_ACTIVATION_INVALID'); expect(getters).toBe(0);
  const cyclic: Record<string, unknown> = { ...query }; cyclic['cycle'] = cyclic;
  await expect(app.inspect(cyclic)).rejects.toThrow('MODEL_ACTIVATION_INVALID');
  expect(state).toEqual({ verified: 0, authorized: 0, opened: 0, loaded: 0, closed: 0 });
});
