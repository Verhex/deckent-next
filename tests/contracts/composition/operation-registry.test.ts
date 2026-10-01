import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { executeConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { operationsConfigSchema, registerOperationAdapterModule, registerProviderConfig, httpConditionalAdapterModule } from '#adapters/index.js';
import { AdapterRegistry, EffectTargetError, type EffectTarget, type EffectApplyRequest, type AdapterModuleRegistration } from '#engine/index.js';
import { CORE_API_VERSION, adapterModuleManifestSchema, type AdapterModuleManifest, type EffectTargetRef } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });

/** In-test target: a versioned record map with its own idempotency records. Registered through the registry, never through Core edits. */
class MemoryRecordTarget implements EffectTarget {
  readonly records = new Map<string, number>(); readonly applied = new Map<string, string>(); readonly writes: string[] = [];
  constructor(readonly kind: string) {}
  identity() { return `${this.kind}@memory`; }
  async observe(target: EffectTargetRef) { const version = this.records.get(target.id); return { version: version === undefined ? null : `"m${version}"` }; }
  async apply(request: EffectApplyRequest) {
    const current = this.records.get(request.target.id) ?? 0;
    if (request.expectedVersion !== null && request.expectedVersion !== `"m${current}"`) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    this.records.set(request.target.id, current + 1); this.writes.push(request.idempotencyKey);
    const version = `"m${current + 1}"`; this.applied.set(request.idempotencyKey, version); return { version };
  }
  async lookup(_target: EffectTargetRef, key: string) { const version = this.applied.get(key); return version === undefined ? { status: 'absent' as const } : { status: 'applied' as const, version }; }
}
const targets = new Map<string, MemoryRecordTarget>();
const manifest = (overrides: Partial<AdapterModuleManifest['module']> = {}, extra: Partial<AdapterModuleManifest> = {}): AdapterModuleManifest => ({
  schemaVersion: 1, module: { id: 'test.memory', version: '0.1.0', tier: 'custom', namespace: 'test', ...overrides },
  requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
  provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 1 }], operations: [] }, signature: null, ...extra });
const optionsSchema = z.object({ kind: z.string().min(1) }).strict();
const module = (m: AdapterModuleManifest = manifest(), adapterId = 'test.memory-record'): AdapterModuleRegistration => ({ manifest: m,
  factories: { [adapterId]: { optionsSchema, create: (options: unknown) => { const t = new MemoryRecordTarget(optionsSchema.parse(options).kind); targets.set(t.kind, t); return t; } } } });
const descriptor = (id: string, targetKind: string, precondition: 'record-version' | 'none' = 'record-version') => ({ schemaVersion: 1, operation: { id, version: 1 }, targetKind,
  effectClass: 'write', approval: 'policy', precondition, compensation: null, inputMaxBytes: 4096 });

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] resolves a registry-registered (non-Core) adapter from an unchanged operations config shape and executes through it; Core http-conditional stays a registry entry', async () => {
  registerOperationAdapterModule(module());
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'dn-registry-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home') } };
  const config = { catalog: [descriptor('post-memo', 'memo', 'none')], targets: [{ adapter: 'test.memory-record', options: { kind: 'memo' } }] };
  expect(operationsConfigSchema.safeParse(config).success).toBe(true);
  // The Core entry resolves from the same registry with the same accepted config shape (additive: no literal, no schema bump).
  expect(operationsConfigSchema.safeParse({ catalog: [], targets: [{ adapter: 'http-conditional', options: { kind: 'r', baseUrl: 'https://erp.example/', timeoutMs: 1000, responseMaxBytes: 1024, idempotencyLookup: true } }] }).success).toBe(true);
  expect(httpConditionalAdapterModule.manifest.provides.targetAdapters.map(a => a.adapterId)).toEqual(['http-conditional']);
  // Typed config refusals: unknown adapter, options rejected by the adapter's own schema.
  const issues = (value: unknown) => { const r = operationsConfigSchema.safeParse(value); return r.success ? [] : r.error.issues.map(i => i.message); };
  expect(issues({ catalog: [], targets: [{ adapter: 'acme.unknown', options: { kind: 'x' } }] })).toEqual(['OPERATION_ADAPTER_UNKNOWN']);
  expect(issues({ catalog: [], targets: [{ adapter: 'test.memory-record', options: { kind: 'x', extra: 1 } }] })).toEqual(['OPERATION_TARGET_OPTIONS_INVALID']);
  expect(issues({ catalog: [], targets: [{ adapter: 'test.memory-record', options: { kind: 'x' } }, { adapter: 'test.memory-record', options: { kind: 'x' } }] })).toEqual(['OPERATION_TARGET_DUPLICATE']);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, operations: config }));
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'registry', restrictions: [], grants: [
    { id: 'ops', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } }] }), { mode: 0o600 });
  const command = { schemaVersion: 1 as const, commandId: 'c1', scopeId: 's', operation: { id: 'post-memo', version: 1 }, target: { kind: 'memo', id: 'M-1' },
    idempotencyKey: 'k1', input: { note: 'hi' }, expectedVersion: null };
  const result = await executeConfiguredOperation(project, command, options);
  expect(result).toMatchObject({ status: 'settled', version: '"m1"', evidence: 'idempotency-record', target: { kind: 'memo', id: 'M-1' } });
  const target = targets.get('memo'); expect(target?.records.get('M-1')).toBe(1); expect(target?.writes).toHaveLength(1);
  // Registration is sealed once configuration is registered: a late module cannot change what a validated config means.
  expect(() => registerOperationAdapterModule(module(manifest({ id: 'test.late', namespace: 'late' }), 'late.x'))).toThrow(expect.objectContaining({ code: 'REGISTRY_SEALED' }));
});

