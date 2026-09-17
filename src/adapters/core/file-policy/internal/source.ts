import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { policySchema } from '#domain/index.js';
import type { PolicySource } from '#engine/index.js';
const optionsSchema = z.object({ path: z.string().min(1), ownerUid: z.number().int().nonnegative().safe(), maxBytes: z.number().int().positive().safe() }).strict();
export type FilePolicyOptions = z.infer<typeof optionsSchema>;
export class PolicyFileError extends Error {
  constructor(readonly code: 'POLICY_FILE_INVALID' | 'POLICY_FILE_UNSAFE' | 'POLICY_FILE_TOO_LARGE' | 'POLICY_FILE_CHANGED' | 'POLICY_FILE_UNSUPPORTED') { super(code); this.name = 'PolicyFileError'; }
}
/** Trusted-host authority input, not a caller-selected path. Missing/invalid files never create grants.
 * POSIX preflight; no defense against a privileged host owner. Provision by atomic file replacement.
 */
export class FilePolicySource implements PolicySource {
  private readonly options: FilePolicyOptions;
  constructor(input: FilePolicyOptions) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.path)) throw new PolicyFileError('POLICY_FILE_INVALID');
    if (process.platform === 'win32') throw new PolicyFileError('POLICY_FILE_UNSUPPORTED');
    this.options = Object.freeze({ ...parsed.data, path: resolve(parsed.data.path) });
  }
  private validate(stat: BigIntStats) {
    const mode = stat.mode & 0o777n;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(this.options.ownerUid) || (mode !== 0o400n && mode !== 0o600n)) throw new PolicyFileError('POLICY_FILE_UNSAFE');
    if (stat.size > BigInt(this.options.maxBytes)) throw new PolicyFileError('POLICY_FILE_TOO_LARGE');
  }
  async load() {
    const path = this.options.path; const directory = dirname(path);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.options.ownerUid || (parent.mode & 0o022) !== 0 || await realpath(directory) !== directory) throw new PolicyFileError('POLICY_FILE_UNSAFE');
    const linked = await lstat(path, { bigint: true }); this.validate(linked);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true }); this.validate(before);
      if (before.ino !== linked.ino || before.dev !== linked.dev) throw new PolicyFileError('POLICY_FILE_CHANGED');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      const after = await handle.stat({ bigint: true }); this.validate(after);
      if (offset !== bytes.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PolicyFileError('POLICY_FILE_CHANGED');
      try { return policySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
      catch { throw new PolicyFileError('POLICY_FILE_INVALID'); }
    } finally { await handle.close(); }
  }
}
