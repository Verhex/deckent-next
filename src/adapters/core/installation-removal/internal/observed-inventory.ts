import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { InstallationCacheRemovalTarget } from './cache.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { readNewestWorkerReceipt, observeWorkerRemovalInventory } from '#adapters/core/worker-image/index.js';
import { ErrorRegistry, productResourcePath, resolveGlobalConfigReadPath, DECKENT_DIR, PRODUCT_LAYOUT_REGISTRY, type ConfigLoadOptions, type ResolvedConfig, type ProductResource } from '#platform/index.js';
import { extendUninstallInventory, assertNativeUninstallSupport, removalRegistry } from './inventory.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { affectedToolchainProfiles, type UninstallInventory, type UninstallResource } from '#engine/index.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root: string, path: string) => { const child = relative(root, path); return !child || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };

/** Layout/identity are the recorded owned set. A project identity never proves ownership of the person's shared global root. */
export async function observeUninstallInventory(config: ResolvedConfig, policyRevision: string, scopeIds: readonly string[], options: ConfigLoadOptions, purge = false) {
  assertNativeUninstallSupport(options.platform ?? process.platform);
  const layout = config.productLayout, identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  const installationId = identity.value.installationId, globalRoot = dirname(await resolveGlobalConfigReadPath(options.env, options.platform));
  const projectData = join(config.projectRoot, DECKENT_DIR), bounds = config.installation.packageMeasurement;
  const isGlobal = layout.root === globalRoot;
  // A relocated cache cannot acquire ownership merely because config names it. Only the registry paths within this bound global root qualify.
  const candidates = (['scratch', 'treeScanCache'] as const).filter(resource => isGlobal
    && layout.resources[resource] === PRODUCT_LAYOUT_REGISTRY.resources[resource] && !inside(projectData, productResourcePath(layout, resource)));
  const protectedPaths = [...new Set([projectData, layout.bootstrapConfigPath, ...Object.keys(layout.resources)
    .filter(resource => !candidates.includes(resource as typeof candidates[number])).map(resource => productResourcePath(layout, resource as ProductResource))])];
  // Ownership evidence names the resource owner's membership rule; the fresh scan's member version is what a removal may delete.
  const owned = candidates.map(resourceId => { const members = removalRegistry.cacheMembers[resourceId] ?? [];
    return { resourceId, path: productResourcePath(layout, resourceId), ownershipDigest: hash([installationId, layout.revision, resourceId, members]), members }; });
  const target = new InstallationCacheRemovalTarget(hash([installationId, layout.root]), owned, protectedPaths,
    { maxEntries: bounds.maxFiles, maxDepth: bounds.maxDepth }, work => work());
  const resources: UninstallResource[] = [];
  for (const resource of Object.keys(layout.resources) as ProductResource[]) {
    const locator = productResourcePath(layout, resource), disposable = owned.find(item => item.resourceId === resource);
    const info = await lstat(locator).catch(error => { if (['ENOENT', 'INTEGRITY_KEY_UNAVAILABLE'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; });
    let version: string | null = info ? hash([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]) : null;
    let capability = false, ownership: UninstallResource['ownership'] = 'unknown', members: readonly string[] | null = null;
    if (disposable) {
      try {
        const scan = await target.inspect({ kind: target.kind, id: resource });
        ({ version, members } = scan); capability = true; ownership = 'exclusive';
        // The owner's unnamed entries are kept and listed; only its named members are removed.
        for (const locator of scan.unlisted) resources.push({ resourceId: `${resource}.unlisted.${hash(locator)}`, contribution: 'durable', locator, version: null,
          owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: false, capability: false, backup: 'missing' });
      } catch { /* A foreign owner, unsafe mode, symlink, overlap or scan bound means keep; never an empty tree. */ }
    }
    resources.push({ resourceId: resource, contribution: disposable ? resource : 'durable', locator, version, ...(members?.length ? { members: [...members] } : {}),
      owner: disposable && ownership === 'exclusive' ? installationId : null, ownership,
      ownershipEvidence: disposable && ownership === 'exclusive' ? disposable.ownershipDigest : null,
      present: members ? members.length > 0 : info !== null, protected: !disposable, capability, backup: 'missing' });
  }
  if (globalRoot !== layout.root) resources.push({ resourceId: 'global-data', contribution: 'durable', locator: globalRoot,
    version: null, owner: null, ownership: 'shared', ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing' });
  if (config.service.identity) resources.push({ resourceId: 'recorded-service', contribution: 'service', locator: config.service.identity.serviceId,
    version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing' });
  // Real build-owner observations, never docker tag inference. No complete cross-installation reference producer exists in this revision.
  const receipt = await readNewestWorkerReceipt(join(productResourcePath(layout, 'workspaces'), 'toolchains'));
  const images = new Set([...(receipt?.images ?? (receipt ? [{ imageId: receipt.imageId }] : [])).map(image => image.imageId),
    ...affectedToolchainProfiles(config).flatMap(profile => profile.imageId ? [profile.imageId] : [])]);
  for (const imageId of [...images].sort()) resources.push({ resourceId: `image.${hash(imageId)}`,
    contribution: 'worker-image', locator: imageId, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null,
    present: null, protected: true, capability: false, backup: 'missing' });
  const inventory: UninstallInventory = { installation: { id: installationId, root: layout.root }, scopeSummary: scopeIds,
    layoutRevision: layout.revision, policyRevision, inventoryRevision: hash(resources), resources, blockers: [], protectedPaths,
    deletionRoots: [globalRoot], backupDestination: null, packageRemoval: { command: null, shared: true } };
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile).catch(error => { if (['ENOENT', 'INTEGRITY_KEY_UNAVAILABLE'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; });
  const extended = await extendUninstallInventory(config, inventory, purge, integrity, options.env ?? process.env);
  const imagesObserved = config.execution?.docker ? await observeWorkerRemovalInventory({ home: join(productResourcePath(layout, 'workspaces'), 'toolchains'), installationId,
    buildersRoot: join(globalRoot, PRODUCT_LAYOUT_REGISTRY.resources.workerImageBuilders), executable: config.execution.docker.executable,
    timeoutMs: config.installation.imageProbe.timeoutMs, outputBytes: config.installation.imageProbe.outputBytes }) : { targets: [], resources: [] };
  const finalResources = [...extended.inventory.resources];
  for (const image of imagesObserved.resources) {
    const index = finalResources.findIndex(item => item.resourceId === image.resource.resourceId);
    const observed: UninstallResource = { resourceId: image.resource.resourceId, contribution: 'worker-image', locator: image.resource.imageId,
      version: image.version, owner: image.exclusive ? installationId : null, ownership: image.exclusive ? 'exclusive' : 'unknown', ownershipEvidence: image.exclusive ? image.resource.receiptDigest : null,
      present: image.present, protected: !image.exclusive, capability: image.exclusive, backup: 'missing' };
    if (index >= 0) finalResources[index] = observed; else finalResources.push(observed);
  }
  return { ...extended, inventory: { ...extended.inventory, resources: finalResources, inventoryRevision: hash(finalResources) }, target, targets: [...extended.targets, ...imagesObserved.targets] };
}
