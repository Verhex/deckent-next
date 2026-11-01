import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InstallationCacheRemovalTarget } from './cache.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { readNewestWorkerReceipt, observeWorkerRemovalInventory } from '#adapters/core/worker-image/index.js';
import { ErrorRegistry, packageRemovalCommand, pathWithin as inside, sha256, productResourcePath, resolveGlobalConfigReadPath, resolveGlobalScopePaths, normalizeGlobalScopePlatform, DECKENT_DIR, PRODUCT_LAYOUT_REGISTRY, type ConfigLoadOptions, type ResolvedConfig, type ProductResource } from '#platform/index.js';
import { extendUninstallInventory, assertNativeUninstallSupport, removalRegistry, restorable } from './inventory.js';
import { observeUninstallWork } from './quiescence.js';
import { configuredTracking } from './vcs.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { affectedToolchainProfiles, type UninstallInventory, type UninstallResource } from '#engine/index.js';
const hash = (value: unknown) => sha256(JSON.stringify(value));

/** Layout/identity are the recorded owned set. A project identity never proves ownership of the person's shared global root. Read only for every
 * tier: work is counted item by item from the ledger without creating sidecars; the runtime service is observed by composition (describe). */
export async function observeUninstallInventory(config: ResolvedConfig, policyRevision: string, scopeIds: readonly string[], options: ConfigLoadOptions) {
  assertNativeUninstallSupport(options.platform ?? process.platform);
  const layout = config.productLayout, identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  const installationId = identity.value.installationId, globalRoot = dirname(await resolveGlobalConfigReadPath(options.env, options.platform));
  const projectData = join(config.projectRoot, DECKENT_DIR), bounds = config.installation.packageMeasurement;
  const rooted = layout.root === globalRoot || layout.root === projectData, env = options.env ?? process.env;
  const candidates = (['scratch', 'treeScanCache', 'compileCache'] as const).filter(resource => rooted
    && layout.resources[resource] === PRODUCT_LAYOUT_REGISTRY.resources[resource] && inside(layout.root, productResourcePath(layout, resource)));
  const tracked = await configuredTracking(config);
  const protectedPaths = [...new Set([...(layout.root === projectData ? [] : [projectData]), layout.bootstrapConfigPath, ...Object.keys(layout.resources)
    .filter(resource => !candidates.includes(resource as typeof candidates[number])).map(resource => productResourcePath(layout, resource as ProductResource))])];
  // Ownership evidence names the resource owner's membership rule; the fresh scan's member version is what a removal may delete.
  const witness = { ...removalRegistry.cacheWriterWitness, directory: PRODUCT_LAYOUT_REGISTRY.compileCacheWritersDirectory, fence: PRODUCT_LAYOUT_REGISTRY.compileCacheRemovalFence }, writersMember = `${witness.directory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\.[0-9a-f]{16})?`; // Astra 2862/2867 R2: the writer records (live or renamed by a removal) are a compile-cache member, removed after every recorded writer ended (the target waits)
  const owned = candidates.map(resourceId => { const named = removalRegistry.cacheMembers[resourceId] ?? [], members = resourceId === witness.resourceId && named.length === 1 ? [`^(?:${named[0]!.slice(1, -1)}|${writersMember})$`] : named;
    return { resourceId, path: productResourcePath(layout, resourceId), ownershipDigest: hash([installationId, layout.revision, resourceId, members]), members }; });
  const target = new InstallationCacheRemovalTarget(hash([installationId, layout.root]), owned, protectedPaths,
    { maxEntries: bounds.maxFiles, maxDepth: bounds.maxDepth }, work => work(), undefined, witness);
  const resources: UninstallResource[] = [];
  for (const resource of Object.keys(layout.resources) as ProductResource[]) {
    const locator = productResourcePath(layout, resource), disposable = owned.find(item => item.resourceId === resource);
    const info = await lstat(locator).catch(error => { if (['ENOENT', 'INTEGRITY_KEY_UNAVAILABLE'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; });
    let version: string | null = info ? hash([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]) : null;
    let capability = false, ownership: UninstallResource['ownership'] = 'unknown', members: readonly string[] | null = null, held: 'vcs-tracked' | 'vcs-unverified' | null = null;
    if (disposable) {
      try {
        const scan = await target.inspect({ kind: target.kind, id: resource });
        ({ version, members } = scan); ownership = 'exclusive';
        held = scan.members.map(tracked).find(Boolean) ?? null; capability = !held;
        // The owner's unnamed entries are kept and listed; only its named members are removed.
        for (const locator of scan.unlisted) resources.push({ resourceId: `${resource}.unlisted.${hash(locator)}`, contribution: 'durable', locator, version: null,
          owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: false, capability: false, backup: 'missing' });
      } catch { /* A foreign owner, unsafe mode, symlink, overlap or scan bound means keep; never an empty tree. */ }
    }
    resources.push({ resourceId: resource, contribution: disposable ? resource : 'durable', locator, version, ...(members?.length ? { members: [...members] } : {}),
      owner: disposable && ownership === 'exclusive' ? installationId : null, ownership,
      ownershipEvidence: disposable && ownership === 'exclusive' ? disposable.ownershipDigest : null,
      present: members ? members.length > 0 : info !== null, protected: !disposable, capability, backup: 'missing',
      ...(held ? { keep: held } : disposable || restorable.includes(resource) ? {} : { keep: 'not-backed-up' as const }) });
  }
  if (globalRoot !== layout.root) resources.push({ resourceId: 'global-home', contribution: 'durable', locator: globalRoot,
    version: null, owner: null, ownership: 'shared', ownershipEvidence: null, present: null, protected: true, capability: false, backup: 'missing' });
  // Real build-owner observations, never docker tag inference; only the lease owner's complete references can make one removable.
  const receipt = await readNewestWorkerReceipt(join(productResourcePath(layout, 'workspaces'), 'toolchains'));
  const images = new Set([...(receipt?.images ?? (receipt ? [{ imageId: receipt.imageId }] : [])).map(image => image.imageId),
    ...affectedToolchainProfiles(config).flatMap(profile => profile.imageId ? [profile.imageId] : [])]);
  for (const imageId of [...images].sort()) resources.push({ resourceId: `image.${hash(imageId)}`,
    contribution: 'worker-image', locator: imageId, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null,
    present: null, protected: true, capability: false, backup: 'missing' });
  const inventory: UninstallInventory = { installation: { id: installationId, root: layout.root }, scopeSummary: scopeIds,
    layoutRevision: layout.revision, policyRevision, inventoryRevision: hash(resources), resources, blockers: [], protectedPaths,
    dataBlockers: [], deletionRoots: rooted ? [layout.root] : [globalRoot], backupDestination: null,
    packageRemoval: { command: packageRemovalCommand(), shared: true }, managedScopes: [], service: { running: false, unit: null, unitDisable: 'none', command: null },
    work: observeUninstallWork(productResourcePath(layout, 'ledger'), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxRecords: config.audit.maxRecords, companyId: config.company.id }) };
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile).catch(error => { if (['ENOENT', 'INTEGRITY_KEY_UNAVAILABLE'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; });
  const extended = await extendUninstallInventory(config, inventory, integrity, env, globalRoot, tracked, { own: layout.root === projectData, caches: owned.map(item => item.path) });
  const imagesObserved = config.execution?.docker ? await observeWorkerRemovalInventory({ home: join(productResourcePath(layout, 'workspaces'), 'toolchains'), installationId,
    // The builder's own custody root (toolchains builder): its lock fences lease writes against this removal.
    buildersRoot: join(resolveGlobalScopePaths(normalizeGlobalScopePlatform(options.platform ?? process.platform, env), env, { ignoreProjectOverride: true }).stateDir,
      PRODUCT_LAYOUT_REGISTRY.resources.workerImageBuilders), executable: config.execution.docker.executable,
    timeoutMs: config.installation.imageProbe.timeoutMs, outputBytes: config.installation.imageProbe.outputBytes }) : { targets: [], resources: [] };
  const finalResources = [...extended.inventory.resources];
  for (const image of imagesObserved.resources) {
    const index = finalResources.findIndex(item => item.resourceId === image.resource.resourceId);
    const observed: UninstallResource = { resourceId: image.resource.resourceId, contribution: 'worker-image', locator: image.resource.imageId,
      version: image.version, owner: image.exclusive ? installationId : null, ownership: image.exclusive ? 'exclusive' : 'unknown', ownershipEvidence: image.exclusive ? image.resource.receiptDigest : null,
      present: image.present, protected: !image.exclusive, capability: image.exclusive, backup: 'missing', ...(image.manualCommand ? { manualCommand: image.manualCommand } : {}) };
    if (index >= 0) finalResources[index] = observed; else finalResources.push(observed);
  }
  return { ...extended, inventory: { ...extended.inventory, resources: finalResources, inventoryRevision: hash(finalResources) }, target, targets: [...extended.targets, ...imagesObserved.targets] };
}
