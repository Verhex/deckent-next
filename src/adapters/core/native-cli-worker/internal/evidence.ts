import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeTextAtomic } from '#platform/index.js';
import type { NativeWorkerEvidenceFile } from '#capabilities/index.js';

/** The CLI sees only its private run dir and login dir, never this host-side state directory. */
export function nativeWorkerEvidenceFile(directory: string, uid: number, bound: number, key: string, kind: 'worker-f08' | 'worker-preflight' = 'worker-f08'): NativeWorkerEvidenceFile {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('NATIVE_WORKER_F08_INVALID');
  const path = join(directory, `${kind}-${key}.json`), lock = `${path}.lock`;
  const safe = (s: Stats) => s.isFile() && s.uid === uid && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= bound;
  const parent = async () => { const s = await lstat(directory);
    if (process.getuid?.() !== uid || constants.O_NOFOLLOW === undefined || await realpath(directory) !== directory
      || !s.isDirectory() || s.uid !== uid || (s.mode & 0o077) !== 0) throw new Error('NATIVE_WORKER_F08_INVALID'); };
  return {
    async read() {
      await parent(); let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!safe(await file.stat())) throw new Error('NATIVE_WORKER_F08_INVALID');
        const bytes = Buffer.alloc(bound + 1), read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > bound) throw new Error('NATIVE_WORKER_F08_INVALID');
        return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')) as unknown;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      finally { await file?.close(); }
    },
    async claim() {
      await parent(); let file;
      try { file = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
      const owned = await file.stat(); await file.sync(); await file.close();
      return { async release() { const current = await lstat(lock);
        if (!safe(current) || current.ino !== owned.ino || current.dev !== owned.dev) throw new Error('NATIVE_WORKER_F08_INVALID'); await unlink(lock); } };
    },
    async write(record) { await parent(); const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > bound) throw new Error('NATIVE_WORKER_F08_INVALID');
      try { if (!safe(await lstat(path))) throw new Error('NATIVE_WORKER_F08_INVALID'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeTextAtomic(path, text);
    },
  };
}
