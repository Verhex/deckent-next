import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ErrorRegistry, withConfigWriteLock } from '#platform/index.js';
import { CORE_SECRET_GRANT_STORE_ID, DECK_FILE, PROJECT_VAULT, assessProjectVaultOwnership, emptySecretGrantFile, projectVaultClaimed, projectVaultHandover,
  projectVaultKey, projectVaultRecordSchema, secretGrantFileSchema, type ProjectVaultAnchor, type ProjectVaultLocation, type ProjectVaultRecord,
  type SecretGrant, type SecretGrantFile, type SecretGrantStoreContext, type SecretGrantStoreFactory } from '#engine/index.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const uid = () => process.getuid?.();
const privateFile = (info: { isFile(): boolean; mode: number; nlink: number; uid: number }) => {
  const owner = uid();
  return info.isFile() && (info.mode & 0o077) === 0 && info.nlink === 1 && (owner === undefined || info.uid === owner);
};
const unsafe = (path: string) => ErrorRegistry.createError('SECRET_STORE_UNSAFE', { params: { path } });

/** A directory's identity now (canonical path, device, inode), or null when it does not exist as a directory. */
export async function directoryLocation(path: string): Promise<ProjectVaultLocation | null> {
  try {
    const canonicalRoot = await realpath(path), info = await stat(canonicalRoot, { bigint: true });
    return info.isDirectory() && info.ino !== 0n ? { canonicalRoot, device: String(info.dev), inode: String(info.ino) } : null;
  } catch { return null; }
}
const sameLocation = (a: ProjectVaultLocation | null, b: ProjectVaultLocation) => a !== null && a.canonicalRoot === b.canonicalRoot && a.device === b.device && a.inode === b.inode;
/** Whether a recorded directory still exists with its recorded identity (the handover rule: only a moved owner is gone). */
export const locationPresent = async (location: ProjectVaultLocation) => sameLocation(await directoryLocation(location.canonicalRoot), location);

/**
 * The Git repository a project root belongs to, read from its `.git` (no Git process, no inherited Git environment):
 * - `none`: no `.git` at the root; `main`: `.git` is the repository directory (the main working tree);
 * - `linked`: a worktree whose `.git` file names `<common>/worktrees/<name>`, whose `commondir` names `<common>` and whose `gitdir` back-link
 *   names this very `.git` file — `mainWorkTree` is the repository's main working tree (null for a bare repository: each worktree keeps its own vault);
 * - `foreign`: any other `.git` file, among them a copied worktree folder (its back-link names the original), refused as not this repository's.
 */
export type ProjectRepository = { readonly kind: 'none' } | { readonly kind: 'foreign' }
  | { readonly kind: 'main' | 'linked'; readonly repository: ProjectVaultLocation; readonly mainWorkTree: string | null };
export async function projectRepository(projectRoot: string): Promise<ProjectRepository> {
  const root = await realpath(projectRoot), dotGit = join(root, '.git');
  const info = await lstat(dotGit).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (!info) return { kind: 'none' };
  if (info.isDirectory()) {
    const repository = await directoryLocation(dotGit);
    return repository ? { kind: 'main', repository, mainWorkTree: root } : { kind: 'foreign' };
  }
  try {
    if (!info.isFile()) return { kind: 'foreign' };
    const match = /^gitdir: (.+)$/mu.exec((await readFile(dotGit, 'utf8')).slice(0, 4_096));
    if (!match) return { kind: 'foreign' };
    const gitdir = await realpath(resolve(root, match[1]!.trim()));
    const common = await realpath(resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()));
    const back = await realpath(resolve(gitdir, (await readFile(join(gitdir, 'gitdir'), 'utf8')).trim()));
    const repository = await directoryLocation(common);
    if (!repository || basename(dirname(gitdir)) !== 'worktrees' || dirname(dirname(gitdir)) !== common || back !== dotGit) return { kind: 'foreign' };
    const main = basename(common) === '.git' && await realpath(join(dirname(common), '.git')).catch(() => null) === common ? dirname(common) : null;
    return { kind: 'linked', repository, mainWorkTree: main };
  } catch { return { kind: 'foreign' }; }
}

