import { expect, it, vi, afterEach } from 'vitest';
import { nativeCliCommand, parseNativeCliRegistry, NativeCliRegistryError, nativeCliIds } from '#adapters/core/native-coding/index.js';
import { nativeCliIdSchema, workerProviderSchema, NATIVE_CLI_CHANNELS, catalogChannelSchema } from '#domain/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { compileNativeCodingDockerProfile, assertNativeWorkerBinding } from '#adapters/core/native-coding/index.js';

vi.mock('#adapters/core/native-cli-registry/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#adapters/core/native-cli-registry/index.js')>();
  return { ...actual, nativeCliCommand: vi.fn(actual.nativeCliCommand) };
});
afterEach(() => vi.mocked(nativeCliCommand).mockImplementation(provider => parseNativeCliRegistry(registry).adapters[provider]!));
const template = { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
} };
const invocation = (provider: string) => ({ schemaVersion: 4, provider, cliVersion: 'fixture-1', discovery: { schemaVersion: 1, mode: 'repository' },
  permissionMode: 'unattended', model: { channelId: 'fixture', modelId: 'exact-model', auxiliaryModelIds: [] }, prompt: 'Task' });

it('uses one registry-fed accepted set on every schema and refuses unknown ids', () => {
  expect(nativeCliIds).toEqual(Object.keys(registry.adapters));
  expect([...NATIVE_CLI_CHANNELS].sort()).toEqual([...nativeCliIds].sort());
  for (const id of nativeCliIds) {
    expect(nativeCliIdSchema.safeParse(id).success).toBe(true);
    expect(workerProviderSchema.safeParse(id).success).toBe(true);
    expect(catalogChannelSchema.safeParse({ kind: 'native-cli', cli: id, aliases: [] }).success).toBe(true);
  }
  expect(nativeCliIdSchema.safeParse('unknown-cli').success).toBe(false);
  expect(workerProviderSchema.safeParse('unknown-cli').success).toBe(false);
  expect(() => compileNativeCodingDockerProfile(template, invocation('unknown-cli'))).toThrow('NATIVE_CODING_INVOCATION_INVALID');
});
it.each(['maxTurns', 'settings', 'promptChannel', 'structuredReport', 'modelUsageEvidence'])('refuses missing capability %s without defaults', field => {
  const asset = structuredClone(registry);
  delete (asset.adapters.claude.capabilities as Record<string, unknown>)[field];
  expect(() => parseNativeCliRegistry(asset)).toThrow(NativeCliRegistryError);
  expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it.each([
  ['maxTurns', true], ['settings', 'yes'], ['promptChannel', 'unknown'], ['structuredReport', { flag: '--schema', channel: 'guess' }], ['modelUsageEvidence', 'guess'],
])('validates the capability %s shape', (field, value) => {
  const asset = structuredClone(registry);
  (asset.adapters.claude.capabilities as Record<string, unknown>)[field] = value;
  expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it('rejects old unversioned assets and unsupported versions', () => {
  expect(() => parseNativeCliRegistry(registry.adapters)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  expect(() => parseNativeCliRegistry({ ...registry, schemaVersion: 1 })).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it('accepts a new adapter id in a registry without code vocabulary changes', () => {
  const asset = { ...registry, adapters: { experimental: registry.adapters.codex } };
  expect(Object.keys(parseNativeCliRegistry(asset).adapters)).toEqual(['experimental']);
});
it('compiles and binds maxTurns/settings by capability even for another provider id', () => {
  const loaded = parseNativeCliRegistry(registry), command = loaded.adapters.claude!;
  vi.mocked(nativeCliCommand).mockReturnValue(command);
  const compiled = compileNativeCodingDockerProfile(template, { ...invocation('codex'), maxTurns: 7, discovery: {
    schemaVersion: 1, mode: 'repository', settings: { disableAllHooks: true },
  } });
  expect(compiled.parameters.argv).toContain('--max-turns');
  expect(compiled.parameters.argv).toContain('--settings');
  expect((compiled.parameters.nativeSubscription as Record<string, unknown>).modelUsageEvidence).toBe('session-events');
});
it('refuses removed maxTurns/settings capability even on a traditionally supported id', () => {
  const loaded = parseNativeCliRegistry(registry), command = loaded.adapters.claude!;
  vi.mocked(nativeCliCommand).mockReturnValue({ ...command, capabilities: { ...command.capabilities, maxTurns: null, settings: null } });
  expect(() => compileNativeCodingDockerProfile(template, { ...invocation('claude'), maxTurns: 7 })).toThrow('NATIVE_CODING_TURN_LIMIT_UNSUPPORTED');
  expect(() => compileNativeCodingDockerProfile(template, { ...invocation('claude'), discovery: { schemaVersion: 1, mode: 'repository', settings: { disableAllHooks: true } } })).toThrow('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
});

it('refuses evidence capability substitution at native model admission binding', () => {
  vi.mocked(nativeCliCommand).mockImplementation(provider => parseNativeCliRegistry(registry).adapters[provider]!);
  const compiled = compileNativeCodingDockerProfile(template, invocation('claude'));
  const subscription = compiled.parameters.nativeSubscription as Record<string, unknown>;
  expect(() => assertNativeWorkerBinding({ ...compiled, parameters: { ...compiled.parameters, nativeSubscription: { ...subscription, modelUsageEvidence: 'none' } } })).toThrow('WORKER_MODEL_BINDING_MISMATCH');
});
