import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { executeConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { operationsConfigSchema, registerOperationAdapterModule, registerProviderConfig } from '#adapters/index.js';
import { AdapterRegistry, type EffectTarget, type EffectApplyRequest, type AdapterModuleRegistration } from '#engine/index.js';
import { CORE_API_VERSION, type AdapterModuleManifest, type EffectTargetRef } from '#domain/index.js';
import { clearConfigCache, productResourcePath, type StandardSchemaV1 } from '#platform/index.js';

// DEPS-SCHEMA: an Enterprise/ERP module is not bound to Deckent's schema library. Every options schema below is a hand-written
// Standard Schema v1 object (https://standardschema.dev, spec 1.1.0) — no zod, no new dependency — registered through the real registry.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });

type Validate = StandardSchemaV1.Props<unknown, { readonly kind: string }>['validate'];
const standard = (validate: Validate): StandardSchemaV1<unknown, { readonly kind: string }> => ({ '~standard': { version: 1, vendor: 'deckent-test', validate } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Strict `{ kind: non-empty string }` without any schema library. */
const kindOnly = standard(value => isRecord(value) && Object.keys(value).length === 1 && typeof value['kind'] === 'string' && value['kind'].length > 0
  ? { value: Object.freeze({ kind: value['kind'] }) } : { issues: [{ message: 'kind: non-empty string, no other keys', path: ['kind'] }] });

class MemoryRecordTarget implements EffectTarget {
  readonly records = new Map<string, number>(); readonly writes: string[] = []; private readonly applied = new Map<string, string>();
  constructor(readonly kind: string, private readonly label = 'standard') {}
  identity() { return `${this.kind}@${this.label}`; }
  async observe(target: EffectTargetRef) { const version = this.records.get(target.id); return { version: version === undefined ? null : `"m${version}"` }; }
  async apply(request: EffectApplyRequest) {
    const current = this.records.get(request.target.id) ?? 0;
    this.records.set(request.target.id, current + 1); this.writes.push(request.idempotencyKey);
    const version = `"m${current + 1}"`; this.applied.set(request.idempotencyKey, version); return { version };
  }
  async lookup(_target: EffectTargetRef, key: string) { const version = this.applied.get(key); return version === undefined ? { status: 'absent' as const } : { status: 'applied' as const, version }; }
}
const manifest = (namespace: string, adapterId: string, tier: AdapterModuleManifest['module']['tier'] = 'enterprise'): AdapterModuleManifest => ({
  schemaVersion: 1, module: { id: `${namespace}.module`, version: '1.0.0', tier, namespace: tier === 'core' ? null : namespace },
  requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
  provides: { targetAdapters: [{ adapterId, version: 1 }], operations: [] }, signature: null });
const targets = new Map<string, MemoryRecordTarget>();
const registration = (namespace: string, adapterId: string, optionsSchema: StandardSchemaV1<unknown, { readonly kind: string }>): AdapterModuleRegistration => ({
  manifest: manifest(namespace, adapterId),
  // The factory receives the registry-validated output; it never re-parses with a library of Deckent's choosing.
  factories: { [adapterId]: { optionsSchema, create: (options: unknown) => { const t = new MemoryRecordTarget((options as { kind: string }).kind); targets.set(t.kind, t); return t; } } } });

it('registers a non-zod Standard Schema module through the process registry, validates its options in config and executes through it', async () => {
  let rejected = 0;
  registerOperationAdapterModule(registration('erp', 'erp.record', kindOnly));
  // An async validator is refused as a typed issue; its rejection is consumed (vitest fails the file on an unhandled rejection).
  registerOperationAdapterModule(registration('slow', 'slow.record', standard(() => { rejected++; return Promise.reject(new Error('remote lookup')); })));
  // A vendor whose declared output type lies: success without a string `kind`.
  registerOperationAdapterModule(registration('liar', 'liar.record', standard(() => ({ value: { kind: 42 } as never }))));
  registerProviderConfig();
  const issues = (value: unknown) => { const r = operationsConfigSchema.safeParse(value); return r.success ? [] : r.error.issues.map(i => i.message); };
  expect(issues({ catalog: [], targets: [{ adapter: 'erp.record', options: { kind: 'order' } }] })).toEqual([]);
  expect(issues({ catalog: [], targets: [{ adapter: 'erp.record', options: { kind: 'order', extra: 1 } }] })).toEqual(['OPERATION_TARGET_OPTIONS_INVALID']);
  expect(issues({ catalog: [], targets: [{ adapter: 'erp.record', options: { kind: 'o' } }, { adapter: 'erp.record', options: { kind: 'o' } }] })).toEqual(['OPERATION_TARGET_DUPLICATE']);
  expect(issues({ catalog: [], targets: [{ adapter: 'slow.record', options: { kind: 'x' } }] })).toEqual(['OPERATION_TARGET_OPTIONS_ASYNC']);
  expect(rejected).toBe(1);
  expect(issues({ catalog: [], targets: [{ adapter: 'liar.record', options: { kind: 'x' } }] })).toEqual(['OPERATION_TARGET_OPTIONS_INVALID']);
  await new Promise(resolve => setImmediate(resolve));

  const root = await mkdtemp(join(tmpdir(), 'dn-standard-schema-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home') } };
  const operations = { catalog: [{ schemaVersion: 1, operation: { id: 'post-order', version: 1 }, targetKind: 'order', effectClass: 'write', approval: 'policy',
    precondition: 'none', compensation: null, inputMaxBytes: 4096 }], targets: [{ adapter: 'erp.record', options: { kind: 'order' } }] };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, operations }));
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'standard-schema', restrictions: [], grants: [
    { id: 'ops', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } }] }), { mode: 0o600 });
  const result = await executeConfiguredOperation(project, { schemaVersion: 1, commandId: 'c1', scopeId: 's', operation: { id: 'post-order', version: 1 },
    target: { kind: 'order', id: 'O-1' }, idempotencyKey: 'k1', input: { qty: 1 }, expectedVersion: null }, options);
  expect(result).toMatchObject({ status: 'settled', version: '"m1"', target: { kind: 'order', id: 'O-1' } });
  expect(targets.get('order')?.records.get('O-1')).toBe(1);
});

