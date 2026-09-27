import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { bindingsFileSchema, policyFileSchema, resolvePolicyBindings } from '#domain/index.js';
import { PermissionModeError, type PermissionModeBindingsStore, type PermissionModeSnapshot, type PolicySource } from '#engine/index.js';
const optionsSchema = z.object({ path: z.string().min(1), bindingsPath: z.string().min(1).optional(),
  ownerUid: z.number().int().nonnegative().safe(), maxBytes: z.number().int().positive().safe() }).strict();
export type FilePolicyOptions = z.infer<typeof optionsSchema>;
type PolicyFileResource = 'policy' | 'bindings';
export class PolicyFileError extends Error {
  constructor(readonly code: 'POLICY_FILE_INVALID' | 'POLICY_FILE_UNSAFE' | 'POLICY_FILE_TOO_LARGE' | 'POLICY_FILE_CHANGED' | 'POLICY_FILE_UNSUPPORTED'
    | 'POLICY_FILE_MISSING', readonly resource: PolicyFileResource = 'policy') { super(code); this.name = 'PolicyFileError'; }
}
/** Trusted-host authority input, not a caller-selected path. Missing/invalid files never create grants.
 * POSIX preflight; no defense against a privileged host owner. Provision by atomic file replacement.
 * A v2 policy is resolved with its separate bindings file under the same guard (H34 S2); a v1 policy never reads bindings.
 */
