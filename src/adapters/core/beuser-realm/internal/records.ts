import { constants } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jsonRecordDirectory, type JsonRecordFile } from '#platform/index.js';
import { BeuserContractError } from '#engine/index.js';
import { canonicalRealmPath } from './realm.js';
/** Private, bounded controller metadata. Read-only consumers never create a directory or a record. */
export function beuserPrivateRecord(directory: string, name: string, maxBytes: number): JsonRecordFile {
  const file = jsonRecordDirectory(directory)(name), path = join(directory, `${name}.json`);
  const check = async (create: boolean) => {
    if (create) { await canonicalRealmPath(dirname(directory), 'directory'); await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
    if (!create) {
      await canonicalRealmPath(dirname(directory), 'directory');
      if (!await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return false;
    }
    await canonicalRealmPath(directory, 'directory');
    const root = await lstat(directory);
    if (root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
      || (info.mode & (constants.S_IRWXG | constants.S_IRWXO)) || info.size > maxBytes)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
  };
  return {
    async read() { if (await check(false) === false) return { kind: 'absent' }; return file.read(); },
    async write(value) { if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE'); await check(true); await file.write(value); },
    async remove() { await check(false); await file.remove(); },
  };
}