it('refuses out-of-range Core API, namespace shadowing, duplicate id@version, operation redefinition (adds-only), unverified signatures and factory mismatch with typed codes', () => {
  const core = module(manifest({ id: 'core.records', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'records', version: 1 }],
    operations: [descriptor('records.post', 'records') as never] } }), 'records');
  const registry = AdapterRegistry.create([core]);
  const refuse = (registration: AdapterModuleRegistration, code: string) => expect(() => registry.register(registration)).toThrow(expect.objectContaining({ code }));
  refuse(module(manifest({}, { requires: { coreApi: { min: CORE_API_VERSION + 1, max: CORE_API_VERSION + 1 } } })), 'REGISTRY_CORE_API_UNSUPPORTED');
  refuse(module(manifest({}, { requires: { coreApi: { min: 0, max: CORE_API_VERSION } } })), 'REGISTRY_MANIFEST_INVALID');
  // Overlays never own the root: tier claims and null namespaces are data, not authority.
  refuse(module(manifest({ tier: 'core' })), 'REGISTRY_NAMESPACE_RESERVED');
  refuse(module(manifest({ namespace: null })), 'REGISTRY_NAMESPACE_RESERVED');
  // Shadowing a root (Core) adapter id or nesting over a registered namespace, in either direction.
  refuse(module(manifest({ id: 'shadow', namespace: 'records' }, { provides: { targetAdapters: [{ adapterId: 'records.x', version: 1 }], operations: [] } }), 'records.x'), 'REGISTRY_NAMESPACE_SHADOWED');
  refuse(module(manifest({}, { provides: { targetAdapters: [{ adapterId: 'other.memory-record', version: 1 }], operations: [] } }), 'other.memory-record'), 'REGISTRY_ID_OUTSIDE_NAMESPACE');
  refuse(module(manifest({}, { provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 1 }], operations: [descriptor('records.post', 'records') as never] } })), 'REGISTRY_ID_OUTSIDE_NAMESPACE');
  refuse(module(manifest({}, { signature: { algorithm: 'ed25519', keyId: 'k', digest: 'a'.repeat(64), value: 'AAAA' } })), 'REGISTRY_SIGNATURE_UNSUPPORTED');
  refuse({ manifest: manifest(), factories: {} }, 'REGISTRY_FACTORY_MISMATCH');
  registry.register(module());
  refuse(module(), 'REGISTRY_MODULE_DUPLICATE');
  refuse(module(manifest({ id: 'test.other' }, { provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 2 }], operations: [] } })), 'REGISTRY_NAMESPACE_SHADOWED');
  refuse(module(manifest({ id: 'test2.mod', namespace: 'test.inner' }, { provides: { targetAdapters: [{ adapterId: 'test.inner.a', version: 1 }], operations: [] } }), 'test.inner.a'), 'REGISTRY_NAMESPACE_SHADOWED');
  // A namespace that merely shares a prefix without a dot (`tes` vs `test`) is a different tree, not a shadow.
  registry.register(module(manifest({ id: 'tes', namespace: 'tes' }, { provides: { targetAdapters: [{ adapterId: 'tes.a', version: 1 }], operations: [] } }), 'tes.a'));
  expect(registry.manifests().map(m => m.module.id)).toEqual(['core.records', 'test.memory', 'tes']);
  expect(registry.adapter('records')).not.toBeNull(); expect(registry.adapter('test.memory-record')).not.toBeNull(); expect(registry.adapter('nope')).toBeNull();
  registry.seal();
  refuse(module(manifest({ id: 'sealed.m', namespace: 'sealed' }, { provides: { targetAdapters: [{ adapterId: 'sealed.a', version: 1 }], operations: [] } }), 'sealed.a'), 'REGISTRY_SEALED');
});

