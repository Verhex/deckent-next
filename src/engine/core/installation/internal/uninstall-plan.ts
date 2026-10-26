import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, parse, sep } from 'node:path';
import { z } from 'zod';
import { operationDescriptorSchema, type OperationDescriptor } from '#domain/index.js';
import data from './uninstall-resources.json' with { type: 'json' };
import { UninstallError, uninstallInstallationSchema, uninstallPlanQuerySchema, uninstallResourceSchema,
  type UninstallPlan, type UninstallResource, type UninstallItem, type UninstallInstallation } from './uninstall-contract.js';
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const contribution = z.object({ id, owner: id, kind: z.enum(['service', 'image', 'path']), disposable: z.boolean(), operation: id, targetKind: id, after: z.array(id) }).strict();
export type UninstallContribution = z.infer<typeof contribution>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const within = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
/** Contributions are sealed once; an extension cannot replace a Core owner's retention policy. */
export function uninstallRegistry(extensions: readonly UninstallContribution[] = []) {
  const base = z.object({ schemaVersion: z.literal(1), inputMaxBytes: z.number().int().positive().safe(), contributions: z.array(contribution) }).strict().parse(data);
  const entries = [...base.contributions, ...extensions.map(value => contribution.parse(value))].sort((a, b) => compare(a.id, b.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id) || (!base.contributions.some(item => item.id === entry.id) && !entry.id.startsWith(`${entry.owner}.`))) throw new UninstallError('UNINSTALL_INVALID');
    ids.add(entry.id);
  }
  const visit = (entry: UninstallContribution, seen: Set<string>) => {
    if (seen.has(entry.id)) throw new UninstallError('UNINSTALL_INVALID');
    for (const dependency of entry.after) {
      const found = entries.find(item => item.id === dependency);
      if (!found) throw new UninstallError('UNINSTALL_INVALID');
      visit(found, new Set([...seen, entry.id]));
    }
  };
  entries.forEach(entry => visit(entry, new Set()));
  return Object.freeze({ entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry, after: Object.freeze(entry.after) }))), inputMaxBytes: base.inputMaxBytes, digest: hash({ entries, inputMaxBytes: base.inputMaxBytes }) });
}
export interface UninstallInventory {
  readonly installation: UninstallInstallation; readonly scopeSummary: readonly string[];
  readonly layoutRevision: string; readonly policyRevision: string; readonly inventoryRevision: string;
  readonly resources: readonly UninstallResource[]; readonly blockers: readonly string[];
  readonly protectedPaths: readonly string[]; readonly deletionRoots: readonly string[];
  readonly backupDestination: string | null; readonly packageRemoval: UninstallPlan['packageRemoval'];
}
/** Pure plan over owner observations. No healing, filesystem writes, service starts or identity creation. */
export function createUninstallPlan(query: unknown, inventory: UninstallInventory, registry = uninstallRegistry()): UninstallPlan {
  const { purge } = uninstallPlanQuerySchema.parse(query), installation = uninstallInstallationSchema.parse(inventory.installation);
  const resources = inventory.resources.map(value => uninstallResourceSchema.parse(value)).sort((a, b) => compare(a.resourceId, b.resourceId));
  if (new Set(resources.map(value => value.resourceId)).size !== resources.length) throw new UninstallError('UNINSTALL_INVALID');
  const blockers = [...inventory.blockers];
  const items: UninstallItem[] = resources.map(resource => {
    const entry = registry.entries.find(item => item.id === resource.contribution);
    if (!entry) throw new UninstallError('UNINSTALL_INVALID');
    let action: UninstallItem['action'] = 'keep'; let reason: string;
    if (resource.present === false) reason = 'absent';
    else if (resource.protected) reason = 'protected';
    else if (resource.ownership !== 'exclusive' || !resource.ownershipEvidence || resource.owner !== installation.id) reason = 'ownership';
    else if (!entry.disposable && !purge) reason = 'durable';
    else if (resource.backup === 'protected-session' || resource.backup === 'non-exportable') reason = resource.backup;
    else if (resource.present === null || resource.version === null) { action = 'blocked'; reason = 'observation-unknown'; }
    else if (!resource.capability) { action = 'manual'; reason = 'unsupported'; }
    else if (purge && !entry.disposable && resource.backup !== 'covered') { action = 'blocked'; reason = 'backup-coverage'; }
    else { action = 'remove'; reason = 'owned'; }
    if (action === 'remove' && entry.kind === 'path') {
      const path = resolve(resource.locator);
      if (!isAbsolute(resource.locator) || path === parse(path).root || !inventory.deletionRoots.some(root => within(root, path) && root !== path)
        || inventory.protectedPaths.some(kept => within(path, kept) || within(kept, path))) { action = 'blocked'; reason = 'unsafe-path'; }
    }
    if (entry.kind === 'service' && resource.present !== false && action === 'keep') reason = 'service-unresolved';
    if (action === 'blocked' || action === 'manual' || (purge && resource.present !== false && action === 'keep' && resource.owner === installation.id)) blockers.push(`${resource.resourceId}:${reason}`);
    return { ...resource, action, reason, operation: { id: entry.operation, version: 1 },
      dependencies: resources.filter(item => entry.after.includes(item.contribution)).map(item => item.resourceId) };
  });
  // An ancestor/descendant pair cannot be removed while either is retained; relocated roots get the same guard.
  for (const item of items.filter(item => item.action === 'remove')) {
    const entry = registry.entries.find(entry => entry.id === item.contribution)!;
    if (entry.kind === 'path' && items.some(kept => kept.action !== 'remove' && kept.present !== false
      && registry.entries.find(entry => entry.id === kept.contribution)!.kind === 'path'
      && (within(item.locator, kept.locator) || within(kept.locator, item.locator)))) {
      Object.assign(item, { action: 'blocked', reason: 'retained-overlap' }); blockers.push(`${item.resourceId}:retained-overlap`);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items.filter(item => item.action === 'remove')) {
      if (items.some(dependency => item.dependencies.includes(dependency.resourceId) && (dependency.action === 'blocked' || dependency.action === 'manual' || (dependency.contribution === 'service' && dependency.present !== false && dependency.action === 'keep')))) {
        Object.assign(item, { action: 'blocked', reason: 'dependency-unresolved' }); blockers.push(`${item.resourceId}:dependency-unresolved`); changed = true;
      }
    }
  }
  if (purge && (!inventory.backupDestination || !isAbsolute(inventory.backupDestination)
    || inventory.deletionRoots.some(root => within(root, inventory.backupDestination!)))) blockers.push('backup-destination');
  const body = { schemaVersion: 1 as const, installation, purge, scopeSummary: [...inventory.scopeSummary].sort(),
    layoutRevision: inventory.layoutRevision, policyRevision: inventory.policyRevision, inventoryRevision: inventory.inventoryRevision,
    registryDigest: registry.digest, items, blockers: [...new Set(blockers)].sort(),
    backup: { required: purge, destination: inventory.backupDestination }, packageRemoval: { ...inventory.packageRemoval }, canApply: false as const };
  return freeze(JSON.parse(JSON.stringify({ ...body, planDigest: hash(body) })) as UninstallPlan);
}
export function assertUninstallPlanCurrent(approved: UninstallPlan, current: UninstallPlan) {
  if (approved.planDigest !== current.planDigest) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
}

/** Catalog proposals only: composition still owes non-delegable person admission and the durable approval broker. */
export function uninstallOperationDescriptors(registry = uninstallRegistry()): readonly OperationDescriptor[] {
  const operations = new Map<string, OperationDescriptor>();
  for (const entry of registry.entries) {
    const descriptor = operationDescriptorSchema.parse({ schemaVersion: 1, operation: { id: entry.operation, version: 1 }, targetKind: entry.targetKind,
      effectClass: 'irreversible', approval: 'required', precondition: 'record-version', compensation: null, inputMaxBytes: registry.inputMaxBytes, surface: 'authority' });
    const existing = operations.get(entry.operation);
    if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new UninstallError('UNINSTALL_INVALID');
    operations.set(entry.operation, descriptor);
  }
  return freeze([...operations.values()]);
}
