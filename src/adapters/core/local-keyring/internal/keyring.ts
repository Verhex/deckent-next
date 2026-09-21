import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ErrorRegistry, inspectProductDirectory, prepareProductDirectory, createHmacIntegrity, sha256, type ProductLayout } from '#platform/index.js';

/** Private local key custody, not an OS keyring. The directory must remain outside worker mounts. */
export async function openLocalIntegrityAuthority(layout: ProductLayout, filename: string, create = false) {
  try {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) throw new Error('name');
    const directory = create ? await prepareProductDirectory(layout, 'approvals') : await inspectProductDirectory(layout, 'approvals');
    const path = join(directory, filename); let handle; let created = false;
    try {
      handle = await open(path, create ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
      created = create;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const info = await handle.stat(); const linked = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
        || linked.isSymbolicLink() || linked.ino !== info.ino || linked.dev !== info.dev) throw new Error('custody');
      if (created) {
        const material = randomBytes(32);
        try { await handle.writeFile(material); await handle.sync(); } finally { material.fill(0); }
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      }
      if ((await handle.stat()).size !== 32) throw new Error('size');
      const material = Buffer.alloc(32);
      try {
        if ((await handle.read(material, 0, 32, 0)).bytesRead !== 32) throw new Error('read');
        return createHmacIntegrity(sha256(material.toString('hex')), material);
      } finally { material.fill(0); }
    } finally { await handle.close(); }
  } catch { throw ErrorRegistry.createError('INTEGRITY_KEY_UNAVAILABLE'); }
}
