import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, parse, sep } from 'node:path';
import { z } from 'zod';
import { operationDescriptorSchema, type OperationDescriptor } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import data from './uninstall-resources.json' with { type: 'json' };
import { UninstallError, UNINSTALL_TIERS, uninstallInstallationSchema, uninstallPlanQuerySchema, uninstallResourceSchema, uninstallWorkSchema, uninstallServiceSchema,
  type UninstallPlan, type UninstallResource, type UninstallItem, type UninstallInstallation, type UninstallTier, type UninstallWork, type UninstallService } from './uninstall-contract.js';
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const contribution = z.object({ id, owner: id, kind: z.enum(['service', 'image', 'path']), disposable: z.boolean(), operation: id, targetKind: id, after: z.array(id) }).strict();
export type UninstallContribution = z.infer<typeof contribution>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const within = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
/** Contributions are sealed once; an extension cannot replace a Core owner's retention policy. */
export function uninstallRegistry(extensions: readonly UninstallContribution[] = []) {
  const base = z.object({ schemaVersion: z.literal(1), inputMaxBytes: z.number().int().positive().safe(), waitPollMs: z.number().int().positive().safe(), contributions: z.array(contribution) }).strict().parse(data);
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
  return Object.freeze({ entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry, after: Object.freeze(entry.after) }))), inputMaxBytes: base.inputMaxBytes, waitPollMs: base.waitPollMs, digest: hash({ entries, inputMaxBytes: base.inputMaxBytes }) });
}
export interface UninstallInventory {
  readonly installation: UninstallInstallation; readonly scopeSummary: readonly string[];
  readonly layoutRevision: string; readonly policyRevision: string; readonly inventoryRevision: string;
  readonly resources: readonly UninstallResource[]; readonly blockers: readonly string[];
  /** Refusals that stop only the data-deleting tier (a relocated or unsafe authority file, unreadable VCS state). */
  readonly dataBlockers: readonly string[];
  readonly protectedPaths: readonly string[]; readonly deletionRoots: readonly string[];
  readonly backupDestination: string | null; readonly packageRemoval: UninstallPlan['packageRemoval'];
  readonly work: UninstallWork; readonly service: UninstallService;
  /** Scopes a policy restriction names (company control): an unreconciled item there blocks data deletion even with force. */
  readonly managedScopes: readonly string[];
  /** The current principal's `installation/purge` refusal code, so the menu shows the data tiers as not possible before any card. */
  readonly policyBlocker?: string | null;
}
type Query = { readonly tier: UninstallTier; readonly force: boolean; readonly disableUnit: boolean };
/** Item actions and blockers of one tier over one observation; pure. */
function decide({ tier, force, disableUnit }: Query, installation: UninstallInstallation, resources: readonly UninstallResource[], inventory: UninstallInventory,
  registry: ReturnType<typeof uninstallRegistry>) {
  const purge = tier === 'all', blockers = [...inventory.blockers, ...(purge ? inventory.dataBlockers : []), ...(tier !== 'keep-data' && inventory.policyBlocker ? [`policy:${inventory.policyBlocker}`] : [])];
  const items: UninstallItem[] = resources.map(resource => {
    const entry = registry.entries.find(item => item.id === resource.contribution);
    if (!entry) throw new UninstallError('UNINSTALL_INVALID');
    let action: UninstallItem['action'] = 'keep'; let reason: string;
    if (resource.present === false) reason = 'absent';
    else if (resource.keep) reason = resource.keep;
    else if (resource.protected) reason = 'protected';
    else if (resource.ownership !== 'exclusive' || !resource.ownershipEvidence || resource.owner !== installation.id) reason = 'ownership';
    else if (!entry.disposable && !purge) reason = 'durable';
    else if (resource.backup === 'protected-session' || resource.backup === 'non-exportable') reason = resource.backup;
    else if (resource.present === null || resource.version === null) { action = 'blocked'; reason = 'observation-unknown'; }
    else if (!resource.capability) { action = 'manual'; reason = 'unsupported'; }
    else if (purge && !entry.disposable && resource.backup !== 'covered') { action = 'blocked'; reason = 'backup-coverage'; }
    else { action = 'remove'; reason = 'owned'; }
    if (action === 'remove' && entry.kind === 'path') {
      if ((resource.members ?? [resource.locator]).some(locator => {
        const path = resolve(locator);
        return !isAbsolute(locator) || path === parse(path).root || !inventory.deletionRoots.some(root => within(root, path) && root !== path)
          || inventory.protectedPaths.some(kept => within(path, kept) || within(kept, path));
      })) { action = 'blocked'; reason = 'unsafe-path'; }
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
      && (item.members ?? [item.locator]).some(path => (kept.members ?? [kept.locator]).some(other => within(path, other) || within(other, path))))) {
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
    || inventory.deletionRoots.some(root => within(root, inventory.backupDestination!) || within(inventory.backupDestination!, root)))) blockers.push('backup-destination');
  // Work and service are checked before any card (owner 2026-10-27): a running service is stopped, never reported as work.
  const work = inventory.work, service = inventory.service;
  if (!work.complete) blockers.push('work-unverified');
  if (work.running.length && !force) blockers.push('work-active');
  if (purge && (work.parked.length || work.approvals.length) && !force) blockers.push('work-pending');
  if (purge && work.deliveries.length) blockers.push('delivery-queued');
  if (purge && work.uncertain.length) {
    if (!force) blockers.push('uncertain-effects');
    else if (work.uncertain.some(item => inventory.managedScopes.includes(item.scopeId))) blockers.push('uncertain-managed');
  }
  const unit = service.running && service.unit !== null;
  if (unit && !(disableUnit && service.unitDisable === 'eligible')) blockers.push('service-managed');
  const steps = { stopService: service.running, disableUnit: unit && disableUnit && service.unitDisable === 'eligible',
    cancelRuns: force ? [...work.running, ...(purge ? work.parked : [])] : [], rejectApprovals: force && purge ? [...work.approvals] : [] };
  return { items, blockers: [...new Set(blockers)].sort(), steps };
}
/** Pure plan over owner observations. No healing, filesystem writes, service starts or identity creation. */
export function createUninstallPlan(query: unknown, inventory: UninstallInventory, registry = uninstallRegistry()): UninstallPlan {
  const { tier, force, disableUnit } = uninstallPlanQuerySchema.parse(query), installation = uninstallInstallationSchema.parse(inventory.installation);
  const resources = inventory.resources.map(value => uninstallResourceSchema.parse(value)).sort((a, b) => compare(a.resourceId, b.resourceId));
  if (new Set(resources.map(value => value.resourceId)).size !== resources.length) throw new UninstallError('UNINSTALL_INVALID');
  const work = uninstallWorkSchema.parse(inventory.work), service = uninstallServiceSchema.parse(inventory.service);
  const observed = { ...inventory, work, service };
  const { items, blockers, steps } = decide({ tier, force, disableUnit }, installation, resources, observed, registry);
  const tiers = Object.fromEntries(UNINSTALL_TIERS.map(other => { const plan = decide({ tier: other, force, disableUnit }, installation, resources, observed, registry);
    return [other, { removes: plan.items.filter(item => item.action === 'remove').length, blocker: plan.blockers[0] ?? null }]; })) as UninstallPlan['tiers'];
  const nothingToRemove = !items.some(item => item.action === 'remove') && !steps.stopService && !steps.disableUnit && !steps.cancelRuns.length && !steps.rejectApprovals.length;
  const body = { schemaVersion: 2 as const, installation, tier, force, disableUnit, purge: tier === 'all', scopeSummary: [...inventory.scopeSummary].sort(),
    layoutRevision: inventory.layoutRevision, policyRevision: inventory.policyRevision, inventoryRevision: inventory.inventoryRevision,
    registryDigest: registry.digest, items, blockers, work, service, steps, nothingToRemove, tiers,
    backup: { required: tier === 'all', destination: inventory.backupDestination }, packageRemoval: { ...inventory.packageRemoval }, canApply: false as const };
  return freeze(JSON.parse(JSON.stringify({ ...body, planDigest: hash(body) })) as UninstallPlan);
}
const BLOCKER_ERRORS: Readonly<Record<string, string>> = { 'work-active': 'UNINSTALL_WORK_ACTIVE', 'work-pending': 'UNINSTALL_WORK_ACTIVE', 'delivery-queued': 'UNINSTALL_DELIVERY_QUEUED',
  'uncertain-effects': 'UNINSTALL_UNCERTAIN_EFFECTS', 'uncertain-managed': 'UNINSTALL_UNCERTAIN_MANAGED', 'service-managed': 'UNINSTALL_SERVICE_RUNNING',
  'work-unverified': 'UNINSTALL_SCOPE_UNVERIFIED', 'backup-destination': 'UNINSTALL_BACKUP_COVERAGE' };
