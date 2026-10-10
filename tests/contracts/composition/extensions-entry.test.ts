import { expect, it } from 'vitest';
import * as extensions from '../../../src/extensions.js';
import * as sdk from '../../../src/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { openConfiguredSecretStore } from '#adapters/index.js';
import { mcpCapabilityRegistry } from '#engine/index.js';

// ENTERPRISE-EXT-1 (owner K7 = A): `deckent/extensions` is the one public registration entry. This file's module graph is fresh (vitest
// isolates files), so nothing has composed Core yet when the first registration runs.
const memoryBackend = (id: string) => ({ id, create: () => {
  const values = new Map<string, string>();
  return { descriptor: { id, writable: true, enumerable: true }, get: async (name: string) => values.get(name),
    set: async (name: string, value: string) => { values.set(name, value); }, delete: async (name: string) => values.delete(name),
    listNames: async () => [...values.keys()].sort(), inspect: async () => ({ status: 'ready' as const, code: null }) };
} });

it('exports exactly the declared extension surface; the SDK entry exports none of its registrations', () => {
  expect(Object.keys(extensions).sort()).toEqual(['CORE_API_VERSION', 'EffectTargetError', 'RegistryError', 'SECRET_STORE_ID_PATTERN', 'createSecretHelperFactory',
    'registerMcpCapabilityGroup', 'registerOperationAdapterModule', 'registerSecretStoreBackend', 'runCli', 'runMcp']);
  expect(['registerMcpCapabilityGroup', 'registerOperationAdapterModule', 'registerSecretStoreBackend', 'registerProviderConfig'].filter(name => name in sdk)).toEqual([]);
});

it('the distribution MCP runner preserves Core argument validation', async () => {
  await expect(extensions.runMcp(['--project', ' '])).rejects.toThrow('MCP_PROJECT_INVALID');
  await expect(extensions.runMcp(['--unknown'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
});

it('registers a non-Core secret backend before the composition root seals, and refuses every later registration with REGISTRY_SEALED', () => {
  const id = 'overlay.secret-store.memory@1';
  // Admission rules still apply before sealing: the `core.` namespace stays Core's.
  expect(() => extensions.registerSecretStoreBackend(memoryBackend('core.secret-store.overlay@1'))).toThrow(expect.objectContaining({ code: 'REGISTRY_NAMESPACE_RESERVED' }));
  extensions.registerSecretStoreBackend(memoryBackend(id));
  const capability = { schemaVersion: 1 as const, id: 'overlay.erp', version: 1, labelKey: 'overlay.erp.label', noteKey: 'overlay.erp.note', proposed: false,
    cells: [{ id: 'inspect', tools: { erp_inspect: ['inspect'] }, actions: ['inspect'], resource: { kind: 'operation', ids: ['overlay.erp.inspect'] }, scope: 'selected' as const, source: 'literal' as const }] };
  extensions.registerMcpCapabilityGroup(capability);
  composeCore();
  expect(mcpCapabilityRegistry.get(capability.id)).toEqual(capability);
  // The registered backend resolves through the same selection path as Core's own backends.
  expect(openConfiguredSecretStore({ secrets: { store: id } }, {}).descriptor.id).toBe(id);
  const sealed = expect.objectContaining({ name: 'RegistryError', code: 'REGISTRY_SEALED' });
  expect(() => extensions.registerSecretStoreBackend(memoryBackend('overlay.secret-store.late@1'))).toThrow(sealed);
  expect(() => extensions.registerMcpCapabilityGroup({ ...capability, id: 'overlay.late' })).toThrow(sealed);
  expect(() => extensions.registerOperationAdapterModule({ manifest: { schemaVersion: 1, module: { id: 'late.module', version: '0.1.0', tier: 'custom', namespace: 'late' },
    requires: { coreApi: { min: extensions.CORE_API_VERSION, max: extensions.CORE_API_VERSION } }, provides: { targetAdapters: [], operations: [] }, signature: null },
    factories: {} })).toThrow(sealed);
  expect(() => openConfiguredSecretStore({ secrets: { store: 'overlay.secret-store.late@1' } }, {})).toThrow(expect.objectContaining({ code: 'SECRET_STORE_UNKNOWN' }));
});
