import { readFileSync } from 'node:fs';
import * as domainScalars from '#domain/core/primitives/index.js';
import * as platformScalars from '#platform/core/validate/index.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as v3 } from 'zod/v3';
import { workerEventSchema } from '#domain/index.js';
import { agentToolSpecSchema, effectCommandSchema, identitySchema, immutableJsonObjectSchema, operationDescriptorSchema, sanitizeIssues } from '#domain/index.js';
import { ConfigApplication, parseConfigInput, RUNTIME_SERVICE_LIFECYCLE_VERSIONS, runtimeServiceLifecycleRequestSchema } from '#engine/index.js';
import { CORE_SCHEMA, registerConfigSection, createDefaultConfig, validateConfig } from '#platform/core/config/index.js';
import { operationsConfigSchema, registerProviderConfig } from '#adapters/core/contract/index.js';
import { nativeCodingInvocationSchema } from '#adapters/core/native-coding/index.js';
import { processCommandSchema } from '#adapters/core/process-runner/index.js';

registerProviderConfig();

/**
 * ZOD4-PREP step 1 (owner 2026-09-29, zod4-migration-plan.md §1.4 and card scope (d)): zod behaviours used at public boundaries
 * (config, MCP/SDK command wire, runtime service wire, agent tool data, adapter contracts), pinned on zod 3.25.76.
 * Guards, per https://zod.dev/v4/changelog (read 2026-09-29) unless marked "observed" (3.25.76 vs 4.6.5 probe,
 * proof/ZOD4-PREP-2026-09-29/logs/probe-v*.json):
 * - "`z.unknown()` and `z.any()` ... no longer key optional"; "As of v4.4.0 the key is required at parse time too";
 * - `ZodEffects` removed (refine/transform become checks / ZodPipe+ZodTransform); `.refine()` "ctx.path removed";
 * - `.strict()`/`.passthrough()` deprecated (z.strictObject/z.looseObject); `._def` moved to `._zod.def` (registerConfigSection's
 *   strictness check reads `_def.unknownKeys`);
 * - `z.uuid()` "validates more strictly against RFC 9562/4122" (observed: a version-9 UUID is accepted by 3.25.76, refused by 4.6.5);
 * - observed: `.readonly().default(...)` returns a frozen default on v3, an unfrozen one on v4.
 * The migration retains these acceptance sets, including the historical non-RFC UUID version nibble.
 */
const command = { schemaVersion: 1, commandId: 'c', scopeId: 's', operation: { id: 'post-order', version: 1 }, target: { kind: 'records', id: 'r' },
  idempotencyKey: 'k', expectedVersion: null };

describe('z.unknown() keys at public boundaries (v4 ≥ 4.4 makes them required)', () => {
  it('an effect command (MCP/SDK execute_operation) without `input` is admitted and keeps the key absent', () => {
    const parsed = effectCommandSchema.parse(command);
    expect(Object.hasOwn(parsed, 'input')).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('a config operations target without `options` reaches the adapter registry (one custom issue, no invalid_type)', () => {
    const result = operationsConfigSchema.safeParse({ targets: [{ adapter: 'http-conditional' }] });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message })))
      .toEqual([{ path: [], code: 'custom', message: 'OPERATION_TARGET_OPTIONS_INVALID' }]);
  });

  it('the runtime service lifecycle request requires `input` through its own refine (custom issue on path input)', () => {
    const request = { schemaVersion: RUNTIME_SERVICE_LIFECYCLE_VERSIONS[0], requestId: 'r', operation: 'describeService' };
    const result = runtimeServiceLifecycleRequestSchema.safeParse(request);
    expect(result.error!.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message })))
      .toEqual([{ path: ['input'], code: 'custom', message: 'RUNTIME_SERVICE_INPUT_REQUIRED' }]);
    expect(runtimeServiceLifecycleRequestSchema.safeParse({ ...request, input: undefined }).success).toBe(true);
  });
});

