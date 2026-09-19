import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve, sep } from 'node:path';

export type InstallationFileErrorCode = 'INSTALLATION_FILE_CONFLICT' | 'INSTALLATION_FILE_UNSAFE'
  | 'INSTALLATION_FILE_INVALID' | 'INSTALLATION_FILE_UNAVAILABLE' | 'INSTALLATION_FILE_OUTCOME_UNKNOWN'
  | 'INSTALLATION_FILE_UNSUPPORTED';
export class InstallationFileError extends Error {
  constructor(readonly code: InstallationFileErrorCode) { super(code); this.name = 'InstallationFileError'; }
}
export interface InstallationFileRequest { readonly root: string; readonly path: string; readonly maxBytes: number }
export interface InstallationFilePublishRequest extends InstallationFileRequest { readonly transactionId: string }
export interface InstallationFileInspection { readonly digest: string | null }
export interface InstallationFilePublication { readonly digest: string; readonly status: 'published' | 'replayed' }

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function fail(code: InstallationFileErrorCode): never { throw new InstallationFileError(code); }
function unavailable(error: unknown): never {
  if (error instanceof InstallationFileError) throw error;
  throw new InstallationFileError('INSTALLATION_FILE_UNAVAILABLE');
}
function inputs(request: InstallationFileRequest) {
  if (process.platform === 'win32' || !process.getuid) fail('INSTALLATION_FILE_UNSUPPORTED');
  if (!request || typeof request.root !== 'string' || typeof request.path !== 'string'
    || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) fail('INSTALLATION_FILE_INVALID');
  const root = resolve(request.root), path = resolve(request.path), within = relative(root, path);
  if (root === '/' || !within || within === '..' || within.startsWith(`..${sep}`)) fail('INSTALLATION_FILE_INVALID');
  return { root, path, maxBytes: request.maxBytes, uid: BigInt(process.getuid()) };
}
function directorySafe(stat: BigIntStats, uid: bigint, privateCustody: boolean) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateCustody && (stat.uid !== uid || (stat.mode & 0o022n) !== 0n))) fail('INSTALLATION_FILE_UNSAFE');
}
async function syncDirectory(path: string) {
  try { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { unavailable(error); }
}
async function directories(root: string, parent: string, uid: bigint, create: boolean): Promise<boolean> {
  const filesystemRoot = parse(root).root, segments = relative(filesystemRoot, parent).split(sep).filter(Boolean); let cursor = filesystemRoot;
  let createdCustody = false;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const withinRoot = cursor === root || (!relative(root, cursor).startsWith(`..${sep}`) && relative(root, cursor) !== '..');
    try { directorySafe(await lstat(cursor, { bigint: true }), uid, withinRoot || createdCustody); }
    catch (error) {
      if (error instanceof InstallationFileError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(error);
      if (!create) return false;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') unavailable(cause); }
      createdCustody = true;
      try { directorySafe(await lstat(cursor, { bigint: true }), uid, true); await syncDirectory(dirname(cursor)); }
      catch (cause) { unavailable(cause); }
    }
  }
  return true;
}
interface ReadResult { readonly bytes: Buffer; readonly stat: BigIntStats }
async function readStable(path: string, maxBytes: number, uid: bigint, links: readonly bigint[]): Promise<ReadResult | null> {
  let linked: BigIntStats;
  try { linked = await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return unavailable(error); }
  const validate = (stat: BigIntStats) => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || !links.includes(stat.nlink)
      || ![0o400n, 0o600n].includes(stat.mode & 0o777n) || stat.size < 0n || stat.size > BigInt(maxBytes)) fail('INSTALLATION_FILE_UNSAFE');
  };
  validate(linked); let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = await handle.stat({ bigint: true }); validate(opened);
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) fail('INSTALLATION_FILE_UNSAFE');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true }); validate(after); validate(named);
    if (offset !== bytes.length || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size
      || named.mtimeNs !== opened.mtimeNs || named.ctimeNs !== opened.ctimeNs) fail('INSTALLATION_FILE_UNSAFE');
    return { bytes, stat: opened };
  } catch (error) { return unavailable(error); } finally { await handle?.close(); }
}
async function syncExactFile(path: string, identity: BigIntStats, links: readonly bigint[]) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.uid !== identity.uid || opened.dev !== identity.dev || opened.ino !== identity.ino
      || opened.size !== identity.size || opened.mtimeNs !== identity.mtimeNs || opened.ctimeNs !== identity.ctimeNs
      || ![0o400n, 0o600n].includes(opened.mode & 0o777n) || !links.includes(opened.nlink)) fail('INSTALLATION_FILE_CONFLICT');
    await handle.sync(); const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size || named.mtimeNs !== opened.mtimeNs
      || named.ctimeNs !== opened.ctimeNs || !links.includes(named.nlink)) fail('INSTALLATION_FILE_CONFLICT');
  } catch (error) { unavailable(error); } finally { await handle?.close(); }
}
async function removeExactTemporary(path: string, identity: BigIntStats, expectedLinks: bigint) {
  try {
    const named = await lstat(path, { bigint: true });
    if (named.dev !== identity.dev || named.ino !== identity.ino || named.nlink !== expectedLinks) fail('INSTALLATION_FILE_CONFLICT');
    await unlink(path); await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('INSTALLATION_FILE_CONFLICT');
    unavailable(error);
  }
}

