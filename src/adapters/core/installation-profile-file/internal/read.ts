import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';

export class InstallationProfileFileError extends Error {
  constructor(readonly code: 'INSTALL_PROFILE_SOURCE_UNAVAILABLE' | 'INSTALL_PROFILE_SOURCE_UNSAFE'
    | 'INSTALL_PROFILE_SOURCE_TOO_LARGE' | 'INSTALL_PROFILE_SOURCE_CHANGED' | 'INSTALL_PROFILE_INVALID') {
    super(code); this.name = 'InstallationProfileFileError';
  }
}
/** Caller-selected, untrusted data. The content digest binds the preview; reading a profile
 * does not authenticate its publisher or grant permission. No mutation or config healing. */
export async function readInstallationProfileFile(path: string, maxBytes: number): Promise<unknown> {
  if (!path || path.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_UNAVAILABLE');
  }
  const source = resolve(path);
  const validate = (stat: BigIntStats) => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_UNSAFE');
    if (stat.size > BigInt(maxBytes)) throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_TOO_LARGE');
  };
  try {
    const linked = await lstat(source, { bigint: true }); validate(linked);
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true }); validate(before);
      if (before.dev !== linked.dev || before.ino !== linked.ino) throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_CHANGED');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) {
        const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!chunk.bytesRead) break;
        offset += chunk.bytesRead;
      }
      const after = await handle.stat({ bigint: true }); validate(after);
      const current = await lstat(source, { bigint: true }); validate(current);
      if (offset !== bytes.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || current.dev !== before.dev || current.ino !== before.ino
        || current.ctimeNs !== after.ctimeNs) throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_CHANGED');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      catch { throw new InstallationProfileFileError('INSTALL_PROFILE_INVALID'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof InstallationProfileFileError) throw error;
    throw new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_UNAVAILABLE');
  }
}
