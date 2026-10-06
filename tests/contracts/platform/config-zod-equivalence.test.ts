import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS, getConfigFieldDefault } from '#platform/core/config-fields/index.js';
import { CORE_SCHEMA, configSections, createDefaultConfig, getConfigMetadata } from '#platform/core/config/index.js';
import { registerProviderConfig, readTerminalFetchConfig, readTerminalScratchConfig, readTerminalShellConfig, terminalConfigSchema } from '../../../src/adapters/index.js';

registerProviderConfig();

/**
 * ZOD4-PREP step 1 (owner 2026-09-29, proof/DEPS-SCHEMA-2026-09-29/zod4-migration-plan.md §1.1): characterization of today's
 * (zod 3.25.76) config defaults, so the zod 4 swap cannot silently change them. Guards, per https://zod.dev/v4/changelog (read 2026-09-29):
 * - ".default() has changed in a subtle way. If the input is `undefined`, ZodDefault short-circuits the parsing process and returns
 *   the default value" — a v3 `object(...).default({})` (or an incomplete literal such as `artifacts.default({ maxBytes })`) applied the
 *   inner defaults; under v4 it returns the literal as is (`.prefault()` keeps the v3 behaviour). Every object-valued default in
 *   config-fields is covered below, including the two incomplete literals the plan's `.default({})` grep misses.
 * - `.readonly()` behind `.default(...)`: observed 3.25.76 vs 4.6.5 (proof/ZOD4-PREP-2026-09-29/logs/probe-v*.json) — v3 returns a
 *   frozen default, v4 an unfrozen one.
 * The full defaulted config is a committed fixture (sorted keys); refresh only deliberately with `vitest run <this file> -u`
 * and review the diff.
 */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
const golden = (value: unknown) => `${JSON.stringify(sorted(value), null, 2)}\n`;
const fieldKeys = Object.keys(CONFIG_FIELDS) as (keyof typeof CONFIG_FIELDS)[];
const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 1, pids: 1, cpus: 1, logMaxSizeKiB: 1, logMaxFiles: 1,
  tmpBytes: 1, deadlineMs: 1, controlTimeoutMs: 1, outputBytes: 1 };

