import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DeckentError, ErrorRegistry, PRIVATE_PERMISSION_MASK, PrivateFileError, readPrivateFile, withConfigWriteLock } from '#platform/index.js';
import { CORE_SECRET_GRANT_STORE_ID, DECK_FILE, PROJECT_VAULT, assessProjectVaultOwnership, emptySecretGrantFile, projectVaultClaimed, projectVaultHandover,
  projectVaultKey, projectVaultRecordSchema, secretGrantFileSchema, type ProjectVaultAnchor, type ProjectVaultLocation, type ProjectVaultRecord,
  type SecretGrant, type SecretGrantFile, type SecretGrantStoreContext, type SecretGrantStoreFactory } from '#engine/index.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const unsafe = (path: string) => ErrorRegistry.createError('SECRET_STORE_UNSAFE', { params: { path } });

export async function directoryLocation(path: string): Promise<ProjectVaultLocation | null> {
  try {
    const canonicalRoot = await realpath(path), info = await stat(canonicalRoot, { bigint: true });
    return info.isDirectory() && info.ino !== 0n ? { canonicalRoot, device: String(info.dev), inode: String(info.ino) } : null;
  } catch { return null; }
}
/**
 * Astra REVISE 2706 P2-2: the handover's strict observation of the recorded owner's data root. `gone` only when proven: the path does not resolve
 * (ENOENT, ENOTDIR) or it resolves to another directory identity; `present` for the recorded identity; `unknown` for any other error (EACCES, EIO,
 * ELOOP, …) — never read as gone. Other consumers keep `directoryLocation`.
 */
export async function observeOwnerRoot(location: ProjectVaultLocation): Promise<'present' | 'gone' | 'unknown'> {
  const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException | null)?.code));
  try {
    const canonicalRoot = await realpath(location.canonicalRoot), info = await stat(canonicalRoot, { bigint: true });
    return info.isDirectory() && canonicalRoot === location.canonicalRoot && String(info.dev) === location.device && String(info.ino) === location.inode ? 'present' : 'gone';
  } catch (error) { return absent(error) ? 'gone' : 'unknown'; }
}

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
 * a reader never creates anything (absent: null). Not a directory of this user without group or other bits (no getuid: never, owner decision
 * A23) → `SECRET_STORE_UNSAFE`, nothing read. Its real path is not compared (owner B2-18: a linked home folder is accepted as today). */
export async function projectVaultDirectory(globalRoot: string, anchor: ProjectVaultAnchor, prepare: boolean): Promise<string | null> {
  const parent = join(globalRoot, PROJECT_VAULT.directory), directory = join(parent, projectVaultKey(anchor));
  if (prepare) {
    await mkdir(globalRoot, { recursive: true, mode: 0o700 });
    for (const path of [parent, directory]) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  }
  const info = await lstat(directory).catch((error: unknown) => { if (missing(error)) return null; throw unsafe(directory); });
  if (!info) return null;
  if (!info.isDirectory() || (info.mode & PRIVATE_PERMISSION_MASK) !== 0 || info.uid !== process.getuid?.()) throw unsafe(directory);
  return directory;
}

/** One private JSON record of the vault directory (KG12 F1): absent → null; not a private single-link file, too large, changed while read or
 * unreadable → `reason`. */