export async function inspectInstallationFile(request: InstallationFileRequest): Promise<InstallationFileInspection> {
  const checked = inputs(request); if (!await directories(checked.root, dirname(checked.path), checked.uid, false)) return { digest: null };
  const found = await readStable(checked.path, checked.maxBytes, checked.uid, [1n]);
  return { digest: found ? digest(found.bytes) : null };
}

/** Cooperative fresh-init publisher. The caller owns the durable journal and fixed writer lock;
 * same-UID hostile mutation is outside this adapter's custody guarantee. */
export async function publishInstallationFile(request: InstallationFilePublishRequest, content: string): Promise<InstallationFilePublication> {
  const checked = inputs(request);
  if (typeof request.transactionId !== 'string' || !request.transactionId || request.transactionId.length > 256 || typeof content !== 'string') fail('INSTALLATION_FILE_INVALID');
  if (Buffer.byteLength(content, 'utf8') > checked.maxBytes) fail('INSTALLATION_FILE_INVALID');
  const bytes = Buffer.from(content, 'utf8');
  const targetDigest = digest(bytes), transaction = digest(`deckent.installation-file.v1\n${request.transactionId}\n${checked.path}`);
  const temporary = resolve(dirname(checked.path), `.${basename(checked.path)}.${transaction}.${targetDigest}.installing`);
  await directories(checked.root, dirname(checked.path), checked.uid, true);
  let target = await readStable(checked.path, checked.maxBytes, checked.uid, [1n, 2n]);
  let staged = await readStable(temporary, checked.maxBytes, checked.uid, [1n, 2n]);
  if (target) {
    if (digest(target.bytes) !== targetDigest) fail('INSTALLATION_FILE_CONFLICT');
    if (!staged) { if (target.stat.nlink !== 1n) fail('INSTALLATION_FILE_UNSAFE');
      await syncExactFile(checked.path, target.stat, [1n]); await syncDirectory(dirname(checked.path));
      return { digest: targetDigest, status: 'replayed' }; }
    if (target.stat.dev !== staged.stat.dev || target.stat.ino !== staged.stat.ino || target.stat.nlink !== 2n || staged.stat.nlink !== 2n) fail('INSTALLATION_FILE_UNSAFE');
    await syncExactFile(checked.path, target.stat, [2n]); await syncDirectory(dirname(checked.path));
    try { await removeExactTemporary(temporary, staged.stat, 2n); }
    catch (error) { if (error instanceof InstallationFileError && error.code === 'INSTALLATION_FILE_CONFLICT') throw error;
      throw new InstallationFileError('INSTALLATION_FILE_OUTCOME_UNKNOWN'); }
    return { digest: targetDigest, status: 'replayed' };
  }
  if (staged && staged.stat.nlink !== 1n) fail('INSTALLATION_FILE_UNSAFE');
  if (staged && !bytes.subarray(0, staged.bytes.length).equals(staged.bytes)) fail('INSTALLATION_FILE_CONFLICT');
  if (!staged || staged.bytes.length !== bytes.length) {
    let handle;
    try {
      handle = await open(temporary, staged ? constants.O_WRONLY | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.uid !== checked.uid || opened.nlink !== 1n || (staged && (opened.dev !== staged.stat.dev || opened.ino !== staged.stat.ino))) fail('INSTALLATION_FILE_UNSAFE');
      if (staged) await handle.truncate(0);
      await handle.writeFile(bytes); await handle.sync();
    } catch (error) { unavailable(error); } finally { await handle?.close(); }
    staged = await readStable(temporary, checked.maxBytes, checked.uid, [1n]);
    if (!staged || !staged.bytes.equals(bytes)) fail('INSTALLATION_FILE_UNAVAILABLE');
  }
  await syncExactFile(temporary, staged.stat, [1n]);
  try { await link(temporary, checked.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') unavailable(error);
    target = await readStable(checked.path, checked.maxBytes, checked.uid, [1n]);
    await removeExactTemporary(temporary, staged.stat, 1n);
    if (!target || digest(target.bytes) !== targetDigest) fail('INSTALLATION_FILE_CONFLICT');
    await syncExactFile(checked.path, target.stat, [1n]); await syncDirectory(dirname(checked.path));
    return { digest: targetDigest, status: 'replayed' };
  }
  try { await syncDirectory(dirname(checked.path)); await removeExactTemporary(temporary, staged.stat, 2n); }
  catch (error) { if (error instanceof InstallationFileError && error.code === 'INSTALLATION_FILE_CONFLICT') throw error;
    throw new InstallationFileError('INSTALLATION_FILE_OUTCOME_UNKNOWN'); }
  return { digest: targetDigest, status: 'published' };
}