/** Updates of one bindings file are serialized in this process (the runtime service is the only product writer: one instance per layout). */
const updates = new Map<string, Promise<void>>();
const sameFile = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
export class FilePolicySource implements PolicySource, PermissionModeBindingsStore {
  private readonly options: FilePolicyOptions;
  constructor(input: FilePolicyOptions) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.path) || (parsed.data.bindingsPath !== undefined && !isAbsolute(parsed.data.bindingsPath))) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (process.platform === 'win32') throw new PolicyFileError('POLICY_FILE_UNSUPPORTED');
    this.options = Object.freeze({ ...parsed.data, path: resolve(parsed.data.path),
      ...(parsed.data.bindingsPath === undefined ? {} : { bindingsPath: resolve(parsed.data.bindingsPath) }) });
  }
  private validate(stat: BigIntStats, resource: PolicyFileResource) {
    const mode = stat.mode & 0o777n;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(this.options.ownerUid) || (mode !== 0o400n && mode !== 0o600n)) throw new PolicyFileError('POLICY_FILE_UNSAFE', resource);
    if (stat.size > BigInt(this.options.maxBytes)) throw new PolicyFileError('POLICY_FILE_TOO_LARGE', resource);
  }
  private async read(path: string, resource: PolicyFileResource): Promise<unknown> { return (await this.readGuarded(path, resource)).value; }
  /** The guarded read and the identity of exactly the bytes read (the conditional write compares it). */
  private async readGuarded(path: string, resource: PolicyFileResource): Promise<{ readonly value: unknown; readonly stat: BigIntStats }> {
    const directory = dirname(path);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.options.ownerUid || (parent.mode & 0o022) !== 0 || await realpath(directory) !== directory) throw new PolicyFileError('POLICY_FILE_UNSAFE', resource);
    const linked = await lstat(path, { bigint: true }); this.validate(linked, resource);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true }); this.validate(before, resource);
      if (before.ino !== linked.ino || before.dev !== linked.dev) throw new PolicyFileError('POLICY_FILE_CHANGED', resource);
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      const after = await handle.stat({ bigint: true }); this.validate(after, resource);
      if (offset !== bytes.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PolicyFileError('POLICY_FILE_CHANGED', resource);
      try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), stat: after }; }
      catch { throw new PolicyFileError('POLICY_FILE_INVALID', resource); }
    } finally { await handle.close(); }
  }
  async load() {
    const parsed = policyFileSchema.safeParse(await this.read(this.options.path, 'policy'));
    if (!parsed.success) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (parsed.data.schemaVersion === 1) return parsed.data;
    const path = this.options.bindingsPath;
    if (path === undefined) throw new PolicyFileError('POLICY_FILE_MISSING', 'bindings');
    let raw: unknown;
    try { raw = await this.read(path, 'bindings'); }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new PolicyFileError('POLICY_FILE_MISSING', 'bindings') : error; }
    const bindings = bindingsFileSchema.safeParse(raw);
    if (!bindings.success) throw new PolicyFileError('POLICY_FILE_INVALID', 'bindings');
    // An unknown role refuses the whole snapshot (PolicyError POLICY_ROLE_UNKNOWN); the policy is never evaluated without its bindings.
    return resolvePolicyBindings(parsed.data, bindings.data);
  }
  /**
   * Conditional, atomic replacement of the bindings file (T-L4 slice 4c, `PermissionModeBindingsStore`). Serialized per file in this
   * process; policy and bindings are read under the same guards as `load`; a document `work` answers is written to a new file in the
   * same directory (`O_EXCL|O_NOFOLLOW`, the original 0400/0600 mode, flushed), and renamed over the target only when both the target
   * and the policy file are still exactly the files read — otherwise `PERMISSION_MODE_CONFLICT`, nothing replaced. The writer must be the trusted owner, so the
   * replaced file stays readable by `load` (a foreign-owned file would refuse all authority).
   */
  async update<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: unknown; readonly result: T }): Promise<T> {
    const target = this.options.bindingsPath;
    if (target === undefined) throw new PolicyFileError('POLICY_FILE_MISSING', 'bindings');
    const previous = updates.get(target) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>(done => { release = done; }));
    updates.set(target, tail);
    await previous;
    try { return await this.updateHeld(target, work); }
    finally { release(); if (updates.get(target) === tail) updates.delete(target); }
  }
  private async updateHeld<T>(target: string, work: (snapshot: PermissionModeSnapshot) => { readonly write: unknown; readonly result: T }): Promise<T> {
    // The policy's identity is kept too: it authorized the change and fixed the effective revision `work` compared (Astra 2139 R1).
    const authority = await this.readGuarded(this.options.path, 'policy');
    const policy = policyFileSchema.safeParse(authority.value);
    if (!policy.success) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (policy.data.schemaVersion === 1) {
      const outcome = work({ policy: policy.data, bindings: null });
      if (outcome.write !== null) throw new PolicyFileError('POLICY_FILE_UNSUPPORTED', 'bindings');
      return outcome.result;
    }
    let read: { readonly value: unknown; readonly stat: BigIntStats };
    try { read = await this.readGuarded(target, 'bindings'); }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new PolicyFileError('POLICY_FILE_MISSING', 'bindings') : error; }
    const outcome = work({ policy: policy.data, bindings: read.value });
    if (outcome.write === null) return outcome.result;
    const bytes = Buffer.from(`${JSON.stringify(bindingsFileSchema.parse(outcome.write), null, 2)}\n`, 'utf8');
    if (bytes.length > this.options.maxBytes) throw new PolicyFileError('POLICY_FILE_TOO_LARGE', 'bindings');
    if (process.getuid?.() !== this.options.ownerUid) throw new PolicyFileError('POLICY_FILE_UNSAFE', 'bindings');
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try {
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
        await handle.chmod(Number(read.stat.mode & 0o777n));
        await handle.sync();
      } finally { await handle.close(); }
      // Conditional on exactly the files read — the bindings written over and the policy that authorized the write: a replacement of
      // either since (another writer, the owner) is a conflict, never overwritten.
      if (!sameFile(await lstat(this.options.path, { bigint: true }), authority.stat) || !sameFile(await lstat(target, { bigint: true }), read.stat)) {
        throw new PermissionModeError('PERMISSION_MODE_CONFLICT');
      }
      await rename(temporary, target);
      renamed = true;
      const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (!renamed) await unlink(temporary).catch(() => undefined); }
    return outcome.result;
  }
}
