import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { productResourcePath, PRODUCT_LAYOUT_REGISTRY, sha256, pathWithin as inside, ErrorRegistry, normalizeGlobalScopePlatform, type ResolvedConfig, type IntegrityAuthority, type ProductResource } from '#platform/index.js';
import { verifyAuditRecord, type UninstallInventory } from '#engine/index.js';
import { InstallationDataRemovalTarget, memberStat, type DataRemovalMember } from './data.js';
import type { ProjectTracking } from './vcs.js';
import paths from './paths.json' with { type: 'json' };
import { BACKUP_RESOURCES } from '#adapters/core/backup-store/index.js';
// Purge members are exactly the files the standard backup set restores (`deckent backup restore`); every other resource is kept.
export const restorable = [...BACKUP_RESOURCES, 'ledger', 'approvals'] as readonly string[];
export const removalRegistry = z.object({ schemaVersion: z.literal(4), initialBackupPrefix: z.string(), finalBackupPrefix: z.string(), recoveryDirectory: z.string(),
  recoveryRoot: z.record(z.enum(['linux', 'wsl', 'darwin', 'win32']), z.object({ environment: z.string().nullable(), fallback: z.string().min(1), path: z.string().min(1) }).strict()),
  systemctl: z.array(z.string().refine(isAbsolute)).min(1), git: z.array(z.string().refine(isAbsolute)).min(1),
  purgeMembers: z.record(z.string()).refine(value => Object.keys(value).every(name => restorable.includes(name))),
  // A tree joins only through its owner's signed per-file record (sealed with this installation's key) that the standard set restores.
  treeMembers: z.record(z.object({ directory: z.string().regex(/^[a-z][a-z-]*$/u), proof: z.literal('sealed-audit-record') }).strict())
    .refine(value => Object.keys(value).every(name => restorable.includes(name))),
  cacheMembers: z.record(z.array(z.string()).min(1)), sharedSecretFiles: z.array(z.string()) }).strict().parse(paths);
const registry = removalRegistry;
export function assertNativeUninstallSupport(platform: string) { if (platform !== 'linux') throw ErrorRegistry.createError('UNINSTALL_NATIVE_UNSUPPORTED', { params: { platform } }); }
/** §5.5: one person-private recovery root from the registry (XDG state on Linux), outside every deletion root; one directory per installation.
 * The alpha.56 location beside the data root is used only while it alone exists (an earlier interrupted purge finishes where it started). */
export function uninstallRecoveryDirectory(root: string, env: Readonly<Record<string, string | undefined>>, platform: string = process.platform) {
  const entry = registry.recoveryRoot[normalizeGlobalScopePlatform(platform, env)], home = env['HOME'] ?? env['USERPROFILE'];
  const base = entry && ((entry.environment && env[entry.environment]) || (home ? join(home, entry.fallback) : null));
  if (!entry || !base || !isAbsolute(base)) throw ErrorRegistry.createError('HOME_NOT_RESOLVED');
  const current = join(base, entry.path, sha256(root)), legacy = join(dirname(root), registry.recoveryDirectory, sha256(root));
  return existsSync(legacy) && !existsSync(current) ? legacy : current;
}
/** Native records and portable canonical layout resources are owner observations, never paths supplied by an uninstall request. Data members are
 * observed for every tier (the plan decides); a relocated or unsafe authority file refuses only the data-deleting tier. K1: an in-project
 * installation's `.deckent` members qualify like global ones; a file the project's VCS tracks is never a member (kept and listed). */
