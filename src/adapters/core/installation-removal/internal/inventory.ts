import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { productResourcePath, PRODUCT_LAYOUT_REGISTRY, sha256, lineCut, fileDigest, privateLocationSafe, pathWithin as inside, ErrorRegistry, normalizeGlobalScopePlatform, type ResolvedConfig, type IntegrityAuthority, type ProductResource } from '#platform/index.js';
import { verifyAuditRecord, idleAttemptWorkspace, PROJECT_VAULT, type UninstallInventory, type UninstallResource } from '#engine/index.js';
import { InstallationDataRemovalTarget, memberStat, type DataRemovalMember } from './data.js';
import { PROJECT_INSTRUCTION_REGISTRY, folderTrustRecords, instructionTrustDirectory } from '#adapters/core/project-instructions/index.js';
import { listProjectVaults } from '#adapters/core/secret-store/index.js';
import { ABSENT_FILE_VERSION } from '#adapters/core/workspace-write/index.js';
import type { ProjectTracking } from './vcs.js'; import { attemptRecords } from './quiescence.js';
import paths from './paths.json' with { type: 'json' };
import { GitWorkspaceBroker, resolveGitWorkTarget } from '#adapters/core/git-workspace/index.js';
import { BACKUP_RESOURCES } from '#adapters/core/backup-store/index.js';
// Purge members are exactly the files the standard backup set restores (`deckent backup restore`); every other resource is kept.
export const restorable = [...BACKUP_RESOURCES, 'ledger', 'approvals'] as readonly string[];
export const removalRegistry = z.object({ schemaVersion: z.literal(6), initialBackupPrefix: z.string(), finalBackupPrefix: z.string(), recoveryDirectory: z.string(),
  recoveryRoot: z.record(z.enum(['linux', 'wsl', 'darwin', 'win32']), z.object({ environment: z.string().nullable(), fallback: z.string().min(1), path: z.string().min(1) }).strict()),
  systemctl: z.array(z.string().refine(isAbsolute)).min(1), busctl: z.array(z.string().refine(isAbsolute)).min(1), git: z.array(z.string().refine(isAbsolute)).min(1),
  archive: z.object({ conversation: z.array(z.string()), conversationFiles: z.array(z.string()), workspace: z.object({ pattern: z.string(), lease: z.string() }).strict(), members: z.array(z.string()), transient: z.array(z.string()), companionSuffix: z.string().min(1), manifestSuffix: z.string().min(1), owner: z.string().min(1) }).strict(),
  purgeMembers: z.record(z.string()).refine(value => Object.keys(value).every(name => restorable.includes(name))),
  // A tree joins only through its owner's signed per-file record (sealed with this installation's key) that the standard set restores.
  treeMembers: z.record(z.object({ directory: z.string().regex(/^[a-z][a-z-]*$/u), proof: z.literal('sealed-audit-record') }).strict())
    .refine(value => Object.keys(value).every(name => restorable.includes(name))),
  cacheWriterWitness: z.object({ $comment: z.string().optional(), resourceId: z.string().min(1), budgetMs: z.number().int().positive(), pollMs: z.number().int().positive() }).strict(),
  cacheMembers: z.record(z.array(z.string()).min(1)), sharedSecretFiles: z.array(z.string()) }).strict().parse(paths);
const registry = removalRegistry;
export function assertNativeUninstallSupport(platform: string) { if (platform !== 'linux') throw ErrorRegistry.createError('UNINSTALL_NATIVE_UNSUPPORTED', { params: { platform } }); }
/** §5.5: one person-private recovery root from the registry (XDG state on Linux), one directory per installation; the alpha.56 one beside the data root only while it alone exists. */
export function uninstallRecoveryDirectory(config: { readonly productLayout: { readonly root: string }; readonly installation: { readonly uninstallRecoveryRoot: string | null } },
  env: Readonly<Record<string, string | undefined>>, platform: string = process.platform) {
  const root = config.productLayout.root, entry = registry.recoveryRoot[normalizeGlobalScopePlatform(platform, env)], home = env['HOME'] ?? env['USERPROFILE'];
  const parent = entry && ((entry.environment && env[entry.environment]) || (home && join(home, entry.fallback))), base = config.installation.uninstallRecoveryRoot ?? (parent ? join(parent, entry!.path) : null);
  if (!base || !isAbsolute(base)) throw ErrorRegistry.createError('HOME_NOT_RESOLVED');
  const current = join(base, sha256(root)), legacy = join(dirname(root), registry.recoveryDirectory, sha256(root));
  return existsSync(legacy) && !existsSync(current) ? legacy : current;
}
/** Owner observations, never request paths. Data members are observed for every tier (the plan decides); a relocated or unsafe authority file refuses only the
 * data-deleting tier. K1: an in-project installation's `.deckent` members qualify like global ones; a file the project's VCS tracks is kept and listed. */
