import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { executeConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { main as cli } from '#surfaces/core/cli/index.js';
import { operationsConfigSchema, registerOperationAdapterModule, registerProviderConfig, HOST_SHELL_RUN_OPERATION, WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/index.js';
import { AdapterRegistry, EffectTargetError, type EffectTarget, type EffectApplyRequest, type AdapterModuleRegistration } from '#engine/index.js';
import { CORE_API_VERSION, unifyOperationCatalog, type AdapterModuleManifest, type EffectTargetRef } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });

/** In-test target registered through the registry (never through Core edits); records carry their own versions and idempotency records. */
class MemoryRecordTarget implements EffectTarget {
  readonly records = new Map<string, number>(); readonly applied = new Map<string, string>(); readonly writes: string[] = [];
  constructor(readonly kind: string) {}
  identity() { return `${this.kind}@memory`; }
  async observe(target: EffectTargetRef) { const version = this.records.get(target.id); return { version: version === undefined ? null : `"m${version}"` }; }
  async apply(request: EffectApplyRequest) {
    const current = this.records.get(request.target.id) ?? 0;
    if (request.expectedVersion !== null && request.expectedVersion !== `"m${current}"`) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    this.records.set(request.target.id, current + 1); this.writes.push(request.idempotencyKey); allWrites.push(request.idempotencyKey);
    const version = `"m${current + 1}"`; this.applied.set(request.idempotencyKey, version); return { version };
  }
  async lookup(_target: EffectTargetRef, key: string) { const version = this.applied.get(key); return version === undefined ? { status: 'absent' as const } : { status: 'applied' as const, version }; }
}
const targets = new Map<string, MemoryRecordTarget>();
/** Every write across target instances (a producer call builds its targets afresh from configuration; each instance starts empty). */
const allWrites: string[] = [];
const descriptor = (id: string, targetKind: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operation: { id, version: 1 }, targetKind,
  effectClass: 'write', approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 4096, ...extra });
/** The module ships its adapter and its own catalog: `test.post@1` (compensated by `test.cancel@1`) on the `memo` target kind. */
const manifest: AdapterModuleManifest = { schemaVersion: 1, module: { id: 'test.memo', version: '0.1.0', tier: 'enterprise', namespace: 'test' },
  requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
  provides: { targetAdapters: [{ adapterId: 'test.memory-record', version: 1 }],
    operations: [descriptor('test.post', 'memo', { compensation: { id: 'test.cancel', version: 1 } }), descriptor('test.cancel', 'memo')] as never[] }, signature: null };
const optionsSchema = z.object({ kind: z.string().min(1) }).strict();
const module: AdapterModuleRegistration = { manifest, factories: { 'test.memory-record': { optionsSchema,
  create: (options: unknown) => { const t = new MemoryRecordTarget(optionsSchema.parse(options).kind); targets.set(t.kind, t); return t; } } } };
const target = { adapter: 'test.memory-record', options: { kind: 'memo' } };
const issues = (value: unknown) => { const r = operationsConfigSchema.safeParse(value); return r.success ? [] : r.error.issues.map(i => i.message); };
// One process-wide registry per test file: the module registers before configuration registration seals it.
registerOperationAdapterModule(module);
registerProviderConfig();