export async function extendUninstallInventory(config: ResolvedConfig, base: UninstallInventory, integrity: IntegrityAuthority | null,
  env: Readonly<Record<string, string | undefined>>, globalRoot: string, tracked: ProjectTracking) {
  const layout = config.productLayout, installationId = base.installation.id, resources = [...base.resources];
  const bounds = config.installation.packageMeasurement, targets = [];
  // The installation's authority files are one atomic set: a relocated, unsafe or foreign member keeps all of them and blocks the data tier.
  let members: DataRemovalMember[] = [];
  const blockers: string[] = [], kept = (path: string) => { const keep = tracked(path); return !!keep && !!resources.push({ resourceId: `tracked.${sha256(path)}`,
    contribution: 'durable', locator: path, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: true, capability: false, backup: 'missing', keep }); };
  if (!base.deletionRoots.includes(layout.root)) blockers.push(`authority-relocated:${layout.root}`);
  else {
    for (const [name, file] of Object.entries(registry.purgeMembers) as [ProductResource, string][]) {
      const resourcePath = productResourcePath(layout, name), path = file ? join(resourcePath, file.replace('{keyFile}', config.approvals.keyFile)) : resourcePath;
      // Verified absence is not unsafe; a relocated, unreadable or unsafe member blocks the whole data tier with its exact path.
      if (layout.resources[name] !== PRODUCT_LAYOUT_REGISTRY.resources[name] || !inside(layout.root, path)) { blockers.push(`authority-relocated:${path}`); continue; }
      try { if (await memberStat(path) && !kept(path)) members.push({ resourceId: name, path, directory: file ? resourcePath : null, archivePath: relative(resourcePath, path).split(sep).join('/') }); }
      catch { blockers.push(`authority-unsafe:${path}`); }
    }
    if (blockers.length) members = [];
    else if (integrity) members.push(...(await treeMembers(layout, integrity, bounds)).filter(member => !kept(member.path)));
  }
  const owners = new Set(members.map(member => member.resourceId)), retained = resources.filter(item => !owners.has(item.resourceId));
  // Anything else in a member's directory (or beside a member tree's owner directory) has no recorded owner here: kept and reported.
  const trees = Object.entries(registry.treeMembers).filter(([name]) => owners.has(name)).map(([name]) => productResourcePath(layout, name as ProductResource));
  for (const directory of new Set([...trees, ...members.flatMap(member => member.directory ? [member.directory] : [])])) {
    for (const name of (await readdir(directory)).slice(0, bounds.maxFiles).sort()) {
      const locator = join(directory, name);
      if (!members.some(member => member.path === locator || member.directory === locator) && !tracked(locator)) retained.push({ resourceId: `unlisted.${sha256(locator)}`, contribution: 'durable',
        locator, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: false, capability: false, backup: 'missing' });
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
    const locator = join(globalRoot, name), info = await lstat(locator).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) retained.push({ resourceId: `shared.${name}`, contribution: 'durable', locator, version: null, owner: null, ownership: 'shared', ownershipEvidence: null,
      present: true, protected: true, capability: false, backup: 'missing' });
  }
  // A missing/foreign key disables native record inspection; it never opens an unverified record or creates a key on preview.
  const inventory: UninstallInventory = { ...base, resources: retained, protectedPaths, dataBlockers: [...base.dataBlockers, ...blockers],
    inventoryRevision: sha256(JSON.stringify(retained)), backupDestination: join(uninstallRecoveryDirectory(layout.root, env), 'backup') };
  return { inventory, targets, dataTarget: target, portable: members };
}
/** Signed per-file records of a tree owner: a private regular file whose content verifies as a sealed audit record with this installation's
 * key and names itself (eventId = file name). Unsigned, foreign-key, renamed or oversized files are never members; an unbounded tree has none. */
async function treeMembers(layout: ResolvedConfig['productLayout'], integrity: IntegrityAuthority,
  bounds: { readonly maxFiles: number; readonly maxFileBytes: number }): Promise<DataRemovalMember[]> {
  const found: DataRemovalMember[] = [];
  for (const [name, tree] of Object.entries(registry.treeMembers) as [ProductResource, { directory: string }][]) {
    const resourcePath = productResourcePath(layout, name), directory = join(resourcePath, tree.directory);
    if (layout.resources[name] !== PRODUCT_LAYOUT_REGISTRY.resources[name] || !inside(layout.root, directory)) continue;
    const names = await readdir(directory).catch(() => null);
    if (!names || names.length > bounds.maxFiles) continue;
    for (const entry of names.sort()) {
      const path = join(directory, entry);
      try {
        const info = await memberStat(path);
        if (!info || info.size > bounds.maxFileBytes || verifyAuditRecord(JSON.parse(await readFile(path, 'utf8')), integrity).event.eventId !== entry) continue;
        found.push({ resourceId: name, path, directory, archivePath: `${tree.directory}/${entry}` });
      } catch { /* not this owner's signed record: kept and listed */ }
    }
  }
  return found;
}