it('keeps the adds-only rule and duplicate id@version as distinct checks that fire independently of namespace ownership', () => {
  // Two construction-time (root) modules: only the duplicate module id@version and the operation redefinition can refuse them.
  const a = module(manifest({ id: 'core.a', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'a', version: 1 }], operations: [descriptor('post', 'a') as never] } }), 'a');
  const sameId = module(manifest({ id: 'core.a', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'b', version: 1 }], operations: [] } }), 'b');
  expect(() => AdapterRegistry.create([a, sameId])).toThrow(expect.objectContaining({ code: 'REGISTRY_MODULE_DUPLICATE' }));
  const redefines = module(manifest({ id: 'core.b', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'b', version: 1 }], operations: [descriptor('post', 'b') as never] } }), 'b');
  expect(() => AdapterRegistry.create([a, redefines])).toThrow(expect.objectContaining({ code: 'REGISTRY_OPERATION_REDEFINED' }));
  const sameAdapter = module(manifest({ id: 'core.c', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'a', version: 2 }], operations: [] } }), 'a');
  expect(() => AdapterRegistry.create([a, sameAdapter])).toThrow(expect.objectContaining({ code: 'REGISTRY_ADAPTER_DUPLICATE' }));
  // An overlay adding a new operation inside its own namespace is accepted; a second overlay cannot claim that namespace (one owner).
  const registry = AdapterRegistry.create([a]);
  registry.register(module(manifest({}, { provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 1 }], operations: [descriptor('test.post', 'memo') as never] } })));
  expect(() => registry.register(module(manifest({ id: 'test.again', version: '0.2.0' }, { provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 1 }],
    operations: [descriptor('test.post', 'memo') as never] } })))).toThrow(expect.objectContaining({ code: 'REGISTRY_NAMESPACE_SHADOWED' }));
  expect(adapterModuleManifestSchema.safeParse({ ...manifest(), schemaVersion: 2 }).success).toBe(false);
});

it('holds immutable snapshots once sealed: mutating a registrant factory or a returned manifest changes neither resolution nor the declared adapters (Astra 2126 R2)', () => {
  const identity = (label: string): EffectTarget => ({ kind: 'record', identity: () => label, observe: async () => ({ version: null }), apply: async () => ({ version: null }), lookup: async () => null });
  const factory = { optionsSchema, create: () => identity('original') };
  const registry = AdapterRegistry.create([{ manifest: manifest({ id: 'core.records', tier: 'core', namespace: null }, { provides: { targetAdapters: [{ adapterId: 'records', version: 1 }], operations: [] } }), factories: { records: factory } }]);
  const config = [{ adapter: 'records', options: { kind: 'record' } }];
  registry.seal();
  expect(registry.targets(config).resolve('record')?.identity()).toBe('original');
  factory.create = () => identity('replacement'); factory.optionsSchema = z.object({ kind: z.string(), extra: z.string() }).strict() as never;
  expect(registry.targets(config).resolve('record')?.identity()).toBe('original');
  const view = registry.adapter('records')!;
  expect(() => (view as { factory: { create: unknown } }).factory.create = () => identity('again')).toThrow();
  expect(() => (view.manifest.provides.targetAdapters as unknown[]).splice(0)).toThrow();
  expect(() => (view.manifest.provides.operations as unknown[]).push({})).toThrow();
  expect(() => ((view.manifest.module as { namespace: string | null }).namespace = 'x')).toThrow();
  expect(registry.manifests()[0]?.provides.targetAdapters).toHaveLength(1);
  expect(registry.adapter('records')?.factory.create({ kind: 'record' }).identity()).toBe('original');
  // The registrant's own manifest object stays theirs; the registry keeps its own validated copy.
  const own = manifest({ id: 'own.m', namespace: 'own' }, { provides: { targetAdapters: [{ adapterId: 'own.a', version: 1 }], operations: [] } });
  const open = AdapterRegistry.create([]); open.register({ manifest: own, factories: { 'own.a': factory } });
  (own.provides.targetAdapters as { adapterId: string }[]).push({ adapterId: 'own.b', version: 1 } as never);
  expect(open.manifests()[0]?.provides.targetAdapters.map(a => a.adapterId)).toEqual(['own.a']);
});
