import { CodedError, persistedString, persistedInteger } from '#platform/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { bindingsFileSchema, policyFileSchema, resolvePolicyBindings, type AdministrationAssurance, type Policy } from '#domain/index.js';
import { AuthorityChangeError, PermissionModeError, validateAuthorityWrite, type AuthorityDocumentStore, type AuthorityLookup, type AuthorityWrite, type AuthorityRevision, type PermissionModeBindingsStore,
  type PermissionModeSnapshot, type PolicySource } from '#engine/index.js';
import { AuthorityArchive, archiveKeyName } from './archive.js';
const optionsSchema = z.strictObject({ path: persistedString(z.string().min(1)), bindingsPath: persistedString(z.string().min(1)).optional(),
  /** Authority revision archive directory (POLICY-ADMIN P2); absent = writes are not archived and keyed writes are refused. */
  archivePath: persistedString(z.string().min(1)).optional(),
  ownerUid: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), maxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) });
export type FilePolicyOptions = z.infer<typeof optionsSchema>;
type PolicyFileResource = 'policy' | 'bindings' | 'archive';
export class PolicyFileError extends CodedError {
  constructor(override readonly code: 'POLICY_FILE_INVALID' | 'POLICY_FILE_UNSAFE' | 'POLICY_FILE_TOO_LARGE' | 'POLICY_FILE_CHANGED' | 'POLICY_FILE_UNSUPPORTED'
    | 'POLICY_FILE_MISSING', readonly resource: PolicyFileResource = 'policy') { super(code); this.name = 'PolicyFileError'; }
}
/** Authority writes of one installation (keyed by its policy path) are serialized in this process, and across processes by the lock below. */
const updates = new Map<string, Promise<void>>();
/** Cross-process exclusion around one authority write (composition passes the platform's directory lock); absent = this process only. */
export type AuthorityWriteLock = <T>(work: () => Promise<T>) => Promise<T>;
const sameFile = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const snapshots = new Map<string, { readonly digest: string; readonly policy: Policy }>();
const remember = (key: string, snapshot: { readonly digest: string; readonly policy: Policy }) => { snapshots.delete(key); snapshots.set(key, snapshot); if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!); return snapshot.policy; };
/** Trusted-host authority input, not a caller-selected path. Missing/invalid files never create grants. POSIX preflight; no defense against a
 * privileged host owner. Provision by atomic file replacement. A v2 policy is resolved with its separate bindings file under the same guard (H34 S2);
 * a v1 policy never reads bindings. KG5 F1: every `load` does the full guarded read; the parse is reused only while the sha256 of each file read
 * (`policy`, or `policy+bindings`) equals the last snapshot's, never by time: equal bytes are one deep-frozen object, a changed byte a new one. */
