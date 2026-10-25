import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import limits from './session-title-limits.json' with { type: 'json' };

const originSchema = z.object({ schemaVersion: z.literal(1), principal: z.object({ issuer: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict(),
  folder: z.string().max(4096).refine(value => value === '' || (!value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'))) }).strict();
export type TerminalSessionOrigin = z.infer<typeof originSchema>;
export type TerminalSessionFilter = Readonly<{ principal?: TerminalSessionOrigin['principal']; folder?: string; allFolders?: boolean }>;

/** undefined = legacy (absent); null = present but unreadable/unsafe. Neither is authority. */
export async function readSessionOrigin(path: string): Promise<TerminalSessionOrigin | null | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; }
  try {
    const stat = await handle.stat();
    const modeMask = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO, privateMode = constants.S_IRUSR | constants.S_IWUSR;
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1 || (stat.mode & modeMask) !== privateMode || stat.size > limits.originFileMaxBytes) return null;
    const parsed = originSchema.safeParse(JSON.parse(await handle.readFile({ encoding: 'utf8' })));
    return parsed.success ? parsed.data : null;
  } catch { return null; } finally { await handle.close(); }
}

/** Publish once, before a new snapshot; resuming from another folder never changes where a conversation began. */
export async function writeSessionOrigin(path: string, origin: TerminalSessionOrigin): Promise<void> {
  const body = JSON.stringify(originSchema.parse(origin)), temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body); await handle.sync(); await handle.close();
    try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await handle.close(); await unlink(temporary); }
}

export async function sessionOriginMatches(path: string, filter: TerminalSessionFilter | undefined): Promise<boolean> {
  if (!filter) return true;
  const origin = await readSessionOrigin(`${path}${limits.originSuffix}`);
  if (origin === null) return false;
  if (origin === undefined) {
    // Legacy snapshots belong to the OS file owner and start at the project root.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) return false;
    try { const stat = await handle.stat(); return (!filter.principal || String(stat.uid) === filter.principal.subject) && (!filter.folder || filter.allFolders === true); }
    finally { await handle.close(); }
  }
  return (!filter.principal || origin.principal.subject === filter.principal.subject) && (filter.folder === undefined || filter.allFolders === true || origin.folder === filter.folder);
}