/** The typed refusal of a plan's first blocker, with the counts and next step its message names; null when the plan has none. */
export function uninstallBlockerError(plan: Pick<UninstallPlan, 'blockers' | 'work' | 'service' | 'purge' | 'installation'>) {
  const authority = plan.blockers.find(value => /^(authority-(relocated|unsafe)|vcs-unavailable):/u.test(value));
  if (authority) return ErrorRegistry.createError(authority.startsWith('vcs-') ? 'UNINSTALL_VCS_UNVERIFIED' : 'UNINSTALL_AUTHORITY_UNVERIFIED',
    { params: { path: authority.slice(authority.indexOf(':') + 1) } });
  const known = plan.blockers.find(value => BLOCKER_ERRORS[value]), work = plan.work;
  if (known) return ErrorRegistry.createError(BLOCKER_ERRORS[known]! as 'UNINSTALL_WORK_ACTIVE', { params: { runs: String(work.running.length + (plan.purge ? work.parked.length : 0)),
    approvals: String(plan.purge ? work.approvals.length : 0), count: String(known === 'delivery-queued' ? work.deliveries.length : work.uncertain.length),
    list: work.uncertain.slice(0, 5).map(item => `${item.kind} ${item.id}`).join(', '), owner: work.uncertain.find(item => item.scopeId)?.scopeId ?? '',
    unit: plan.service.unit ?? '', command: plan.service.command ?? '', path: plan.installation.root } });
  return plan.blockers.length ? ErrorRegistry.createError(plan.purge ? 'UNINSTALL_BACKUP_COVERAGE' : 'UNINSTALL_OWNERSHIP') : null;
}
export function assertUninstallPlanCurrent(approved: UninstallPlan, current: UninstallPlan) {
  if (approved.planDigest !== current.planDigest) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
}
/** E(D0) (JOURNEY §6.3): after force and the service stop the fresh plan of the same query may differ from the confirmed one only by versions,
 * by work force finished and by uncertain items the confirmation already named. Anything else is returned as a difference: stop, delete nothing. */
export function uninstallPlanDrift(approved: UninstallPlan, current: UninstallPlan): readonly string[] {
  // A resource the confirmation removes may already be gone (a replay, or removed meanwhile); any other change of the resource list is drift.
  const named = new Set(approved.work.uncertain.map(item => `${item.kind}:${item.id}`)), same = current.items.length === approved.items.length && current.items.every(item => {
    const was = approved.items.find(other => other.resourceId === item.resourceId); return !!was && (was.action === item.action || was.action === 'remove' && item.present === false); });
  return [...current.blockers.map(value => `blocker:${value}`), ...current.work.running.map(item => `running:${item.id}`),
    ...(current.purge ? [...current.work.parked, ...current.work.approvals].map(item => `pending:${item.id}`) : []),
    ...current.work.uncertain.filter(item => !named.has(`${item.kind}:${item.id}`)).map(item => `uncertain:${item.kind}:${item.id}`),
    ...(!same || current.installation.id !== approved.installation.id || current.policyRevision !== approved.policyRevision
      || current.layoutRevision !== approved.layoutRevision ? ['resources'] : []), ...(current.service.running ? ['service-running'] : [])];
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