async function project(operations: unknown, open = true) {
  const root = await mkdtemp(join(tmpdir(), 'dn-catalog-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'project'); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  await writeFile(join(dir, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, operations }));
  if (!open) return { dir, root, options };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'catalog', restrictions: [], grants: [
    { id: 'ops', effect: 'allow', actions: ['execute', 'compensate'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } }] }), { mode: 0o600 });
  return { dir, root, options };
}
const command = (commandId: string, operation: { id: string; version: number }, kind = 'memo') => ({ schemaVersion: 1 as const, commandId, scopeId: 's', operation,
  target: { kind, id: 'M-1' }, idempotencyKey: `k-${commandId}`, input: { note: 'hi' }, expectedVersion: null });

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] resolves a module-provided operation from the unified catalog: the same resolver serves the SDK and the product CLI, with an unchanged config shape', async () => {
  // Config declares only the target; the catalog entry comes from the module manifest (today: EFFECT_OPERATION_UNKNOWN).
  const p = await project({ catalog: [], targets: [target] });
  const sdk = await executeConfiguredOperation(p.dir, command('c1', { id: 'test.post', version: 1 }), p.options);
  expect(sdk).toMatchObject({ status: 'settled', version: '"m1"', evidence: 'idempotency-record', target: { kind: 'memo', id: 'M-1' } });
  expect(allWrites).toHaveLength(1); // the target sees a scoped wire key, never the caller's key (Astra 2041)
  // The product CLI (`deckent operation execute`) goes through the same composition entry, hence the same catalog.
  const input = join(p.root, 'c2.json'); await writeFile(input, JSON.stringify(command('c2', { id: 'test.post', version: 1 })));
  const lines: string[] = [];
  expect(await cli(['operation', 'execute', '--input', input, '--json'], { root: p.dir, env: p.options.env, initialize: registerProviderConfig,
    executeOperation: executeConfiguredOperation, stdout: { write: (text: string) => { lines.push(text); return true; } } })).toBe(0);
  expect(JSON.parse(lines.join(''))).toMatchObject({ status: 'settled', version: '"m1"', operation: { id: 'test.post', version: 1 }, target: { kind: 'memo', id: 'M-1' } });
  expect(allWrites).toHaveLength(2);
  // A config catalog entry still resolves exactly as before (byte-identical shape), next to the module's.
  const mixed = await project({ catalog: [descriptor('post-memo', 'memo')], targets: [target] });
  expect(await executeConfiguredOperation(mixed.dir, command('c3', { id: 'post-memo', version: 1 }), mixed.options)).toMatchObject({ status: 'settled', version: '"m1"' });
  expect(await executeConfiguredOperation(mixed.dir, command('c4', { id: 'test.post', version: 1 }), mixed.options)).toMatchObject({ status: 'settled', version: '"m1"' });
  expect(allWrites).toHaveLength(4);
});

it.skipIf(process.platform === 'win32')('requires POSIX private policy custody: refuses the same id@version from two sources (config vs module) with a typed config issue and never lets the config definition win', async () => {
  // Today the config schema accepts this and the config descriptor silently shadows the module's.
  expect(issues({ catalog: [descriptor('test.post', 'memo')], targets: [target] })).toEqual(['OPERATION_CATALOG_CONFLICT']);
  // A different version of a module operation is still inside the module's namespace: closed to config too (owner 2026-09-27
  // decision 7 — A04-2 design note §2.7(b)'s open question is resolved against the config catalog, not just against exact ids).
  expect(issues({ catalog: [{ ...descriptor('test.post', 'memo'), operation: { id: 'test.post', version: 2 } }], targets: [target] })).toEqual(['OPERATION_NAMESPACE_RESERVED']);
  // Loading such a configuration is the typed section refusal; nothing reaches the ledger or the target.
  const p = await project({ catalog: [descriptor('test.post', 'memo', { inputMaxBytes: 1 })], targets: [target] }, false);
  const before = allWrites.length;
  await expect(executeConfiguredOperation(p.dir, command('x', { id: 'test.post', version: 1 }), p.options)).rejects.toMatchObject({ code: 'CONFIG_VALIDATION', issues: [{ path: 'operations', reason: 'OPERATIONS_INVALID' }] });
  expect(allWrites).toHaveLength(before);
});

