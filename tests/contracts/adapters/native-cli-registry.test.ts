import { expect, it, vi, afterEach } from 'vitest';
import { nativeCliCommand, parseNativeCliRegistry, NativeCliRegistryError, nativeCliIds } from '#adapters/core/native-coding/index.js';
import { nativeCliIdSchema, workerProviderSchema, NATIVE_CLI_CHANNELS, catalogChannelSchema } from '#domain/index.js';
import * as domain from '#domain/index.js';
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
it.each(['maxTurns', 'settings', 'discovery', 'promptChannel', 'structuredReport', 'modelUsageEvidence', 'reasoningEffort', 'eventStream'])('refuses missing capability %s without defaults', field => {
  const asset = structuredClone(registry);
  delete (asset.adapters.claude.capabilities as Record<string, unknown>)[field];
  expect(() => parseNativeCliRegistry(asset)).toThrow(NativeCliRegistryError);
  expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it.each([
  ['maxTurns', true], ['settings', 'yes'], ['promptChannel', 'unknown'], ['structuredReport', { flag: '--schema', channel: 'guess' }], ['modelUsageEvidence', 'guess'],
  // A flag channel needs its flag and the flagless final-text channel may not carry one; the event stream format is a closed set.
  ['discovery', { requiredFlags: [], hiddenProbes: [], checkout: null }], ['discovery', { requiredFlags: ['--safe-mode'], checkout: null }], ['discovery', { requiredFlags: ['-s'], hiddenProbes: [], checkout: null }],
  ['discovery', { requiredFlags: ['--safe-mode'], hiddenProbes: [{ args: ['x'] }], checkout: null }], ['discovery', { requiredFlags: ['--safe-mode'], hiddenProbes: [] }],
  // C2: a checkout realisation carries no flags or probes; G1: it names no paths of its own (the registry's instruction surface is the one list).
  ['discovery', { requiredFlags: ['--safe-mode'], hiddenProbes: [], checkout: {} }],
  ['discovery', { requiredFlags: [], hiddenProbes: [], checkout: { hiddenPaths: ['AGENTS.md'] } }],
  ['structuredReport', { flag: null, channel: 'inline-json' }], ['structuredReport', { flag: '--schema', channel: 'final-text-json' }], ['structuredReport', { channel: 'final-text-json' }], ['eventStream', 'guess'],
])('validates the capability %s shape', (field, value) => {
  const asset = structuredClone(registry);
  (asset.adapters.claude.capabilities as Record<string, unknown>)[field] = value;
  expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it.each([[[]], [['**/AGENTS.md']], [['sub/AGENTS.md']], [['AGENTS.md', 'AGENTS.md']], [undefined]])('G1: the registry instruction surface is required and literal (%j refused)', hiddenPaths => {
  const asset = structuredClone(registry) as unknown as Record<string, unknown>;
  if (hiddenPaths === undefined) delete asset['instructionSurface']; else asset['instructionSurface'] = { hiddenPaths };
  expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it('G1: one instruction-surface list feeds the domain floor and the compiled Cursor checkout, with the exact C2 bytes', () => {
  expect(domain.INSTRUCTION_SURFACE_PATHS).toEqual(parseNativeCliRegistry(registry).instructionSurface.hiddenPaths);
  const compiled = compileNativeCodingDockerProfile(template, { ...invocation('cursor'), discovery: { schemaVersion: 1, mode: 'disabled' } });
  expect((compiled.parameters.nativeSubscription as Record<string, unknown>).checkout).toEqual({ schemaVersion: 1,
    hiddenPaths: ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude', '.codex', '.cursor', '/DECKENT.md', '/.deckent/worker-instructions.md'] });
  // Claude/Codex profiles carry no checkout part; the floor still applies to them through the registry list.
  for (const provider of ['claude', 'codex']) expect(compileNativeCodingDockerProfile(template, { ...invocation(provider), discovery: { schemaVersion: 1, mode: 'disabled' } }).parameters.nativeSubscription).not.toHaveProperty('checkout');
  expect(domain.instructionSurfacePaths(compiled.parameters)).toEqual(domain.INSTRUCTION_SURFACE_PATHS);
  expect(domain.instructionSurfacePaths({ nativeSubscription: { checkout: { schemaVersion: 1, hiddenPaths: ['/docs/x.md'] } } })).toEqual(['/docs/x.md']);
  expect(domain.instructionSurfacePaths(undefined)).toEqual(domain.INSTRUCTION_SURFACE_PATHS);
});
it('pairs disabledArgs with a discovery preflight capability: one without the other is refused', () => {
  const noProof = structuredClone(registry) as unknown as { adapters: Record<string, { disabledArgs: unknown; capabilities: Record<string, unknown> }> };
  noProof.adapters['codex']!.capabilities['discovery'] = null;
  expect(() => parseNativeCliRegistry(noProof)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  const noArgs = structuredClone(registry) as unknown as typeof noProof;
  noArgs.adapters['codex']!.disabledArgs = null;
  expect(() => parseNativeCliRegistry(noArgs)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it('pairs a checkout realisation with empty disabledArgs and an argv realisation with non-empty ones (C2)', () => {
  type Asset = { adapters: Record<string, { disabledArgs: unknown; capabilities: Record<string, unknown> }> };
  const parsed = parseNativeCliRegistry(registry);
  expect(parsed.adapters['cursor']).toMatchObject({ disabledArgs: [], capabilities: { discovery: { requiredFlags: [], hiddenProbes: [] } } });
  expect(parsed.adapters['cursor']!.capabilities.discovery?.checkout).toEqual({});
  expect(parsed.instructionSurface.hiddenPaths).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', '.cursor', '/DECKENT.md', '/.deckent/worker-instructions.md']));
  for (const provider of ['claude', 'codex']) expect(parsed.adapters[provider]!.capabilities.discovery?.checkout).toBeNull();
  const argsWithCheckout = structuredClone(registry) as unknown as Asset;
  argsWithCheckout.adapters['cursor']!.disabledArgs = ['--no-rules'];
  expect(() => parseNativeCliRegistry(argsWithCheckout)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  const emptyArgv = structuredClone(registry) as unknown as Asset;
  emptyArgv.adapters['claude']!.disabledArgs = [];
  expect(() => parseNativeCliRegistry(emptyArgv)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
});
it('binds a pinned Cursor profile only with its frozen checkout part (C2)', () => {
  vi.mocked(nativeCliCommand).mockImplementation(provider => parseNativeCliRegistry(registry).adapters[provider]!);
  const compiled = compileNativeCodingDockerProfile(template, { ...invocation('cursor'), discovery: { schemaVersion: 1, mode: 'disabled' } });
  expect(() => assertNativeWorkerBinding(compiled)).not.toThrow();
  const binding = compiled.parameters.nativeSubscription as Record<string, unknown>, { checkout, ...stripped } = binding;
  expect(checkout).toBeDefined();
  expect(() => assertNativeWorkerBinding({ ...compiled, parameters: { ...compiled.parameters, nativeSubscription: stripped } })).toThrow('WORKER_MODEL_BINDING_MISMATCH');
  const repository = compileNativeCodingDockerProfile(template, invocation('cursor'));
  expect(() => assertNativeWorkerBinding({ ...repository, parameters: { ...repository.parameters, nativeSubscription: { ...(repository.parameters.nativeSubscription as object), checkout } } })).toThrow('WORKER_MODEL_BINDING_MISMATCH');
});
it('binds a pinned Codex profile with disabled discovery and refuses a reordered suppression segment', () => {
  vi.mocked(nativeCliCommand).mockImplementation(provider => parseNativeCliRegistry(registry).adapters[provider]!);
  const compiled = compileNativeCodingDockerProfile(template, { ...invocation('codex'), discovery: { schemaVersion: 1, mode: 'disabled' } });
  const argv = compiled.parameters.argv as string[];
  expect(argv).toContain('skills.include_instructions=false');
  expect(() => assertNativeWorkerBinding(compiled)).not.toThrow();
  const at = argv.indexOf('skills.include_instructions=false'), swapped = [...argv];
  [swapped[at], swapped[at + 2]] = [swapped[at + 2]!, swapped[at]!];
  expect(() => assertNativeWorkerBinding({ ...compiled, parameters: { ...compiled.parameters, argv: swapped } })).toThrow('WORKER_MODEL_BINDING_MISMATCH');
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

it('refuses a stale registry envelope before the pure vocabulary is initialized with the typed asset error', () => {
  for (const input of [registry.adapters, { ...registry, schemaVersion: 1 }, { schemaVersion: 3, adapters: {} }]) {
    expect(() => domain.nativeCliVocabulary(input)).toThrow(NativeCliRegistryError);
    expect(() => domain.nativeCliVocabulary(input)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  }
});