/** `<global root>/project-secrets/<key>/`: the project vault, its ownership record and its grants. `prepare` creates it (0700) for a writer;
 * a reader never creates anything (absent: null). Not a private directory of this user → `SECRET_STORE_UNSAFE`, nothing read. */
export async function projectVaultDirectory(globalRoot: string, anchor: ProjectVaultAnchor, prepare: boolean): Promise<string | null> {
  const parent = join(globalRoot, PROJECT_VAULT.directory), directory = join(parent, projectVaultKey(anchor));
  if (prepare) {
    await mkdir(globalRoot, { recursive: true, mode: 0o700 });
    for (const path of [parent, directory]) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  }
  const info = await lstat(directory).catch((error: unknown) => { if (missing(error)) return null; throw unsafe(directory); });
  if (!info) return null;
  const owner = uid();
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (owner !== undefined && info.uid !== owner)) throw unsafe(directory);
  return directory;
}

/** One private JSON record of the vault directory: absent → null; not a private single-link file, too large or unreadable → `reason`. */
async function readRecord(path: string, maxBytes: number): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!privateFile(info)) return { ok: false, reason: 'not-private' };
    if (info.size > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, value: JSON.parse(await handle.readFile('utf8')) as unknown };
  } catch (error) {
    if (missing(error)) return { ok: true, value: null };
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'not-private' : error instanceof SyntaxError ? 'invalid' : 'unreadable' };
  } finally { await handle?.close().catch(() => undefined); }
}
async function writeRecord(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

const recordPath = (directory: string) => join(directory, PROJECT_VAULT.projectFile);
async function loadOwnership(directory: string): Promise<ProjectVaultRecord | null> {
  const read = await readRecord(recordPath(directory), PROJECT_VAULT.projectMaxBytes);
  if (!read.ok) throw read.reason === 'invalid' ? ErrorRegistry.createError('SECRET_STORE_CORRUPT', { params: { backend: PROJECT_VAULT.projectFile } }) : unsafe(directory);
  if (read.value === null) return null;
  const parsed = projectVaultRecordSchema.safeParse(read.value);
  if (!parsed.success) throw ErrorRegistry.createError('SECRET_STORE_CORRUPT', { params: { backend: PROJECT_VAULT.projectFile } });
  return parsed.data;
}
/**
 * The ownership check of a vault for the anchor that asks now (law audit BLOCKER). A reader of an existing vault (`claim: false`) only checks;
 * the first writer (`claim: true`) records the anchor under the config write lock. A record of another data root or repository is
 * `SECRET_PROJECT_VAULT_CLAIMED`: a copy never opens the original's vault.
 */
export async function admitProjectVault(directory: string, anchor: ProjectVaultAnchor, claim: boolean, nowMs: number, lockTimeoutMs: number): Promise<void> {
  const check = (record: ProjectVaultRecord | null) => { if (record && assessProjectVaultOwnership(record, anchor) === 'claimed') throw projectVaultClaimed(anchor); return record; };
  if (check(await loadOwnership(directory)) || !claim) return;
  await withConfigWriteLock(recordPath(directory), async () => {
    if (check(await loadOwnership(directory))) return;
    await writeRecord(recordPath(directory), projectVaultRecordSchema.parse({ schemaVersion: 1, anchor, firstSeenAtMs: nowMs, handedOverAtMs: null }));
  }, lockTimeoutMs);
}
/** Explicit handover after a move (the recorded owner's data root is gone); refused while the original still holds its identity. */
export async function handOverProjectVault(directory: string, anchor: ProjectVaultAnchor, nowMs: number, lockTimeoutMs: number): Promise<ProjectVaultRecord> {
  return withConfigWriteLock(recordPath(directory), async () => {
    const record = await loadOwnership(directory);
    if (!record) throw projectVaultClaimed(anchor);
    if (assessProjectVaultOwnership(record, anchor) === 'match') return record;
    const next = projectVaultHandover(record, anchor, await locationPresent(record.anchor.binding), nowMs);
    await writeRecord(recordPath(directory), next);
    return next;
  }, lockTimeoutMs);
}
/** Every vault directory's ownership record of this main vault (inventory `--all`): names of directories and their records, never a value. */
export async function listProjectVaults(globalRoot: string): Promise<readonly { readonly directory: string; readonly record: ProjectVaultRecord | null }[]> {
  const parent = join(globalRoot, PROJECT_VAULT.directory);
  const entries = await readdir(parent).catch((error: unknown) => { if (missing(error)) return [] as string[]; throw unsafe(parent); });
  const rows = [];
  for (const entry of entries.filter(name => /^[a-f0-9]{64}$/u.test(name)).sort()) {
    const directory = join(parent, entry);
    rows.push({ directory, record: await loadOwnership(directory).catch(() => null) });
  }
  return rows;
}

const grantFailure = (reason: string) => ErrorRegistry.createError(reason === 'invalid' ? 'SECRET_GRANT_STORE_INVALID' : 'SECRET_GRANT_STORE_UNSAFE', { params: { reason } });
async function readGrants(path: string, anchor: ProjectVaultAnchor): Promise<SecretGrantFile> {
  const read = await readRecord(path, PROJECT_VAULT.grantsMaxBytes);
  if (!read.ok) throw grantFailure(read.reason);
  if (read.value === null) return emptySecretGrantFile(anchor);
  const parsed = secretGrantFileSchema.safeParse(read.value);
  // A record of another project (a hand-copied file) grants nothing here.
  if (!parsed.success || parsed.data.installationId !== anchor.installationId || parsed.data.projectId !== anchor.projectId) throw grantFailure('invalid');
  return parsed.data;
}
/** `core.secret-grant.file@1`: `grants.json` beside the project vault, private (0600, owner, one link), replaced atomically under the config
 * write lock; an unreadable record is never overwritten. The caller admitted the vault (ownership) before. */
export const fileSecretGrantStoreFactory: SecretGrantStoreFactory = Object.freeze({ id: CORE_SECRET_GRANT_STORE_ID, create: ({ root, anchor, lockTimeoutMs }: SecretGrantStoreContext) => {
  const path = join(root, PROJECT_VAULT.directory, projectVaultKey(anchor), PROJECT_VAULT.grantsFile);
  return Object.freeze({ id: CORE_SECRET_GRANT_STORE_ID, read: () => readGrants(path, anchor),
    update: (change: (current: SecretGrantFile) => readonly SecretGrant[]) => withConfigWriteLock(path, async () => {
      const current = await readGrants(path, anchor);
      const next = secretGrantFileSchema.parse({ ...current, revision: current.revision + 1, grants: change(current) });
      await writeRecord(path, next);
      return next;
    }, lockTimeoutMs) });
} });

/** The project's `.deck` text, or null when there is none. A link, a non-regular file or a file over the bound is `DECK_FILE_INVALID` (never followed or read). */
export async function readProjectDeck(projectRoot: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(join(projectRoot, DECK_FILE.fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw ErrorRegistry.createError('DECK_FILE_INVALID', { params: { reason: 'not-a-file' } });
    if (info.size > DECK_FILE.maxBytes) throw ErrorRegistry.createError('DECK_FILE_INVALID', { params: { reason: 'too-large' } });
    return await handle.readFile('utf8');
  } catch (error) {
    if (missing(error)) return null;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw ErrorRegistry.createError('DECK_FILE_INVALID', { params: { reason: 'not-a-file' } });
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}