describe('transform / refine / superRefine outcomes', () => {
  it('immutable JSON transform: frozen deep copy on success, one custom JSON_VALUE_INVALID issue on failure', () => {
    const source = { a: { b: [1, 'x'] } }, parsed = immutableJsonObjectSchema.parse(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed['a'])).toBe(true);
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    for (const input of [[1], 'text', null, cyclic, { f: () => 1 }]) {
      const result = immutableJsonObjectSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error!.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message }))).toEqual([{ path: [], code: 'custom', message: 'JSON_VALUE_INVALID' }]);
    }
  });

  it('sanitizeIssues: refine on a primitive, superRefine messages on a readonly descriptor', () => {
    expect(sanitizeIssues(identitySchema.safeParse(' padded').error!.issues)).toEqual([{ path: [], code: 'custom' }]);
    const descriptor = { schemaVersion: 1, operation: { id: 'o', version: 1 }, targetKind: 'records', effectClass: 'irreversible', approval: 'policy',
      precondition: 'none', compensation: { id: 'c', version: 1 }, inputMaxBytes: 1 };
    const result = operationDescriptorSchema.safeParse(descriptor);
    expect(result.error!.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message }))).toEqual([
      { path: [], code: 'custom', message: 'EFFECT_IRREVERSIBLE_REQUIRES_APPROVAL' }, { path: [], code: 'custom', message: 'EFFECT_IRREVERSIBLE_NOT_COMPENSABLE' }]);
    expect(sanitizeIssues(effectCommandSchema.safeParse({ ...command, schemaVersion: 2, operation: { id: 'o', version: 0 } }).error!.issues))
      .toEqual([{ path: ['schemaVersion'], code: 'invalid_literal' }, { path: ['operation', 'version'], code: 'too_small' }]);
  });

  it('a base-shape failure suppresses the object refinements (no custom issue alongside it)', () => {
    const result = operationDescriptorSchema.safeParse({ schemaVersion: 1, operation: { id: 'o', version: 1 }, targetKind: 'records', effectClass: 'irreversible',
      approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 'x' });
    expect(sanitizeIssues(result.error!.issues)).toEqual([{ path: ['inputMaxBytes'], code: 'invalid_type' }]);
  });
});

describe('unknown-key policy: strict, passthrough', () => {
  it('strict objects name the unknown keys on the object path', () => {
    const result = effectCommandSchema.safeParse({ ...command, extra: 1, other: 2 });
    expect(result.error!.issues.map(issue => ({ path: issue.path, code: issue.code, keys: (issue as { keys?: string[] }).keys })))
      .toEqual([{ path: [], code: 'unrecognized_keys', keys: ['extra', 'other'] }]);
  });

  it('agent tool inputSchema is passthrough: JSON Schema keywords beyond the subset survive parsing', () => {
    const spec = agentToolSpecSchema.parse({ name: 'read_file', version: 1, toolClass: 'read', description: 'd',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false, $schema: 'x' } });
    expect(spec.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false, $schema: 'x' });
  });

  it('config sections must be strict objects: strip and passthrough objects are refused at registration', async () => {
    expect(() => registerConfigSection('zod4_prep_strip', z.object({ a: z.number() }), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } })).toThrow(expect.objectContaining({ code: 'CONFIG_SECTION_INVALID' }));
    expect(() => registerConfigSection('zod4_prep_loose', z.object({ a: z.number() }).passthrough(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } })).toThrow(expect.objectContaining({ code: 'CONFIG_SECTION_INVALID' }));
    expect(Object.hasOwn(CORE_SCHEMA.shape, 'zod4_prep_strip')).toBe(false);
    const projection = { type: 'object', properties: { value: { type: 'integer', minimum: 0, maximum: 10 } }, additionalProperties: false };
    const foreign = { '~standard': { version: 1 as const, vendor: 'non-zod-fixture',
      validate: (input: unknown) => {
        const row = input as { value?: unknown } | null;
        return row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).every(key => key === 'value')
          && (row.value === undefined || typeof row.value === 'number' && Number.isInteger(row.value) && row.value >= 0 && row.value <= 10)
          ? { value: { value: row.value ?? 1 } } : { issues: [{ message: 'invalid section', path: ['value'] }] };
      }, jsonSchema: { input: (options: { target: string }) => { expect(options.target).toBe('draft-2020-12'); return projection; }, output: () => projection } } };
    const metadata = { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound' as const, consumers: ['src/platform/core/config'] }, apply: 'live' as const };
    registerConfigSection('zod4_prep_foreign', foreign, { metadata });
    expect(createDefaultConfig()['zod4_prep_foreign']).toEqual({ value: 1 });
    const effective = createDefaultConfig();
    const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } },
      { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
    expect(await app.explain({ keyPath: 'zod4_prep_foreign.value' })).toMatchObject({ key: 'zod4_prep_foreign.value', value: 1, defaultValue: 1, schema: { type: 'integer', minimum: 0, maximum: 10 } });
    expect(parseConfigInput('zod4_prep_foreign.value', '3')).toEqual({ ok: true, value: 3 });
    expect(parseConfigInput('zod4_prep_foreign.value', '-1')).toEqual({ ok: false });
    expect(validateConfig({ zod4_prep_foreign: { value: 3 } }).config['zod4_prep_foreign']).toEqual({ value: 3 });
    expect(() => validateConfig({ zod4_prep_foreign: { value: -1 } })).toThrow(expect.objectContaining({ issues: [{ path: 'zod4_prep_foreign.value', reason: 'SECTION_INVALID' }] }));
    expect(() => registerConfigSection('zod4_prep_foreign_loose', { '~standard': { ...foreign['~standard'], jsonSchema: { input: () => ({ ...projection, additionalProperties: true }), output: () => projection } } }, { metadata }))
      .toThrow(expect.objectContaining({ code: 'CONFIG_SECTION_INVALID' }));
    registerConfigSection('zod4_prep_foreign_empty', { '~standard': { ...foreign['~standard'], validate: () => ({ issues: [] }) } }, { metadata, optional: true });
    expect(() => validateConfig({ zod4_prep_foreign_empty: {} })).toThrow(expect.objectContaining({ issues: [{ path: 'zod4_prep_foreign_empty', reason: 'SECTION_INVALID' }] }));
    registerConfigSection('zod4_prep_foreign_async', { '~standard': { ...foreign['~standard'], validate: async () => ({ value: { value: 1 } }) } }, { metadata, optional: true });
    expect(() => validateConfig({ zod4_prep_foreign_async: {} })).toThrow(expect.objectContaining({ issues: [{ path: 'zod4_prep_foreign_async', reason: 'SECTION_INVALID' }] }));
  });
});