export class FilePolicySource implements PolicySource, PermissionModeBindingsStore, AuthorityDocumentStore {
  private readonly options: FilePolicyOptions;
  constructor(input: FilePolicyOptions, private readonly lock: AuthorityWriteLock = work => work(), private readonly assurance?: AdministrationAssurance) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.path) || [parsed.data.bindingsPath, parsed.data.archivePath].some(path => path !== undefined && !isAbsolute(path))) {
      throw new PolicyFileError('POLICY_FILE_INVALID');
    }
    if (process.platform === 'win32') throw new PolicyFileError('POLICY_FILE_UNSUPPORTED');
    this.options = Object.freeze({ ...parsed.data, path: resolve(parsed.data.path),
      ...(parsed.data.bindingsPath === undefined ? {} : { bindingsPath: resolve(parsed.data.bindingsPath) }),
      ...(parsed.data.archivePath === undefined ? {} : { archivePath: resolve(parsed.data.archivePath) }) });
  }
  private validate(stat: BigIntStats, resource: PolicyFileResource) {
    const mode = stat.mode & 0o777n;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(this.options.ownerUid) || (mode !== 0o400n && mode !== 0o600n)) throw new PolicyFileError('POLICY_FILE_UNSAFE', resource);
    if (stat.size > BigInt(this.options.maxBytes)) throw new PolicyFileError('POLICY_FILE_TOO_LARGE', resource);
  }
  /** The guarded read, the identity of exactly the bytes read (the conditional write compares it) and their digest (`load` compares it). */
  private async readGuarded(path: string, resource: PolicyFileResource): Promise<{ readonly value: unknown; readonly stat: BigIntStats; readonly digest: string }> {
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
      try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), stat: after, digest: createHash('sha256').update(bytes).digest('hex') }; }
      catch { throw new PolicyFileError('POLICY_FILE_INVALID', resource); }
    } finally { await handle.close(); }
  }
  async load(): Promise<Policy> {
    const key = this.identity(), known = snapshots.get(key), read = await this.readGuarded(this.options.path, 'policy');
    if (known?.digest === read.digest) return remember(key, known);
    const file = known?.digest.startsWith(`${read.digest}+`) ? null : policyFileSchema.safeParse(read.value);
    if (file?.success === false) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (file?.data.schemaVersion === 1) return remember(key, { digest: read.digest, policy: file.data });
    const raw = await this.readBindings(), digest = `${read.digest}+${raw.digest}`;
    if (known?.digest === digest) return remember(key, known);
    const bindings = bindingsFileSchema.safeParse(raw.value);
    if (!bindings.success) throw new PolicyFileError('POLICY_FILE_INVALID', 'bindings');
    // An unknown role refuses the whole snapshot (PolicyError POLICY_ROLE_UNKNOWN); the policy is never evaluated without its bindings.
    return remember(key, { digest, policy: resolvePolicyBindings(file?.data ?? read.value, bindings.data) });
  }
  private async readBindings() {
    const path = this.options.bindingsPath;
    if (path === undefined) throw new PolicyFileError('POLICY_FILE_MISSING', 'bindings');
    try { return { ...await this.readGuarded(path, 'bindings'), path }; }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new PolicyFileError('POLICY_FILE_MISSING', 'bindings') : error; }
  }
  /** Legacy bindings-only write (T-L4 slice 4c): the same authority writer, keeping its `PERMISSION_MODE_CONFLICT` code. */
  async update<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: unknown; readonly result: T }): Promise<T> {
    try {
      return await this.updateAuthority(snapshot => {
        const outcome = work(snapshot);
        return { write: outcome.write === null ? null : { policy: null, bindings: outcome.write, order: 'policy-first' as const }, result: outcome.result };
      });
    } catch (error) { throw error instanceof AuthorityChangeError ? new PermissionModeError('PERMISSION_MODE_CONFLICT') : error; }
  }
  identity() { return `authority-document:${this.options.path}+${this.options.bindingsPath ?? ''}`; }
  async authorityHistory(): Promise<readonly AuthorityRevision[] | null> {
    const entries = await this.archive()?.history(this.options.maxBytes);
    if (entries === undefined || entries === null) return null;
    try { return entries.map(entry => {
      const before = resolvePolicyBindings(entry.before.policy, entry.before.bindings), after = resolvePolicyBindings(entry.after.policy, entry.after.bindings);
      if (before.revision !== entry.before.revision || after.revision !== entry.after.revision) throw new Error('AUTHORITY_HISTORY_INVALID');
      return { key: entry.key, before, after };
    }); }
    catch { return null; }
  }
  private archive() {
    const path = this.options.archivePath;
    return path === undefined ? null : new AuthorityArchive(path, this.options.ownerUid, () => new PolicyFileError('POLICY_FILE_UNSAFE', 'archive'));
  }
  /**
   * Conditional, atomic replacement of policy.json and/or bindings.json (POLICY-ADMIN P2, `AuthorityDocumentStore`; T-L4 slice 4c for
   * bindings alone). Serialized per installation in this process; both files are read under the same guards as `load`; each document
   * `work` answers is written to a new file in its directory (`O_EXCL|O_NOFOLLOW`, the original 0400/0600 mode, flushed). Before each
   * rename every authority file must still be exactly the file read — or, once renamed by this call, exactly the file it wrote —
   * otherwise `POLICY_CONFLICT` (a failure after the first rename leaves that valid intermediate state and a `prepared` archive record:
   * the keyed lookup then answers unknown, never a blind resend). The writer must be the trusted owner, so `load` keeps reading them.
   */
  async updateAuthority<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: AuthorityWrite | null; readonly result: T }, key?: string): Promise<T> {
    const lane = this.options.path;
    const previous = updates.get(lane) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>(done => { release = done; }));
    updates.set(lane, tail);
    await previous;
    // Across processes the injected lock orders writers: the identity checks alone leave a check-to-rename window (lost updates were
    // measured without it, POLICY-ADMIN P2); they stay as the guard against a writer that takes no lock (a manual edit).
    try { return await this.lock(() => this.updateHeld(work, key)); }
    finally { release(); if (updates.get(lane) === tail) updates.delete(lane); }
  }
  private async updateHeld<T>(work: (snapshot: PermissionModeSnapshot) => { readonly write: AuthorityWrite | null; readonly result: T }, key?: string): Promise<T> {
    // The policy's identity is kept even when only bindings change: it authorized the change and fixed the compared revision (Astra 2139 R1).
    const authority = await this.readGuarded(this.options.path, 'policy');
    const policy = policyFileSchema.safeParse(authority.value);
    if (!policy.success) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (policy.data.schemaVersion === 1) {
      const outcome = work({ policy: policy.data, bindings: null });
      if (outcome.write !== null) throw new PolicyFileError('POLICY_FILE_UNSUPPORTED', 'bindings');
      return outcome.result;
    }
    const read = await this.readBindings();
    const outcome = work({ policy: policy.data, bindings: read.value });
    const write = outcome.write;
    if (write === null || (write.policy === null && write.bindings === null)) return outcome.result;
    validateAuthorityWrite({ policy: policy.data, bindings: read.value }, write, this.assurance);
    const bindings = bindingsFileSchema.parse(read.value);
    const files = [
      { resource: 'policy' as const, path: this.options.path, stat: authority.stat, before: policy.data, next: write.policy === null ? null : policyFileSchema.parse(write.policy) },
      { resource: 'bindings' as const, path: read.path, stat: read.stat, before: bindings, next: write.bindings === null ? null : bindingsFileSchema.parse(write.bindings) },
    ];
    if (write.order === 'bindings-first') files.reverse();
    const archive = this.archive();
    if (key !== undefined && archive === null) throw new PolicyFileError('POLICY_FILE_MISSING', 'archive');
    if (process.getuid?.() !== this.options.ownerUid) throw new PolicyFileError('POLICY_FILE_UNSAFE', 'bindings');
    const revision = (policyDocument: { readonly revision: string }, bindingsDocument: { readonly revision: string }) => `${policyDocument.revision}+${bindingsDocument.revision}`;
    const side = (policyDocument: { readonly revision: string }, bindingsDocument: { readonly revision: string }) => ({ revision: revision(policyDocument, bindingsDocument), policy: policyDocument, bindings: bindingsDocument });
    const before = side(policy.data, bindings);
    const after = side(files.find(file => file.resource === 'policy')!.next ?? policy.data, files.find(file => file.resource === 'bindings')!.next ?? bindings);
    const entryName = key !== undefined ? archiveKeyName(key) : `r-${createHash('sha256').update(`${before.revision}\0${after.revision}`).digest('hex').slice(0, 32)}.json`;
    write.beforePublish?.();
    const temporaries = new Map<string, string>();
    try {
      for (const file of files) {
        if (file.next === null) continue;
        const bytes = Buffer.from(`${JSON.stringify(file.next, null, 2)}\n`, 'utf8');
        if (bytes.length > this.options.maxBytes) throw new PolicyFileError('POLICY_FILE_TOO_LARGE', file.resource);
        const temporary = join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.tmp`);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaries.set(file.path, temporary);
        try {
          let offset = 0;
          while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
          await handle.chmod(Number(file.stat.mode & 0o777n));
          await handle.sync();
        } finally { await handle.close(); }
      }
      const expected = new Map(files.map(file => [file.path, file.stat]));
      const unchanged = async () => {
        for (const [path, stat] of expected) if (!sameFile(await lstat(path, { bigint: true }), stat)) throw new AuthorityChangeError('POLICY_CONFLICT');
      };
      await unchanged();
      await archive?.write(entryName, { schemaVersion: 1, key: key ?? null, state: 'prepared', before, after });
      let renamed = false;
      for (const file of files) {
        const temporary = temporaries.get(file.path);
        if (temporary === undefined) continue;
        try { await unchanged(); } catch (error) {
          // Nothing of this write reached the files: drop its prepared record. After a rename the valid intermediate state stays, reported
          // as `partial` (its keyed lookup answers unknown).
          if (!renamed) await archive?.remove(entryName);
          throw renamed ? new AuthorityChangeError('POLICY_CONFLICT', 'partial') : error;
        }
        await rename(temporary, file.path);
        renamed = true;
        temporaries.delete(file.path);
        expected.set(file.path, await lstat(file.path, { bigint: true }));
        const directory = await open(dirname(file.path), constants.O_RDONLY | constants.O_DIRECTORY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await archive?.write(entryName, { schemaVersion: 1, key: key ?? null, state: 'committed', before, after });
    } finally { for (const temporary of temporaries.values()) await unlink(temporary).catch(() => undefined); }
    return outcome.result;
  }
  /**
   * The C11 evidence of a keyed authority write: a committed record → applied; a prepared record → applied when the files now hold its
   * `after` revision, absent when they still hold its `before` revision (nothing was renamed; the resend is safe), otherwise unknown
   * (a crash between the two renames or a later change: never a blind resend); no record → absent; an untrustworthy record → unknown.
   */
  async lookupAuthority(key: string): Promise<AuthorityLookup> {
    const archive = this.archive();
    if (archive === null) return null;
    const entry = await archive.read(key);
    if (entry === 'missing') return { status: 'absent' };
    if (entry === null) return null;
    if (entry.state === 'committed') return { status: 'applied', version: entry.after.revision };
    const current = await this.load().then(policy => policy.revision, () => null);
    return current === null ? null : current === entry.after.revision ? { status: 'applied', version: current } : current === entry.before.revision ? { status: 'absent' } : null;
  }
}