export async function extendUninstallInventory(config: ResolvedConfig, base: UninstallInventory, integrity: IntegrityAuthority | null,
  env: Readonly<Record<string, string | undefined>>, globalRoot: string, tracked: ProjectTracking, project: { readonly own: boolean; readonly caches: readonly string[] }) {
  const layout = config.productLayout, installationId = base.installation.id, resources = [...base.resources];
  const bounds = config.installation.packageMeasurement, targets = [];
  let members: DataRemovalMember[] = [];
  const blockers: string[] = [], kept = (path: string) => { const keep = tracked(path), resourceId = `tracked.${sha256(path)}`;
    return !!keep && (resources.some(row => row.resourceId === resourceId) || !!resources.push({ resourceId,
    contribution: 'durable', locator: path, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: true, capability: false, backup: 'missing', keep })); };
  if (!base.deletionRoots.includes(layout.root)) blockers.push(`authority-relocated:${layout.root}`);
  else {
    for (const [name, file] of Object.entries(registry.purgeMembers) as [ProductResource, string][]) {
      const resourcePath = productResourcePath(layout, name), path = file ? join(resourcePath, file.replace('{keyFile}', config.approvals.keyFile)) : resourcePath;
      if (layout.resources[name] !== PRODUCT_LAYOUT_REGISTRY.resources[name] || !inside(layout.root, path)) { blockers.push(`authority-relocated:${path}`); continue; }
      try { if (await memberStat(path) && !kept(path)) members.push({ resourceId: name, path, directory: file ? resourcePath : null, archivePath: relative(resourcePath, path).split(sep).join('/') }); }
      catch { blockers.push(`authority-unsafe:${path}`); }
    }
    if (blockers.length) members = [];
    else if (integrity) members.push(...(await treeMembers(layout, integrity, bounds)).filter(member => !kept(member.path)));
  }
  const archived: DataRemovalMember[] = [], taken = new Set(members.map(member => member.path)), rel = (path: string) => relative(layout.root, path).split(sep).join('/');
  const matches = (list: readonly string[], path: string) => list.some(source => new RegExp(source, 'u').test(rel(path)));
  const conversation = registry.archive.conversation.map(name => productResourcePath(layout, name as ProductResource)); let seen = 0;
  const leases = new Map<string, Promise<{ idle: boolean; evidence: string | null }>>(), limits = { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxRecords: config.audit.maxRecords };
  let broker: Promise<GitWorkspaceBroker> | undefined;
  const owner = () => broker ??= (async () => { if (!config.execution) throw new Error('unconfigured');
    const target = await resolveGitWorkTarget(resolve(config.projectRoot), config.execution, layout);
    return new GitWorkspaceBroker({ ...config.execution.git, ...target.git, workspaceRoot: productResourcePath(layout, 'workspaces') }); })();
  // Owner refusal is distinct from pending work: only a verified owner's files can join either removal group.
  const workspace = (path: string) => { const at = new RegExp(registry.archive.workspace.pattern, 'u').exec(rel(path))?.[0];
    if (at && !leases.has(at)) leases.set(at, (async () => {
      let evidence: string | null = null;
      const idle = await readFile(join(layout.root, at, registry.archive.workspace.lease), 'utf8').then(text => idleAttemptWorkspace(JSON.parse(text), basename(at), base.work,
        async identity => attemptRecords(productResourcePath(layout, 'ledger'), limits, identity), async record => {
          const lease = await (await owner()).openRecorded(record.request.identity);
          if (!lease || lease.id !== basename(at) || lease.baseCommit !== record.request.baseCommit || JSON.stringify(lease.sourceBase) !== JSON.stringify(record.sourceBase)) return false;
          evidence = record.fingerprint; return true;
        })).catch(() => false);
      if (!idle) unlisted(resolve(layout.root, at), 'workspace-pending', evidence);
      return { idle, evidence };
    })()); return at ? leases.get(at)! : null; };
  const unlisted = (locator: string, keep?: 'workspace-pending', evidence: string | null = null) => resources.push({ resourceId: `unlisted.${sha256(locator)}`, contribution: 'durable', locator, version: null,
    owner: evidence ? installationId : null, ownership: evidence ? 'exclusive' : 'unknown', ownershipEvidence: evidence, present: true, protected: !!keep, capability: false, backup: 'missing', ...(keep ? { keep } : {}) });
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      if (++seen > bounds.maxFiles || depth > bounds.maxDepth) throw new Error('UNINSTALL_ARCHIVE_LIMIT');
      if (taken.has(path) || project.caches.some(cache => inside(cache, path))) continue;
      const info = await lstat(path);
      if (info.isDirectory()) { await walk(path, depth + 1); continue; }
      const custody = await workspace(path);
      if (custody && !custody.evidence) continue;
      if (kept(path) || matches(registry.archive.transient, path) && !(info.size && path === `${productResourcePath(layout, 'ledger')}-lock`)) continue;
      if (info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && matches(registry.archive.members, path))
        archived.push(...(conversation.some(resource => inside(resource, path)) || matches(registry.archive.conversationFiles, path) || custody?.idle ? ['conversation-data', 'global-data'] : ['global-data'])
          .map(target => ({ resourceId: rel(path), path, directory: null, archivePath: '', target, archived: true })));
      else unlisted(path);
    }
  };
  if (project.own && !blockers.length) await walk(layout.root, 0).catch(() => { archived.length = 0; blockers.push('archive-limit'); });
  const outside: DataRemovalMember[] = [], add = (path: string, extra: Partial<DataRemovalMember> = {}) => outside.push({ resourceId: 'project', path, directory: null, archivePath: '', target: 'global-data', archived: true, ...extra });
  if (project.own && archived.length) {
    const written = new Map<string, string[]>(), earlier = new Map<string, string[]>(), created = new Set<string>();
    for (const name of (await readdir(productResourcePath(layout, 'fileEffects')).catch(() => [] as string[])).slice(0, bounds.maxFiles)) {
      const entry = await readFile(join(productResourcePath(layout, 'fileEffects'), name), 'utf8').then(text => JSON.parse(text) as { rel?: string; expected?: string; next?: string; state?: string }, () => null);
      if (entry?.state !== 'committed' || !entry.rel || !entry.next) continue;
      written.set(entry.rel, [...written.get(entry.rel) ?? [], entry.next]); earlier.set(entry.rel, [...earlier.get(entry.rel) ?? [], entry.expected ?? '']);
      if (entry.expected === ABSENT_FILE_VERSION) created.add(`${entry.rel}\0${entry.next}`);
    }
    const bridge = async (name: string) => { const path = join(config.projectRoot, name); return await memberStat(path, true).catch(() => null) && written.has(name) && !kept(path) ? path : null; };
    const skeleton = await bridge(PROJECT_INSTRUCTION_REGISTRY.files[0]!), stays = !skeleton && !!await lstat(join(config.projectRoot, PROJECT_INSTRUCTION_REGISTRY.files[0]!)).catch(() => null);
    const changed = stays || !!skeleton && !written.get(PROJECT_INSTRUCTION_REGISTRY.files[0]!)!.includes(await fileDigest(skeleton)); // a kept DECKENT.md keeps its bridge lines
    if (skeleton) { if (changed) unlisted(skeleton); else add(skeleton); }
    for (const row of PROJECT_INSTRUCTION_REGISTRY.bridges) { const path = await bridge(row.path), bytes = path && !changed ? await readFile(path) : null;
      if (path && bytes && created.has(`${row.path}\0${await fileDigest(path)}`)) add(path);
      else if (path && bytes && lineCut(bytes, row.line)) add(path, { line: row.line, before: earlier.get(row.path)! }); else if (path) unlisted(path); }
    for (const path of await folderTrustRecords(config.projectRoot, instructionTrustDirectory(env), config.execution?.adoption.targets ?? []).catch(() => [])) add(path, { directory: dirname(path) });
    for (const { directory, record } of await listProjectVaults(globalRoot).catch(() => []))
      if (record?.anchor.installationId !== installationId || record.anchor.projectRoot !== config.projectRoot) continue;
      else if (record.anchor.repository !== null) unlisted(directory);
      else for (const entry of await readdir(directory)) if ([PROJECT_VAULT.projectFile, PROJECT_VAULT.grantsFile, ...registry.sharedSecretFiles].includes(entry)) add(join(directory, entry), { directory }); else unlisted(join(directory, entry));
  }
  archived.push(...outside);
  const covers = (row: UninstallResource, target: string) => [...members, ...archived].some(member => (member.target ?? 'global-data') === target && (inside(row.locator, member.path) || inside(member.path, row.locator)));
  if (project.own) for (const [index, row] of resources.entries()) if (row.contribution === 'durable' && covers(row, 'global-data'))
    resources[index] = { ...row, tiers: covers(row, 'conversation-data') ? ['keep-data'] : ['keep-data', 'keep-work'] };
  const owners = new Set(project.own ? [] : members.map(member => member.resourceId)), retained = resources.filter(item => !owners.has(item.resourceId));
  // Anything else in a member's directory (or beside a member tree's owner directory) has no recorded owner here: kept and reported.
  const trees = Object.entries(registry.treeMembers).filter(([name]) => owners.has(name)).map(([name]) => productResourcePath(layout, name as ProductResource));
  for (const directory of new Set(project.own ? [] : [...trees, ...members.flatMap(member => member.directory ? [member.directory] : [])])) {
    for (const name of (await readdir(directory)).slice(0, bounds.maxFiles).sort()) {
      const locator = join(directory, name);
      if (!members.some(member => member.path === locator || member.directory === locator) && !tracked(locator)) retained.push({ resourceId: `unlisted.${sha256(locator)}`, contribution: 'durable',
        locator, version: null, owner: null, ownership: 'unknown', ownershipEvidence: null, present: true, protected: false, capability: false, backup: 'missing' });
    }
  }
  const all = [...members, ...archived], memberResources = new Set(members.map(member => productResourcePath(layout, member.resourceId as ProductResource)));
  const protectedPaths = base.protectedPaths.filter(path => !memberResources.has(path) && !archived.some(member => inside(path, member.path) || inside(member.path, path)));
  const target = new InstallationDataRemovalTarget(sha256(JSON.stringify([installationId, layout.root])), all, protectedPaths);
  for (const [resourceId, contribution] of [['global-data', 'durable'], ['conversation-data', 'conversation']] as const) {
    const own = all.filter(member => (member.target ?? 'global-data') === resourceId);
    if (!own.length) continue;
    retained.push({ resourceId, contribution, locator: layout.root, members: own.map(member => member.path), version: (await target.observe({ kind: target.kind, id: resourceId })).version,
      owner: installationId, ownership: 'exclusive', ownershipEvidence: sha256(JSON.stringify(own)), present: true, protected: false, capability: true, backup: 'covered',
      ...(project.own ? { tiers: [resourceId === 'global-data' ? 'all' : 'keep-work'] } : {}) });
  }
  if (all.length) targets.push(target);
  for (const name of registry.sharedSecretFiles) {
    const locator = join(globalRoot, name), info = await lstat(locator).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) retained.push({ resourceId: `shared.${name}`, contribution: 'durable', locator, version: null, owner: null, ownership: 'shared', ownershipEvidence: null,
      present: true, protected: true, capability: false, backup: 'missing' });
  }
  // A missing/foreign key disables native record inspection; it never opens an unverified record or creates a key on preview.
  const inventory: UninstallInventory = { ...base, resources: retained, protectedPaths, dataBlockers: [...base.dataBlockers, ...blockers],
    deletionRoots: [...base.deletionRoots, ...new Set(outside.map(member => member.directory ?? config.projectRoot))],
    inventoryRevision: sha256(JSON.stringify(retained)), backupDestination: join(uninstallRecoveryDirectory(config, env), 'backup'),
    recoveryForbidden: project.own ? [config.projectRoot] : [], recoveryUnsafe: !await privateLocationSafe(uninstallRecoveryDirectory(config, env)) };
  return { inventory, targets, dataTarget: target, portable: all };
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