describe('readonly defaults and string formats', () => {
  it('native coding: an omitted discovery gets the frozen default, like an authored one', () => {
    const invocation = { schemaVersion: 2, provider: 'codex', cliVersion: '1.0.0', permissionMode: 'unattended', model: 'm', prompt: 'p' };
    const parsed = nativeCodingInvocationSchema.parse(invocation);
    expect(parsed.discovery).toEqual({ schemaVersion: 1, mode: 'disabled' });
    expect(Object.isFrozen(parsed.discovery)).toBe(true);
    expect(Object.isFrozen(nativeCodingInvocationSchema.parse({ ...invocation, discovery: { schemaVersion: 1, mode: 'repository' } }).discovery)).toBe(true);
  });

  it('config url format: accepted and refused registry endpoints', () => {
    const endpoint = (registryEndpoint: string) => CORE_SCHEMA.safeParse({ toolchains: { currency: { registryEndpoint } } }).success;
    expect(['https://registry.npmjs.org', 'https://localhost:4873', 'https://[::1]:8080/npm', 'https://127.0.0.1'].map(endpoint)).toEqual([true, true, true, true]);
    // alpha.56 U6 (5879c0ec0): the registry also feeds the worker image, so plain http is refused (WORKER_IMAGE_SOURCE_INSECURE), loopback included.
    expect(['registry.npmjs.org', 'https://', 'https://exa mple.com', 'http://localhost:4873'].map(endpoint)).toEqual([false, false, false, false]);
  });

  it('process command uuid: generated ids and the persisted non-RFC version nibble remain valid', () => {
    for (const scalars of [domainScalars, platformScalars]) {
      for (const factory of [scalars.persistedInteger, scalars.persistedUuid, scalars.persistedEmail, scalars.persistedUrl]) expect(factory()).toBe(factory());
      const integer = scalars.persistedInteger();
      expect(integer.positive().safeParse(0).success).toBe(false);
      expect(integer.safeParse(0).success).toBe(true);
    }
    expect(readFileSync(new URL('../../../src/domain/core/primitives/internal/persisted-schema.ts', import.meta.url), 'utf8'))
      .toBe(readFileSync(new URL('../../../src/platform/core/validate/internal/persisted-schema.ts', import.meta.url), 'utf8'));
    const scalarCases: readonly [z.ZodType, z.ZodType, readonly unknown[], readonly boolean[]][] = [
      [domainScalars.persistedDateTime({ offset: true }), platformScalars.persistedDateTime({ offset: true }), ['2026-01-01T00:00Z', '2026-01-01T00:00:00+0100', '2026-02-30T00:00Z', 1], [true, true, false, false]],
      [domainScalars.persistedUuid(), platformScalars.persistedUuid(), ['123e4567-e89b-92d3-a456-426614174000', 'not-a-uuid'], [true, false]],
      [domainScalars.persistedEmail(), platformScalars.persistedEmail(), ['a@example.test', '.a@example.test'], [true, false]],
      [domainScalars.persistedUrl(), platformScalars.persistedUrl(), ['https://example.test', 'mailto:a@example.test', 'not-a-url'], [true, true, false]],
      [domainScalars.persistedInteger(), platformScalars.persistedInteger(), [2 ** 53, 1.5, Infinity, '1'], [true, false, false, false]],
      [domainScalars.persistedNumber(z.number().min(0)), platformScalars.persistedNumber(z.number().min(0)), [Infinity, 0, -Infinity, NaN, '1'], [true, true, false, false, false]],
    ];
    for (const [domain, platform, inputs, expected] of scalarCases) {
      expect(inputs.map(input => domain.safeParse(input).success)).toEqual(expected);
      expect(inputs.map(input => platform.safeParse(input).success)).toEqual(expected);
      for (const input of inputs) expect(domain.safeParse(input)).toEqual(platform.safeParse(input));
    }
    // R1: v3 UTF-16 units, including lone surrogates and transform/check ordering.
    for (const bounds of [{ min: 2 }, { max: 2 }, { length: 2 }, { min: 1, max: 2 }, { max: 2, min: 1 }]) {
      let legacy = v3.string(), native = z.string();
      for (const [kind, limit] of Object.entries(bounds)) {
        legacy = legacy[kind as 'min' | 'max' | 'length'](limit); native = native[kind as 'min' | 'max' | 'length'](limit);
      }
      expect(domainScalars.persistedString(native).minLength).toBe(native.minLength);
      expect(domainScalars.persistedString(native).maxLength).toBe(native.maxLength);
      for (const value of ['', 'a', 'aa', 'aaa', '😀', '😀a', '😀😀', '\ud83d', '\ude00', 'e\u0301', 1, null]) {
        const old = legacy.safeParse(value);
        for (const scalars of [domainScalars, platformScalars]) {
          const current = scalars.persistedString(native).safeParse(value);
          expect(current.success, `${JSON.stringify(bounds)} ${JSON.stringify(value)}`).toBe(old.success);
          const issues = (result: typeof current | typeof old) => result.success ? [] : result.error.issues.map(issue => ({
            code: issue.code, message: issue.message, path: issue.path,
            ...('minimum' in issue ? { minimum: issue.minimum } : {}), ...('maximum' in issue ? { maximum: issue.maximum } : {}),
          }));
          if (typeof value === 'string') expect(issues(current)).toEqual(issues(old));
        }
      }
      expect(platformScalars.toInputJsonSchema(domainScalars.persistedString(native))).toMatchObject({ type: 'string',
        ...('min' in bounds ? { minLength: bounds.min } : {}), ...('max' in bounds ? { maxLength: bounds.max } : {}),
        ...('length' in bounds ? { minLength: bounds.length, maxLength: bounds.length } : {}) });
    }
    expect(domainScalars.persistedString(z.string().trim().min(1).max(2)).parse(' 😀 ')).toBe('😀');
    expect(domainScalars.persistedString(z.string().max(2)).trim().safeParse(' 😀 ').success).toBe(false);
    const untouched = z.string().max(1);
    expect(domainScalars.persistedString(untouched).safeParse('😀').success).toBe(false);
    expect(untouched.safeParse('😀').success).toBe(true);
    expect(domainScalars.persistedString(z.string().max(1, { error: 'retained-limit' })).safeParse('😀').error!.issues[0]!.message).toBe('retained-limit');
    const keyed = z.record(domainScalars.persistedString(z.string().max(2)), z.number());
    expect([keyed.safeParse({ '😀': 1 }).success, keyed.safeParse({ '😀a': 1 }).success]).toEqual([true, false]);
    expect([identitySchema.safeParse('😀'.repeat(128)).success, identitySchema.safeParse('😀'.repeat(129)).success]).toEqual([true, false]);
    // Same public config and worker-event consumers at boundary-1 / boundary / boundary+1.
    for (const [units, expected] of [[255, true], [256, true], [257, false]] as const) {
      const value = '😀'.repeat(Math.floor(units / 2)) + (units % 2 ? 'a' : '');
      const verification = { kind: value, required: true, criteria: [{ evaluator: { id: value, version: 1 }, parameters: {} }] };
      const config = CORE_SCHEMA.safeParse({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}` }, git: { gitExecutable: 'git' }, adoption: { verification } } });
      expect(config.success, `configIdentity ${units}`).toBe(expected);
      if (!expected) expect(config.error!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'too_big', maximum: 256 })]));
    }
    for (const [units, expected] of [[4095, true], [4096, true], [4097, false]] as const) {
      const path = '😀'.repeat(Math.floor(units / 2)) + (units % 2 ? 'a' : '');
      const config = CORE_SCHEMA.safeParse({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}` }, git: { gitExecutable: 'git' },
        workTargets: { schemaVersion: 1, targets: [{ id: 'target', kind: 'git', path, baseRef: 'refs/heads/main' }] } } });
      expect(config.success, `config path ${units}`).toBe(expected);
    }
    const workerTextCases = [
      { limit: 32, field: 'window', event: { kind: 'quota', window: 'w', utilization: 0, resetsAtMs: null, status: 'ok' } },
      { limit: 64, field: 'cliVersion', event: { kind: 'session.started', provider: 'codex', model: 'm', cliVersion: 'v' } },
      { limit: 128, field: 'model', event: { kind: 'session.started', provider: 'codex', model: 'm', cliVersion: 'v' } },
      { limit: 96, field: 'toolId', event: { kind: 'tool.call', toolId: 't', name: 'read', toolClass: 'read', target: null, detail: null } },
      { limit: 256, field: 'target', event: { kind: 'tool.call', toolId: 't', name: 'read', toolClass: 'read', target: null, detail: null } },
      { limit: 240, field: 'excerpt', event: { kind: 'message', role: 'assistant', textBytes: 0, thinking: false, excerpt: '' } },
    ];
    for (const { limit, field, event } of workerTextCases) for (const delta of [-1, 0, 1]) {
      const units = limit + delta, text = '😀'.repeat(Math.floor(units / 2)) + (units % 2 ? 'a' : '');
      expect(workerEventSchema.safeParse({ schemaVersion: 1, sequence: 1, atMs: 0, ...event, [field]: text }).success, `${field} ${units}`).toBe(delta <= 0);
    }
    // Array bounds count elements; regex flags/reset and record string keys retain v3 behavior.
    for (const value of [[], ['😀'], ['😀', '😀'], ['😀', '😀', '😀']]) {
      expect(z.array(z.string()).max(2).safeParse(value).success).toBe(v3.array(v3.string()).max(2).safeParse(value).success);
    }
    for (const flags of ['', 'i', 'g', 'u', 'y']) {
      const current = z.string().regex(new RegExp('^a+$', flags)), old = v3.string().regex(new RegExp('^a+$', flags));
      for (const value of ['aa', 'aa', 'AA', 'b', '😀']) expect(current.safeParse(value).success).toBe(old.safeParse(value).success);
    }
    for (const value of [{}, { '😀': 1 }, { '': 1 }, { a: '1' }, []]) expect(z.record(z.string(), z.number()).safeParse(value).success).toBe(v3.record(v3.string(), v3.number()).safeParse(value).success);
    const issues = [{ code: 'invalid_format' }, { code: 'invalid_value', values: ['x'] }, { code: 'custom', params: { legacyCode: 'invalid_type' } }];
    expect(issues.map(domainScalars.persistedIssueCode)).toEqual(['invalid_string', 'invalid_literal', 'invalid_type']);
    expect(issues.map(platformScalars.persistedIssueCode)).toEqual(['invalid_string', 'invalid_literal', 'invalid_type']);
    const base = { schemaVersion: 1, executable: '/bin/true', args: [], cwd: '/', env: {}, timeoutMs: 1, outputBytes: 1 };
    expect(processCommandSchema.safeParse({ ...base, requestId: randomUUID() }).success).toBe(true);
    expect(processCommandSchema.safeParse({ ...base, requestId: '123e4567-e89b-92d3-a456-426614174000' }).success).toBe(true);
    expect(processCommandSchema.safeParse({ ...base, requestId: 'not-a-uuid' }).success).toBe(false);
  });
});
