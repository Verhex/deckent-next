import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, open, readdir, realpath, unlink, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HUB_LIMITS, HubError, identitySchema } from '#domain/index.js';
import { ArtifactError, type ArtifactReceipt, type ArtifactStore } from '#capabilities/index.js';
import { sha256, withConfigWriteLock } from '#platform/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
const hex = /^[a-f0-9]{64}$/;
const key = (r: ArtifactReceipt) => `${sha256(r.scopeId)}\0${r.digest}`;
/** Dedicated namespace: GC never scans the general artifact store. The trusted host owns this tree. */
export class HubArtifactCache implements ArtifactStore {
  private readonly store: FileArtifactStore;
  private readonly transaction = new AsyncLocalStorage<{ references: () => Promise<readonly ArtifactReceipt[]>; pending: Set<string> }>();
  constructor(readonly root: string, private readonly maxFileBytes: number, private readonly maxBytes = HUB_LIMITS.cacheMaxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HUB_LIMITS.cacheMaxBytes || resolve(root) !== root) throw new ArtifactError('ARTIFACT_INVALID');
    this.store = new FileArtifactStore({ root, maxBytes: maxFileBytes });
  }
  static path(artifactRoot: string) { return join(artifactRoot, 'hub-cache'); }
  private async directory(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || info.mode & 0o022 || await realpath(path) !== path) throw new ArtifactError('ARTIFACT_UNSAFE');
  }
  /** One installation-wide lock spans capacity admission, blob writes and the catalog commit. Never steal a live writer's lock. */
  async withRetention<T>(references: () => Promise<readonly ArtifactReceipt[]>, work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await this.directory(this.root);
    return withConfigWriteLock(join(this.root, 'capacity'), async () => {
      return this.transaction.run({ references, pending: new Set<string>() }, work);
    });
  }
  private async entries() {
    await this.directory(this.root);
    const rows: { path: string; scope: string; digest: string; size: number; atMs: number }[] = [];
    for (const scope of await readdir(this.root)) {
      if (!hex.test(scope)) continue;
      const directory = join(this.root, scope); await this.directory(directory);
      const names = await readdir(directory);
      // Reconcile only this store's crash-left staging hardlink, never an unrelated extra link.
      for (const name of names.filter(name => name.startsWith('.staging.'))) {
        const staged = await lstat(join(directory, name));
        if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 2) continue;
        for (const digest of names.filter(name => hex.test(name))) {
          const linked = await lstat(join(directory, digest));
          if (linked.ino === staged.ino && linked.dev === staged.dev && linked.nlink === 2) { await unlink(join(directory, name)); break; }
        }
      }
      for (const name of await readdir(directory)) {
        // A crashed FileArtifactStore writer may leave staging bytes. They are counted, never mistaken for a verified blob.
        if (!hex.test(name) && !name.startsWith('.staging.')) throw new ArtifactError('ARTIFACT_UNSAFE');
        const path = join(directory, name), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) throw new ArtifactError('ARTIFACT_UNSAFE');
        rows.push({ path, scope, digest: name, size: info.size, atMs: info.atimeMs });
      }
    }
    return rows;
  }
  async put(scopeId: string, input: Uint8Array) {
    const transaction = this.transaction.getStore();
    if (!transaction) throw new ArtifactError('ARTIFACT_UNSAFE');
    // FileArtifactStore validates identity, file bound and raw bytes too; reject before eviction or copying caller buffers.
    identitySchema.parse(scopeId);
    if (!(input instanceof Uint8Array)) throw new ArtifactError('ARTIFACT_INVALID');
    if (input.byteLength > this.maxFileBytes) throw new ArtifactError('ARTIFACT_TOO_LARGE');
    if (input.byteLength > this.maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    const bytes = Buffer.from(input);
    const digest = sha256(bytes), scope = sha256(scopeId), entries = await this.entries();
    const found = entries.find(row => row.scope === scope && row.digest === digest);
    const protectedKeys = new Set((await transaction.references()).map(r => `${sha256(r.scopeId)}\0${r.digest}`));
    for (const value of transaction.pending) protectedKeys.add(value);
    protectedKeys.add(`${scope}\0${digest}`);
    let total = entries.reduce((n, row) => n + row.size, 0) + (found ? 0 : bytes.byteLength);
    const victims = entries.filter(row => !protectedKeys.has(`${row.scope}\0${row.digest}`)).sort((a, b) => a.atMs - b.atMs || a.path.localeCompare(b.path));
    if (total - victims.reduce((n, row) => n + row.size, 0) > this.maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    const evictedDirectories = new Set<string>();
    for (const row of victims) { if (total <= this.maxBytes) break; await unlink(row.path); evictedDirectories.add(dirname(row.path)); total -= row.size; }
    // Persist freed names before publishing new bytes, including victims in another scope's directory.
    for (const directory of evictedDirectories) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const receipt = await this.store.put(scopeId, bytes);
    transaction.pending.add(`${scope}\0${receipt.digest}`);
    await this.touch(scopeId, receipt); return receipt;
  }
  private async touch(scopeId: string, receipt: ArtifactReceipt) {
    const path = join(this.root, sha256(scopeId), receipt.digest), now = new Date();
    await utimes(path, now, (await lstat(path)).mtime);
  }
  async read(scopeId: string, receipt: ArtifactReceipt) {
    const read = async () => { const bytes = await this.store.read(scopeId, receipt); await this.touch(scopeId, receipt); return bytes; };
    // During a write transaction reads cannot race GC; outside it, readers share the capacity lock.
    const transaction = this.transaction.getStore();
    if (transaction) { transaction.pending.add(key(receipt)); return read(); }
    await this.directory(this.root);
    return withConfigWriteLock(join(this.root, 'capacity'), read);
  }
}
