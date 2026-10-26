import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { InstallationCacheRemovalTarget, FileInstallationIdentityStore, readNewestWorkerReceipt } from '#adapters/index.js';
import { ErrorRegistry, productResourcePath, resolveGlobalConfigReadPath, DECKENT_DIR, PRODUCT_LAYOUT_REGISTRY, type ConfigLoadOptions, type ResolvedConfig, type ProductResource } from '#platform/index.js';
import { affectedToolchainProfiles, type UninstallInventory, type UninstallResource } from '#engine/index.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root: string, path: string) => { const child = relative(root, path); return !child || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };

/** Layout/identity are the recorded owned set. A project identity never proves ownership of the person's shared global root. */
export async function configuredUninstallInventory(config: ResolvedConfig, policyRevision: string, scopeIds: readonly string[], options: ConfigLoadOptions) {
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
  const owned = candidates.map(resourceId => ({ resourceId, path: productResourcePath(layout, resourceId),
    ownershipDigest: hash([installationId, layout.revision, resourceId]) }));
  const target = new InstallationCacheRemovalTarget(hash([installationId, layout.root]), owned, protectedPaths,
    { maxEntries: bounds.maxFiles, maxDepth: bounds.maxDepth }, work => work());
  const resources: UninstallResource[] = [];
  for (const resource of Object.keys(layout.resources) as ProductResource[]) {
    const locator = productResourcePath(layout, resource), disposable = owned.find(item => item.resourceId === resource);
    const info = await lstat(locator).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    let version: string | null = info ? hash([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]) : null;
    let capability = false, ownership: UninstallResource['ownership'] = 'unknown';
    if (disposable) {
      try { version = (await target.observe({ kind: target.kind, id: resource })).version; capability = true; ownership = 'exclusive'; }
      catch { /* A foreign owner, unsafe mode, symlink, overlap or scan bound means keep; never an empty tree. */ }
    }
    resources.push({ resourceId: resource, contribution: disposable ? resource : 'durable', locator, version,
      owner: disposable && ownership === 'exclusive' ? installationId : null, ownership,
      ownershipEvidence: disposable && ownership === 'exclusive' ? disposable.ownershipDigest : null,
      present: info !== null, protected: !disposable, capability, backup: 'missing' });
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
  return { inventory, target };
}
