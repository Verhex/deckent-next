import { openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, constants } from 'node:fs';
import { join } from 'node:path';
const fail = () => { throw new Error('WORKER_HISTORY_IDS'); };
/** One bounded history reader for the allocator and final guard, including adopted, failed and archived receipts. Unsafe/incomplete data refuses. */
export function retainedWorkerHistory(directory, daemonId, bounds) {
  let visited = 0;
  const versions = [];
  try { if (!lstatSync(directory).isDirectory()) fail(); } catch (error) { if (error.code === 'ENOENT') return versions; throw error; }
  const scan = (path, depth) => {
    let entries;
    try { entries = readdirSync(path); } catch (error) { if (error.code === 'ENOENT' && depth === 0) return; throw error; }
    for (const name of entries) {
      if (++visited > bounds.files || depth > 8) fail();
      const file = join(path, name), info = lstatSync(file);
      if (info.isDirectory()) { scan(file, depth + 1); continue; }
      if (!/\.json(?:\.failed-\d+)?$/.test(name)) { if (info.isSymbolicLink()) fail(); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.size > bounds.bytes) fail();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value;
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > bounds.bytes) fail();
        value = JSON.parse(readFileSync(fd, 'utf8'));
      } finally { closeSync(fd); }
      if (![2, 3].includes(value.schemaVersion) || typeof value.daemonId !== 'string'
        || !/^r[1-9][0-9]*-\d{8}$/.test(value.imageVersion ?? '')) fail();
      if (value.daemonId !== daemonId) continue;
      const ids = [value.imageVersion, ...(value.history ?? []).map(entry => entry.id)];
      if (!ids.every(id => /^r[1-9][0-9]*-\d{8}$/.test(id))) fail();
      if (versions.length + ids.length > bounds.files) fail();
      versions.push(...ids);
    }
  };
  scan(directory, 0); return versions;
}
