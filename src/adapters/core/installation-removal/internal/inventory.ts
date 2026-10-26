import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { productResourcePath, PRODUCT_LAYOUT_REGISTRY, sha256, ErrorRegistry, type ResolvedConfig, type IntegrityAuthority, type ProductResource } from '#platform/index.js';
import type { UninstallInventory } from '#engine/index.js';
import { InstallationDataRemovalTarget, memberStat, type DataRemovalMember } from './data.js';
import { NativeServiceRemovalDriver, nativeServiceExec, readNativeServiceRecord } from './native-service.js';
import { InstallationServiceRemovalTarget } from './service.js';
import paths from './paths.json' with { type: 'json' };
import { BACKUP_RESOURCES } from '#adapters/core/backup-store/index.js';
// Purge members are exactly the files the standard backup set restores (`deckent backup restore`); every other resource is kept.
const restorable = [...BACKUP_RESOURCES, 'ledger', 'approvals'] as readonly string[];
export const removalRegistry = z.object({ schemaVersion: z.literal(2), initialBackupPrefix: z.string(), finalBackupPrefix: z.string(), recoveryDirectory: z.string(),
  purgeMembers: z.record(z.string()).refine(value => Object.keys(value).every(name => restorable.includes(name))),
  cacheMembers: z.record(z.array(z.string()).min(1)), sharedSecretFiles: z.array(z.string()) }).strict().parse(paths);
const registry = removalRegistry;
const inside = (root: string, path: string) => { const child = relative(root, path); return !child || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
export function assertNativeUninstallSupport(platform: string) {
  if (platform !== 'linux') throw ErrorRegistry.createError('UNINSTALL_NATIVE_UNSUPPORTED', { params: { platform } });
}
export const uninstallRecoveryDirectory = (root: string) => join(dirname(root), registry.recoveryDirectory, sha256(root));
/** Native records and portable canonical layout resources are owner observations, never paths supplied by an uninstall request. */
export async function extendUninstallInventory(config: ResolvedConfig, base: UninstallInventory, purge: boolean,
  integrity: IntegrityAuthority | null, env: Readonly<Record<string, string | undefined>>) {
  const layout = config.productLayout, installationId = base.installation.id, resources = [...base.resources];
  const bounds = config.installation.packageMeasurement, targets = [];
  // The runtime's logical identity is not an OS service artifact. The native installer must retain an authenticated unit record.
  const recorded = integrity && await readNativeServiceRecord(productResourcePath(layout, 'installationIdentity'), installationId, integrity, config.installation.profileMaxBytes);
  const old = resources.findIndex(item => item.resourceId === 'recorded-service');
  if (old >= 0) resources.splice(old, 1);
  if (!recorded && config.service.identity) resources.push({ resourceId: 'unrecorded-service', contribution: 'durable', locator: config.service.identity.serviceId,
    version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing' });
  if (recorded) {
    const driver = new NativeServiceRemovalDriver(recorded, nativeServiceExec(config.installation.identityProbe, env), (_service, work) => work(), bounds.maxFileBytes);
    const target = new InstallationServiceRemovalTarget([driver.service], driver), observed = await driver.inspect(driver.service);
    const safe = observed.ownershipDigest === driver.service.ownershipDigest && observed.present !== null && !observed.also.length && !observed.triggers.length && !observed.foreignArtifacts && !observed.callerInService;
    resources.push({ resourceId: driver.service.resourceId, contribution: 'service', locator: driver.service.unit, version: (await target.observe({ kind: target.kind, id: driver.service.resourceId })).version,
      owner: safe ? installationId : null, ownership: safe ? 'exclusive' : 'unknown', ownershipEvidence: safe ? driver.service.ownershipDigest : null,
      present: observed.present, protected: !safe, capability: safe, backup: 'missing' });
    targets.push(target);
  }
  const isGlobal = base.deletionRoots.includes(layout.root), projectData = join(config.projectRoot, PRODUCT_LAYOUT_REGISTRY.rootName);
  // The installation's authority files are one atomic set: a relocated, unsafe or foreign member keeps all of them.
  let members: DataRemovalMember[] = [];
  if (purge && isGlobal && layout.root !== projectData) {
    try {
      for (const [name, file] of Object.entries(registry.purgeMembers) as [ProductResource, string][]) {
        const resourcePath = productResourcePath(layout, name), path = file ? join(resourcePath, file.replace('{keyFile}', config.approvals.keyFile)) : resourcePath;
        if (layout.resources[name] !== PRODUCT_LAYOUT_REGISTRY.resources[name] || !inside(layout.root, path) || inside(projectData, path)) throw new Error('relocated');
        if (await memberStat(path)) members.push({ resourceId: name, path, directory: file ? resourcePath : null });
      }
    } catch { members = []; }
  }
  const owners = new Set(members.map(member => member.resourceId)), retained = resources.filter(item => !owners.has(item.resourceId));
  // Anything else in a member's directory has no recorded owner here: kept and reported, never deleted with the directory.
  for (const directory of new Set(members.flatMap(member => member.directory ? [member.directory] : []))) {
    for (const name of (await readdir(directory)).slice(0, bounds.maxFiles).sort()) {
      const locator = join(directory, name);
      if (!members.some(member => member.path === locator)) retained.push({ resourceId: `unlisted.${sha256(locator)}`, contribution: 'durable', locator, version: null,
        owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: false, capability: false, backup: 'missing' });
    }
  }
  const memberResources = new Set(members.map(member => productResourcePath(layout, member.resourceId as ProductResource)));
  const protectedPaths = base.protectedPaths.filter(path => !memberResources.has(path));
  const target = new InstallationDataRemovalTarget(sha256(JSON.stringify([installationId, layout.root])), members, protectedPaths);
  if (members.length) {
    const version = (await target.observe({ kind: target.kind, id: 'global-data' })).version;
    retained.push({ resourceId: 'global-data', contribution: 'durable', locator: layout.root, members: members.map(member => member.path), version, owner: installationId,
      ownership: 'exclusive', ownershipEvidence: sha256(JSON.stringify(members)), present: true, protected: false, capability: true, backup: 'covered' });
    targets.push(target);
  }
  for (const name of registry.sharedSecretFiles) {
    const locator = join(base.deletionRoots[0]!, name), info = await lstat(locator).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) retained.push({ resourceId: `shared.${name}`, contribution: 'durable', locator, version: null, owner: null, ownership: 'shared', ownershipEvidence: null,
      present: true, protected: true, capability: false, backup: 'missing' });
  }
  // A missing/foreign key disables native record inspection; it never opens an unverified record or creates a key on preview.
  const inventory: UninstallInventory = { ...base, resources: retained, protectedPaths,
    inventoryRevision: sha256(JSON.stringify(retained)), backupDestination: purge ? join(uninstallRecoveryDirectory(layout.root), 'backup') : null };
  return { inventory, targets, dataTarget: target, portable: members };
}