it.skipIf(process.platform === 'win32')('requires POSIX private policy custody: closes a registered module\'s namespace to new config ids it never declared itself, through the real config validation and execution path (owner 2026-09-27 decision 7)', async () => {
  // `test.other` and `test.sub.y` are new ids under the already-registered `test.memo` module's namespace (`test`); the module never
  // declared either itself, so today (before decision 7) neither the exact-id checks nor the plain conflict check would catch them.
  expect(issues({ catalog: [descriptor('test.other', 'memo')], targets: [target] })).toEqual(['OPERATION_NAMESPACE_RESERVED']);
  expect(issues({ catalog: [descriptor('test.sub.y', 'memo')], targets: [target] })).toEqual(['OPERATION_NAMESPACE_RESERVED']);
  // A sibling id outside any registered namespace is unaffected (the namespace closes only itself and below, never anything above it).
  expect(issues({ catalog: [descriptor('outside.other', 'memo')], targets: [target] })).toEqual([]);
  // Loading such a configuration is the typed section refusal; nothing reaches the ledger or the target.
  const p = await project({ catalog: [descriptor('test.other', 'memo')], targets: [target] }, false);
  const before = allWrites.length;
  await expect(executeConfiguredOperation(p.dir, command('ns', { id: 'test.other', version: 1 }), p.options))
    .rejects.toMatchObject({ code: 'CONFIG_VALIDATION', issues: [{ path: 'operations', reason: 'OPERATIONS_INVALID' }] });
  expect(allWrites).toHaveLength(before);
});

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] protects Core code operations: config may not redefine a Core id at any version nor claim a Core target kind; Core descriptors resolve as Core', async () => {
  const core = (id: string, version: number, targetKind = 'memo') => ({ ...descriptor(id, targetKind), operation: { id, version } });
  // Same version and a new version are both refused: the id belongs to Core, not to the installation's config.
  expect(issues({ catalog: [core('workspace.file.write', 1)], targets: [target] })).toEqual(['OPERATION_CORE_REDEFINED']);
  expect(issues({ catalog: [core('host.shell.run', 2)], targets: [target] })).toEqual(['OPERATION_CORE_REDEFINED']);
  // A config target cannot name a Core code target kind (it would route Core operations to a foreign target).
  expect(issues({ catalog: [], targets: [{ adapter: 'test.memory-record', options: { kind: 'host-shell' } }] })).toEqual(['OPERATION_TARGET_KIND_RESERVED']);
  expect(issues({ catalog: [], targets: [{ adapter: 'test.memory-record', options: { kind: 'workspace-file' } }] })).toEqual(['OPERATION_TARGET_KIND_RESERVED']);
  // Core descriptors are in the same catalog the CLI/SDK resolve from; without a configured target of their kind the execution is the
  // existing typed refusal, never a write to another target.
  const p = await project({ catalog: [], targets: [target] });
  const before = allWrites.length;
  await expect(executeConfiguredOperation(p.dir, command('h', HOST_SHELL_RUN_OPERATION.operation, 'host-shell'), p.options)).rejects.toMatchObject({ code: 'EFFECT_OPERATION_UNKNOWN' });
  await expect(executeConfiguredOperation(p.dir, command('w', WORKSPACE_FILE_WRITE_OPERATION.operation, 'memo'), p.options)).rejects.toMatchObject({ code: 'EFFECT_OPERATION_UNKNOWN' });
  expect(allWrites).toHaveLength(before);
});