async function readRecord(path: string, maxBytes: number): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
  try {
    const bytes = await readPrivateFile(path, maxBytes, { mode: 'mask' });
    return { ok: true, value: bytes === null ? null : JSON.parse(bytes.toString('utf8')) as unknown };
  } catch (error) {
    const reason = error instanceof PrivateFileError ? error.reason : null;
    return { ok: false, reason: reason === 'unsafe' ? 'not-private' : reason === 'too-large' ? reason : error instanceof SyntaxError ? 'invalid' : 'unreadable' };
  }
}
/** Owner decision A27: the checked vault folder is kept (no `writeTextAtomic` mkdir); the rename is made durable by the folder's fsync. */
async function writeRecord(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

const recordPath = (directory: string) => join(directory, PROJECT_VAULT.projectFile);
const ownershipLost = (anchor: Pick<ProjectVaultAnchor, 'projectRoot'>) => ErrorRegistry.createError('SECRET_PROJECT_VAULT_OWNERSHIP_LOST', { params: { project: anchor.projectRoot } });
/** The ownership record: `absent` (no file), the parsed record, or `lost` — present but JSON null, unparsable or not a v1 record (never trusted). */
async function loadOwnership(directory: string): Promise<ProjectVaultRecord | 'absent' | 'lost'> {
  const path = recordPath(directory);
  if (!await lstat(path).then(() => true, (error: unknown) => { if (missing(error)) return false; throw unsafe(directory); })) return 'absent';
  const read = await readRecord(path, PROJECT_VAULT.projectMaxBytes);
  if (!read.ok) { if (read.reason === 'invalid') return 'lost'; throw unsafe(directory); }
  const parsed = projectVaultRecordSchema.safeParse(read.value);
  return parsed.success ? parsed.data : 'lost';
}
/** Whether the vault directory holds anything besides an ownership record being written (its lock and temporary): a key, a grant, any file. */
async function vaultHasContent(directory: string): Promise<boolean> {
  const own = PROJECT_VAULT.projectFile;
  return (await readdir(directory)).some(entry => entry !== own && entry !== `${own}.write-lock` && !entry.startsWith(`.${own}.`));
}
/**
 * The ownership check of a vault for the anchor that asks now (law audit BLOCKER). A reader of an existing vault (`claim: false`) only checks;
 * the first writer (`claim: true`) records the anchor under the config write lock. A record of another data root or repository is
 * `SECRET_PROJECT_VAULT_CLAIMED`: a copy never opens the original's vault.
 */
export async function admitProjectVault(directory: string, anchor: ProjectVaultAnchor, claim: boolean, nowMs: number, lockTimeoutMs: number): Promise<void> {
  // Astra REVISE 2702 P1-B: only a truly new EMPTY vault is claimed automatically; a vault with content whose record is missing, null or invalid
  // (a partial restore, a hand edit) is refused for readers and writers alike until an explicit handover — never read, never re-claimed.
  const owned = async () => {
    const record = await loadOwnership(directory);
    if (record === 'lost' || (record === 'absent' && await vaultHasContent(directory))) throw ownershipLost(anchor);
    if (record !== 'absent' && assessProjectVaultOwnership(record, anchor) === 'claimed') throw projectVaultClaimed(anchor);
    return record !== 'absent';
  };
  if (await owned() || !claim) return;
  await withConfigWriteLock(recordPath(directory), async () => {
    if (await owned()) return;
    await writeRecord(recordPath(directory), projectVaultRecordSchema.parse({ schemaVersion: 1, anchor, firstSeenAtMs: nowMs, handedOverAtMs: null }));
  }, lockTimeoutMs);
}
/**
 * Explicit handover after a move: only an INTACT ownership record whose owner's data root is gone (Astra REVISE 2704 A). A lost, absent, null or
 * invalid record is never recovered here (`SECRET_PROJECT_VAULT_OWNERSHIP_LOST`; governed recovery is a beta item). `authorize` decides and seals
 * the handover under the record's write lock BEFORE the new binding is written; when it throws, nothing changes.
 */
export async function handOverProjectVault(directory: string, anchor: ProjectVaultAnchor, nowMs: number, lockTimeoutMs: number,
  authorize: (recorded: ProjectVaultRecord) => Promise<void> | void): Promise<ProjectVaultRecord> {
  return withConfigWriteLock(recordPath(directory), async () => {
    const record = await loadOwnership(directory);
    if (record === 'lost' || record === 'absent') throw ownershipLost(anchor);
    if (assessProjectVaultOwnership(record, anchor) === 'match') return record;
    const owner = await observeOwnerRoot(record.anchor.binding);
    if (owner === 'unknown') throw ErrorRegistry.createError('SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE', { params: { project: record.anchor.projectRoot } });
    const next = projectVaultHandover(record, anchor, owner === 'present', nowMs);
    await authorize(record);
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
    // KG12 F6: only the typed unsafe-vault refusal is listed without a record (as a lost one is today; showing it apart is an owner item).
    const record = await loadOwnership(directory).catch((error: unknown) => { if (error instanceof DeckentError && error.code === 'SECRET_STORE_UNSAFE') return 'unsafe' as const; throw error; });
    rows.push({ directory, record: typeof record === 'string' ? null : record });
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
/** `core.secret-grant.file@1`: `grants.json` beside the project vault, private (this user's single-link file without group or other bits),
 * replaced atomically under the config write lock; an unreadable record is never overwritten. The caller admitted the vault (ownership and
 * private folder) before; the folder is not checked again here (owner B2-18: inventory lists its grants as today). */
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
