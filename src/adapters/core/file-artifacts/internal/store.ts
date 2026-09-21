import { ARTIFACT_STORAGE_LIMITS } from '#platform/index.js';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { ArtifactError, artifactReceiptSchema, type ArtifactReceipt, type ArtifactStore } from '#capabilities/index.js';
const optionsSchema = ARTIFACT_STORAGE_LIMITS.extend({ root: z.string().min(1) }).strict();
export type FileArtifactOptions = z.infer<typeof optionsSchema>;
function digest(bytes: Uint8Array | string) { return createHash('sha256').update(bytes).digest('hex'); }
function missing(error: unknown) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
/** POSIX trusted-host store; managed tree must be outside worker mounts. Preflight is not openat custody. */
export class FileArtifactStore implements ArtifactStore {
  private readonly options: FileArtifactOptions;
  constructor(input: FileArtifactOptions) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.root)) throw new ArtifactError('ARTIFACT_INVALID');
    if (!process.getuid || process.platform === 'win32') throw new ArtifactError('ARTIFACT_UNSUPPORTED');
    this.options = Object.freeze({ ...parsed.data, root: resolve(parsed.data.root) });
  }
  private privateFile(stat: Stats) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new ArtifactError('ARTIFACT_UNSAFE');
  }
  private async directory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) throw new ArtifactError('ARTIFACT_UNSAFE');
  }
  private async scope(scopeId: string, create: boolean) {
    identitySchema.parse(scopeId); await this.directory(this.options.root);
    const directory = join(this.options.root, digest(scopeId));
    if (create) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    } }
    await this.directory(directory); return directory;
  }
  private async syncDirectory(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async read(scopeId: string, input: ArtifactReceipt): Promise<Uint8Array> {
    const receipt = artifactReceiptSchema.parse(input);
    if (scopeId !== receipt.scopeId) throw new ArtifactError('ARTIFACT_SCOPE_DENIED');
    if (receipt.byteLength > this.options.maxBytes) throw new ArtifactError('ARTIFACT_TOO_LARGE');
    const directory = await this.scope(scopeId, false); const path = join(directory, receipt.digest);
    const linked = await lstat(path); this.privateFile(linked);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); this.privateFile(stat);
      if (stat.ino !== linked.ino || stat.dev !== linked.dev) throw new ArtifactError('ARTIFACT_UNSAFE');
      if (stat.size !== receipt.byteLength) throw new ArtifactError('ARTIFACT_CORRUPT');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset !== bytes.length || (await handle.stat()).size !== receipt.byteLength || digest(bytes) !== receipt.digest) throw new ArtifactError('ARTIFACT_CORRUPT');
      return bytes;
    } finally { await handle.close(); }
  }
  /** Trusted composition only: verified immutable bytes plus a file for a single read-only mount.
   * The worker never receives access to the artifact directory. Host filesystem remains trusted. */
  async prepareReadOnlyFile(scopeId: string, receipt: ArtifactReceipt) {
    const bytes = await this.read(scopeId, receipt);
    const path = join(await this.scope(scopeId, false), receipt.digest);
    return Object.freeze({ bytes, path });
  }
  async put(scopeId: string, input: Uint8Array): Promise<ArtifactReceipt> {
    identitySchema.parse(scopeId);
    if (!(input instanceof Uint8Array)) throw new ArtifactError('ARTIFACT_INVALID');
    if (input.byteLength > this.options.maxBytes) throw new ArtifactError('ARTIFACT_TOO_LARGE');
    const bytes = Buffer.from(input); const receipt = artifactReceiptSchema.parse({ schemaVersion: 1, scopeId, digest: digest(bytes), byteLength: bytes.length });
    const directory = await this.scope(scopeId, true); const path = join(directory, receipt.digest);
    try { await this.read(scopeId, receipt); await this.syncDirectory(directory); await this.syncDirectory(this.options.root); return receipt; }
    catch (error) { if (!missing(error)) throw error; }
    const temporary = join(directory, randomUUID());
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path); await this.syncDirectory(directory); await this.syncDirectory(this.options.root);
    } catch (error) {
      // Preserve the primary write/durability failure; a crash or cleanup failure may leave an unreferenced staging file.
      try { await unlink(temporary); } catch { /* No receipt is issued; staged files are not addressable artifacts. */ }
      throw error;
    }
    await this.read(scopeId, receipt); return receipt;
  }
}