it('unifies with provenance from the registry\'s own admission record: root modules are Core even when namespaced, check order is fixed, and new root ids close their namespaces to overlays', async () => {
  const core = (id: string, namespace: string | null, operations: unknown[], targetAdapters: { adapterId: string; version: number }[] = []): AdapterModuleRegistration => ({
    manifest: { schemaVersion: 1, module: { id, version: '1', tier: 'core', namespace }, requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
      provides: { targetAdapters, operations: operations as never[] }, signature: null }, factories: {} });
  const registry = AdapterRegistry.create([core('core.shell', null, [descriptor('host.shell.run', 'host-shell')]), core('core.ns', 'corens', [descriptor('corens.op', 'ns-kind')])]);
  registry.register(module);
  expect(registry.operations().map(entry => [entry.provenance, entry.descriptor.operation.id])).toEqual([
    [{ source: 'core', module: 'core.shell@1' }, 'host.shell.run'], [{ source: 'core', module: 'core.ns@1' }, 'corens.op'],
    [{ source: 'module', module: 'test.memo@0.1.0' }, 'test.post'], [{ source: 'module', module: 'test.memo@0.1.0' }, 'test.cancel']]);
  // These refusal-order checks are unaffected by namespace closure (every case here is caught earlier in the check order; none of
  // these ids fall under `test` or `corens`), so the low-level calls below pass no namespaces — namespace closure itself is
  // exercised by the dedicated test below, through `registry.catalog(...)` which computes it automatically.
  const refuse = (catalog: unknown[], kinds: string[], code: string, subject: string) =>
    expect(() => unifyOperationCatalog(registry.operations(), catalog as never[], kinds, [])).toThrow(expect.objectContaining({ code, subject }));
  // A namespaced root module is still Core: its target kind and id are reserved against config.
  refuse([], ['memo', 'ns-kind'], 'OPERATION_TARGET_KIND_RESERVED', 'ns-kind');
  refuse([{ ...descriptor('corens.op', 'memo'), operation: { id: 'corens.op', version: 3 } }], ['memo'], 'OPERATION_CORE_REDEFINED', 'corens.op@3');
  // Order: a reserved kind wins over a Core redefinition, which wins over a plain conflict; a config-only duplicate is a conflict too.
  refuse([descriptor('host.shell.run', 'memo'), descriptor('test.post', 'memo')], ['host-shell'], 'OPERATION_TARGET_KIND_RESERVED', 'host-shell');
  refuse([descriptor('test.post', 'memo'), descriptor('host.shell.run', 'memo')], ['memo'], 'OPERATION_CORE_REDEFINED', 'host.shell.run@1');
  refuse([descriptor('test.post', 'memo')], ['memo'], 'OPERATION_CATALOG_CONFLICT', 'test.post@1');
  refuse([descriptor('mine', 'memo'), descriptor('mine', 'memo')], ['memo'], 'OPERATION_CATALOG_CONFLICT', 'mine@1');
  // A module operation whose compensation is nowhere in the unified catalog is refused (config compensations were checked by config already).
  const dangling = AdapterRegistry.create([core('core.x', 'cx', [descriptor('cx.do', 'k', { compensation: { id: 'cx.undo', version: 1 } })])]);
  expect(() => unifyOperationCatalog(dangling.operations(), [], [], [])).toThrow(expect.objectContaining({ code: 'OPERATION_COMPENSATION_UNKNOWN', subject: 'cx.do@1' }));
  // The unified catalog resolves every source through one port; unknown refs are null.
  const catalog = registry.catalog([descriptor('mine', 'memo')], ['memo']);
  expect(catalog.entries().map(entry => `${entry.provenance.source}:${entry.descriptor.operation.id}`)).toEqual(['core:host.shell.run', 'core:corens.op', 'module:test.post', 'module:test.cancel', 'config:mine']);
  expect(await catalog.resolve({ id: 'test.cancel', version: 1 })).toEqual(descriptor('test.cancel', 'memo'));
  expect(await catalog.resolve({ id: 'mine', version: 1 })).toEqual(descriptor('mine', 'memo'));
  expect(await catalog.resolve({ id: 'mine', version: 2 })).toBeNull();
  // Core code ids in the process registry close `workspace`, `workspace.file` and `host` to overlays (one owner per namespace tree).
  const overlay = (namespace: string, adapterId: string): AdapterModuleRegistration => ({ manifest: { ...manifest, module: { ...manifest.module, id: `${namespace}.mod`, namespace },
    provides: { targetAdapters: [{ adapterId, version: 1 }], operations: [] } }, factories: { [adapterId]: module.factories['test.memory-record']! } });
  for (const namespace of ['workspace', 'workspace.file', 'host']) {
    expect(() => registerOperationAdapterModule(overlay(namespace, `${namespace}.a`))).toThrow(expect.objectContaining({ code: 'REGISTRY_SEALED' }));
    expect(() => AdapterRegistry.create([coreLike()]).register(overlay(namespace, `${namespace}.a`))).toThrow(expect.objectContaining({ code: 'REGISTRY_NAMESPACE_SHADOWED' }));
  }
  function coreLike() { return core('core.ops', null, [descriptor('workspace.file.write', 'workspace-file'), descriptor('host.shell.run', 'host-shell')]); }
});

it('closes a registered module\'s namespace, and everything under it, to the config catalog even for ids the module never declared; the namespace itself grants nothing without a registered module (owner 2026-09-27 decision 7)', () => {
  const acmeModule: AdapterModuleRegistration = { manifest: { schemaVersion: 1, module: { id: 'acme.mod', version: '1', tier: 'enterprise', namespace: 'acme' },
    requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } }, provides: { targetAdapters: [], operations: [] }, signature: null }, factories: {} };
  const withModule = AdapterRegistry.create([acmeModule]);
  const refuse = (id: string) => expect(() => withModule.catalog([descriptor(id, 'memo')], ['memo']))
    .toThrow(expect.objectContaining({ code: 'OPERATION_NAMESPACE_RESERVED', subject: `${id}@1` }));
  refuse('acme.x'); // a new id directly under the namespace; `acme.mod` never declared it
  refuse('acme.sub.y'); // and below: a nested sub-namespace is territory too
  // Without any module registered for `acme`, the identical config resolves normally: the namespace itself grants nothing to close.
  const withoutModule = AdapterRegistry.create([]);
  const openCatalog = withoutModule.catalog([descriptor('acme.x', 'memo'), descriptor('acme.sub.y', 'memo')], ['memo']);
  expect(openCatalog.entries().map(entry => entry.descriptor.operation.id).sort()).toEqual(['acme.sub.y', 'acme.x']);
});