describe('config defaults (zod 4 .default/.prefault guard)', () => {
  it('the fully defaulted config (kernel fields and every registered section) equals the committed golden', async () => {
    await expect(golden(createDefaultConfig())).toMatchFileSnapshot('../../fixtures/config-golden/defaults.json');
  });

  it('every field default is one value: field schema parse(undefined), getConfigFieldDefault, CORE_SCHEMA.parse({}) and metadata agree', () => {
    const defaults = createDefaultConfig(), core = CORE_SCHEMA.parse({}) as Record<string, unknown>;
    const metadata = new Map(getConfigMetadata().map(entry => [entry.key, entry.defaultValue]));
    for (const key of fieldKeys) {
      const value = CONFIG_FIELDS[key].schema.parse(undefined);
      expect(getConfigFieldDefault(key), key).toEqual(value);
      expect(core[key], key).toEqual(value);
      expect(defaults[key], key).toEqual(value);
      expect(metadata.get(key), key).toEqual(value);
    }
  });

  it('registered sections: which default from {} and which stay absent is fixed', () => {
    const outcome = Object.fromEntries([...configSections()].map(([name, { schema }]) => [name, schema.safeParse({}).success]));
    expect(outcome).toEqual({ provider_catalog: false, provider_invocation_profiles: false, provider_spending: false, provider_spend_audit: false,
      inference_serving: false, terminal: true, operations: true, secrets: false, decision: false });
    const defaults = createDefaultConfig();
    expect(defaults['terminal']).toEqual({ persistHistory: true, autostartService: true, serviceStartTimeoutMs: 20_000 });
    expect(defaults['operations']).toEqual({ catalog: [], targets: [] });
    // SECRET-K1: `secrets` stays absent from the defaults, so a healed or default-filled project file never carries a backend selection.
    // AOF-DECISION-PORT: no universal decision threshold is synthesized; a missing `decision` section means unavailable.
    for (const name of ['provider_catalog', 'provider_invocation_profiles', 'provider_spending', 'provider_spend_audit', 'inference_serving', 'secrets', 'decision']) {
      expect(Object.hasOwn(defaults, name), name).toBe(false);
    }
  });

  it('nested object defaults apply at every level (the leaf values a v4 short-circuit would drop)', () => {
    const d = CORE_SCHEMA.parse({});
    expect(d.layout).toEqual({ root: null, resources: {} });
    expect(d.storage).toEqual({ driver: 'sqlite', sqlite: { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' } });
    // Incomplete literal `.default({ maxBytes: 16777216 })`: maxInputs and patchPreview come from the inner schema.
    expect(d.artifacts).toEqual({ maxBytes: 16_777_216, maxInputs: 64, patchPreview: { maxEntries: 10_000, maxDepth: 32, maxPathBytes: 1024 } });
    expect(d.installation).toEqual({ profileMaxBytes: 1_048_576, writeLockTimeoutMs: 2000, imageProbe: { timeoutMs: 5000, outputBytes: 65_536 },
      identityProbe: { timeoutMs: 2000, outputBytes: 65_536 }, machineIdentity: { source: null }, requireMachineBinding: false,
      packageMeasurement: { maxFiles: 8192, maxFileBytes: 67_108_864, maxTotalBytes: 536_870_912, maxDepth: 32 } });
    expect(d.approvals).toEqual({ requestTtlMs: 600_000, sessionTtlMs: 60_000, pageSize: 100, keyFile: 'authority.key' });
    expect(d.cli).toEqual({ graphInputMaxBytes: 1_048_576, invocationInputMaxBytes: 1_048_576 });
    expect(d.mcp).toEqual({ inputMaxBytes: 1_048_576, responseMaxBytes: 1_048_576, maxConcurrentCalls: 8 });
    expect(d.service).toEqual({ identity: null, inputMaxBytes: 1_048_576, responseMaxBytes: 1_048_576, maxConnections: 32, maxConcurrentRequests: 16,
      maxConcurrentExecutions: 8, headerTimeoutMs: 10_000, responseTimeoutMs: 10_000, acceptRetryDelayMs: 25, acceptRetryLimit: 3, shutdownGraceMs: 30_000, idleShutdown: { afterMs: 900_000 } });
    expect(d.runRuntime).toEqual({ parking: { schemaVersion: 1, timeoutMs: 86400000 }, maxConcurrentRuns: 8, maxReservationsPerTurn: 4, pollIntervalMs: 1000, failureBackoffMs: 5000, pageSize: 64 });
    expect(d.inspection).toEqual({ maxPageSize: 64, policyMaxBytes: 1_048_576,
      workers: { heartbeatMs: 2000, staleMs: 10_000, maxFileBytes: 65_536, maxEntries: 4096, sources: [] } });
    expect(d.toolchains).toEqual({ currency: { mode: 'report', registryEndpoint: 'https://registry.npmjs.org', timeoutMs: 5000, responseMaxBytes: 65_536 },
      update: { mode: 'auto', buildTimeoutMs: 1_800_000, outputBytes: 1_048_576, atStartup: true, intervalMs: 86_400_000, failedContextsKept: 3 } });
    expect(d.company).toEqual({ id: 'default' });
    for (const retired of ['live_trace', 'providers', 'mode', 'auth_mode', 'spawn_backend']) expect(d).not.toHaveProperty(retired);
    for (const key of ['execution', 'cancellation', 'cancellationRuntime', 'reconciliationRuntime', 'admission'] as const) expect(d[key], key).toBeNull();
  });

  // One row per object-valued `.default(...)` parent: a partial authored object must receive the committed golden subtree (compared to the
  // fixture, not to a live parse({}), so a short-circuit at one nested site cannot hide on both sides).
  const committed = JSON.parse(readFileSync(new URL('../../fixtures/config-golden/defaults.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const partials: readonly (readonly [string, Record<string, unknown>])[] = [
    ['layout', { layout: {} }], ['storage', { storage: {} }], ['storage', { storage: { driver: 'sqlite' } }],
    ['artifacts', { artifacts: { maxBytes: 16_777_216 } }], ['artifacts', { artifacts: { maxBytes: 16_777_216, patchPreview: { maxEntries: 10_000, maxDepth: 32, maxPathBytes: 1024 } } }],
    ['installation', { installation: {} }], ['installation', { installation: { imageProbe: {}, packageMeasurement: {} } }],
    ['installation', { installation: { identityProbe: {}, imageProbe: {}, packageMeasurement: {} } }],
    ['approvals', { approvals: {} }], ['cli', { cli: {} }], ['mcp', { mcp: {} }], ['service', { service: {} }], ['runRuntime', { runRuntime: {} }],
    ['inspection', { inspection: {} }], ['inspection', { inspection: { workers: {} } }],
    ['toolchains', { toolchains: {} }], ['toolchains', { toolchains: { currency: {} } }], ['toolchains', { toolchains: { update: {} } }],
    ['company', { company: {} }],
  ];
  it.each(partials)('partial %s %j defaults to the committed golden subtree', (key, input) => {
    expect(sorted((CORE_SCHEMA.parse(input) as Record<string, unknown>)[key])).toEqual(committed[key]);
  });

  it('nullable-with-inner-defaults fields apply their inner defaults once authored', () => {
    const parsed = CORE_SCHEMA.parse({ execution: { docker, git: { gitExecutable: 'git', timeoutMs: 1 } },
      cancellation: { maxConcurrentDeliveries: 1 }, cancellationRuntime: { scopeIds: ['a'] }, reconciliationRuntime: { scopeIds: ['a'] } });
    // `adoption: ADOPTION_TARGET_SETTINGS.default({ targets: [] })` is an incomplete literal: `verification: null` comes from the inner schema.
    // EXEC-RELEASE: `retention` is a versioned sub-object whose defaults come from the inner schema too.
    expect(parsed.execution).toEqual({ docker, git: { gitExecutable: 'git', timeoutMs: 1, outputBytes: 4_194_304 }, adoption: { targets: [], verification: null },
      retention: { schemaVersion: 1, release: 'after-retained-patch', sweepLimit: 16 } });
    // A retention section of an unknown version or with unknown keys is a typed config refusal, never a silent default.
    for (const retention of [{ schemaVersion: 2 }, { schemaVersion: 1, release: 'never' }, { schemaVersion: 1, extra: true }, { schemaVersion: 1, sweepLimit: 0 }])
      expect(CORE_SCHEMA.safeParse({ execution: { docker, git: { gitExecutable: 'git', timeoutMs: 1 }, retention } }).success).toBe(false);
    expect(parsed.cancellation).toEqual({ maxConcurrentDeliveries: 1, recoveryPageSize: 64, maxAttempts: 3, retryDelayMs: 1000, claimTtlMs: 30_000 });
    expect(parsed.cancellationRuntime).toEqual({ scopeIds: ['a'], pollIntervalMs: 1000, failureBackoffMs: 5000 });
    expect(parsed.reconciliationRuntime).toEqual({ scopeIds: ['a'], pollIntervalMs: 1000, failureBackoffMs: 5000, pageSize: 64, maxConcurrentReconciliations: 4 });
  });

  it('a defaulted readonly value is frozen exactly like an authored one (storage.sqlite)', () => {
    expect(Object.isFrozen(CORE_SCHEMA.parse({}).storage.sqlite)).toBe(true);
    expect(Object.isFrozen(CORE_SCHEMA.parse({ storage: {} }).storage.sqlite)).toBe(true);
    expect(Object.isFrozen(CORE_SCHEMA.parse({ storage: { sqlite: { busyTimeoutMs: 1, journalMode: 'delete', durability: 'extra' } } }).storage.sqlite)).toBe(true);
    // Other defaulted objects are plain (not frozen) today; the migration must not start freezing or sharing them either.
    const first = CORE_SCHEMA.parse({}), second = CORE_SCHEMA.parse({});
    expect(Object.isFrozen(first.installation)).toBe(false);
    expect(first.installation).not.toBe(second.installation);
    expect(first.layout.resources).not.toBe(second.layout.resources);
  });

  it('terminal: optional sub-objects stay absent; their readers fill documented defaults', () => {
    expect(terminalConfigSchema.parse({})).toEqual({ persistHistory: true, autostartService: true, serviceStartTimeoutMs: 20_000 });
    expect(terminalConfigSchema.parse({ shell: { schemaVersion: 1 } }).shell).toEqual({ schemaVersion: 1, timeoutMs: 300_000, realm: 'prefer-sandbox', environment: [] });
    expect(readTerminalShellConfig({})).toEqual({ realm: 'prefer-sandbox', timeoutMs: 300_000, environment: [] });
    expect(readTerminalScratchConfig({})).toEqual({ writeMaxBytes: 1_048_576, sessionMaxBytes: 67_108_864, installationMaxBytes: 536_870_912, retentionDays: 7, sweepIntervalMs: 3_600_000 });
    expect(readTerminalFetchConfig({ terminal: {} })).toEqual({ egress: 'none', allowedHosts: [], maxBytes: 4_194_304, timeoutMs: 30_000, maxRedirects: 3 });
  });
});