it('admits only Standard Schema v1 factories, refuses async or kind-less output at target construction with typed codes, and snapshots validate at admission', () => {
  const refuse = (optionsSchema: unknown) => expect(() => AdapterRegistry.create([{ manifest: manifest('core', 'records', 'core'),
    factories: { records: { optionsSchema: optionsSchema as never, create: () => new MemoryRecordTarget('record') } } }])).toThrow(expect.objectContaining({ code: 'REGISTRY_FACTORY_MISMATCH' }));
  refuse({ safeParse: () => ({ success: true, data: { kind: 'x' } }) });
  refuse({ '~standard': { version: 2, vendor: 'future', validate: () => ({ value: { kind: 'x' } }) } });
  refuse({ '~standard': { version: 1, vendor: 'broken' } });

  const build = (optionsSchema: StandardSchemaV1<unknown, { readonly kind: string }>) => {
    const registry = AdapterRegistry.create([{ manifest: manifest('core', 'records', 'core'), factories: { records: { optionsSchema, create: (o: unknown) => new MemoryRecordTarget((o as { kind: string }).kind) } } }]);
    registry.seal(); return registry;
  };
  const config = [{ adapter: 'records', options: { kind: 'record' } }];
  expect(() => build(standard(() => Promise.resolve({ value: { kind: 'record' } }))).targets(config)).toThrow(expect.objectContaining({ code: 'REGISTRY_OPTIONS_ASYNC' }));
  expect(() => build(standard(() => ({ value: {} as never }))).targets(config)).toThrow(expect.objectContaining({ code: 'REGISTRY_OPTIONS_INVALID' }));
  expect(() => build(kindOnly).targets([{ adapter: 'records', options: { kind: '' } }])).toThrow(expect.objectContaining({ code: 'REGISTRY_OPTIONS_INVALID' }));
  expect(build(kindOnly).targetOptions('records', { kind: 'record' })).toEqual({ status: 'valid', value: { kind: 'record' } });
  expect(build(kindOnly).targetOptions('nope', { kind: 'record' })).toEqual({ status: 'unknown' });

  // Astra 2126 R2 for Standard Schema: the registrant keeps a mutable `~standard` object; replacing its validate after sealing
  // must not change what a validated configuration resolves to.
  const props = { version: 1 as const, vendor: 'mutable', validate: kindOnly['~standard'].validate };
  const registry = build({ '~standard': props });
  props.validate = () => ({ value: { kind: 'hijacked' } });
  expect(registry.targetOptions('records', { kind: 'record' })).toEqual({ status: 'valid', value: { kind: 'record' } });
  expect(registry.targets(config).resolve('record')?.identity()).toBe('record@standard');
  expect(registry.targets(config).resolve('hijacked')).toBeNull();
});

it('keeps zod 3.25 option schemas working unchanged through their ~standard interface (same issues, same output)', () => {
  const zodOptions = z.object({ kind: z.string().min(1) }).strict();
  expect(zodOptions['~standard'].vendor).toBe('zod');
  const registry = AdapterRegistry.create([{ manifest: manifest('core', 'records', 'core'), factories: { records: { optionsSchema: zodOptions, create: (o: unknown) => new MemoryRecordTarget((o as { kind: string }).kind, 'zod') } } }]);
  registry.seal();
  expect(registry.targetOptions('records', { kind: 'record' })).toEqual({ status: 'valid', value: { kind: 'record' } });
  const invalid = registry.targetOptions('records', { kind: 'record', extra: true });
  expect(invalid.status).toBe('invalid');
  expect(invalid.status === 'invalid' && invalid.issues.map(issue => issue.message)).toEqual(zodOptions.safeParse({ kind: 'record', extra: true }).error?.issues.map(issue => issue.message));
  expect(registry.targets([{ adapter: 'records', options: { kind: 'record' } }]).resolve('record')?.identity()).toBe('record@zod');
});
