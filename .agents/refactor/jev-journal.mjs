// Private local host journal. Exclusive files; no overwrite, no automatic retention/deletion.
import { mkdir, lstat, open, link, unlink, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, parse, sep, join } from 'node:path';
import { ensure } from './jev-context.mjs';
export const callId = () => randomUUID();
export function validateCallId(id) { ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), 'JEV_CALL_ID'); return id; }
export function safeData(data, key) {
  const encoded = JSON.stringify(data);
  ensure((key === undefined || !encoded.includes(key)) && !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(encoded), 'JEV_SECRET_IN_JOURNAL');
  return encoded;
}
export async function privateDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await lstat(current);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'JEV_JOURNAL_PATH');
  }
  const stat = await lstat(absolute);
  ensure(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'JEV_JOURNAL_PERMISSIONS');
  return absolute;
}
export async function writeEvent(directory, name, data, key) {
  ensure(/^[a-z0-9-]+\.json$/.test(name), 'JEV_EVENT_NAME');
  const bytes = safeData(data, key);
  await privateDirectory(directory);
  const temp = join(directory, `.pending-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes + '\n'); await handle.sync();
    await link(temp, join(directory, name)); // atomic publication, fails rather than replacing a prior event
    const dir = await open(directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await handle.close(); await unlink(temp); }
}
export async function readEvent(directory, name) {
  await privateDirectory(directory);
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    ensure(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= 4194304, 'JEV_JOURNAL_FILE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function entries(root, limit) {
  await privateDirectory(root);
  const result = []; let truncated = false;
  for await (const entry of await opendir(root)) {
    if (!entry.isDirectory()) continue;
    validateCallId(entry.name);
    if (result.length === limit) { truncated = true; break; }
    result.push(entry.name);
  }
  return { ids: result, truncated };
}
