import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { withExclusiveFileLock } from '#adapters/core/file-lock/index.js';
import { isCodedError, ErrorRegistry, writeTextAtomic } from '#platform/index.js';
import type { NativeWorkerEvidenceFile } from '#capabilities/index.js';
const invalid = () => ErrorRegistry.createError('NATIVE_WORKER_F08_INVALID'); // owner B2-11: the registered F08 reason, never a bare Error

/** The CLI sees only its private run dir and login dir, never this host-side state directory. */
export function nativeWorkerEvidenceFile(directory: string, uid: number, bound: number, key: string, kind: 'worker-f08' | 'worker-preflight' = 'worker-f08'): NativeWorkerEvidenceFile {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw invalid();
  const path = join(directory, `${kind}-${key}.json`), lock = `${path}.lock`;
  const safe = (s: Stats) => s.isFile() && s.uid === uid && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= bound;
  const parent = async () => { const s = await lstat(directory);
    if (process.getuid?.() !== uid || constants.O_NOFOLLOW === undefined || await realpath(directory) !== directory
      || !s.isDirectory() || s.uid !== uid || (s.mode & 0o077) !== 0) throw invalid(); };
  return {
    async read() {
      await parent(); let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!safe(await file.stat())) throw invalid();
        const bytes = Buffer.alloc(bound + 1), read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > bound) throw invalid();
        return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')) as unknown;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      finally { await file?.close(); }
    },
    /** Owner 2026-11-09 (B1 12b): the claim is the kernel lock, so a dead holder's claim is released and a live holder's is never taken. */
    async claim() {
      await parent();
      const held = await withExclusiveFileLock(lock, { waitMs: 0, pollMs: 0 }).catch((error: unknown) => {
        throw isCodedError(error, 'LOCAL_RUNTIME_ENDPOINT_UNSAFE') ? invalid() : error; });
      if (!held) return null;
      const owned = await lstat(lock).catch((error: unknown) => { held.release(); throw error; });
      return { async release() { const current = await lstat(lock).finally(() => held.release());
        if (!safe(current) || current.ino !== owned.ino || current.dev !== owned.dev) throw invalid(); } };
    },
    async write(record) { await parent(); const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > bound) throw invalid();
      try { if (!safe(await lstat(path))) throw invalid(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeTextAtomic(path, text);
    },
  };
}
