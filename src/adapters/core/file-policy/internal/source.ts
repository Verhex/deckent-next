import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { bindingsFileSchema, policyFileSchema, resolvePolicyBindings } from '#domain/index.js';
import type { PolicySource } from '#engine/index.js';
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
export class FilePolicySource implements PolicySource {
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
  private async read(path: string, resource: PolicyFileResource): Promise<unknown> {
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
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
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
}
