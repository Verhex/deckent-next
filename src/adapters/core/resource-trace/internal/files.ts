import { constants } from 'node:fs';
import { open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/index.js';
import { resourceSampleSchema, type ResourceSample } from '#engine/index.js';
import type { ResourceObservationSettings } from '#platform/index.js';
export const trimSchema = z.object({ identity: attemptIdentitySchema, throughMs: z.number().int().nonnegative().safe() }).strict();
export type Trim = z.infer<typeof trimSchema>;
const legacySchema = z.object({ schemaVersion: z.literal(1), trimmedBeforeMs: z.number().int().nonnegative().safe().nullable(),
  lastTrim: trimSchema.nullable().optional(), samples: z.array(resourceSampleSchema) }).strict();
const headerSchema = z.object({ schemaVersion: z.literal(2), createdAtMs: z.number().int().nonnegative().safe() }).strict();
const checkpointSchema = z.object({ schemaVersion: z.literal(2), lastTrim: trimSchema.nullable() }).strict();
export interface Segment { path: string; name: string; bytes: number; dev: number; ino: number; createdAtMs: number;
  samples: ResourceSample[]; damaged: boolean; legacy: boolean; lastTrim: Trim | null }
export async function privateFile(path: string, writable = false): Promise<FileHandle> {
  const file = await open(path, (writable ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error('RESOURCE_TRACE_UNSAFE');
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function contents(path: string, limit: number) {
  const file = await privateFile(path);
  try { const stat = await file.stat();
    if (stat.size > limit) throw new Error('RESOURCE_TRACE_TOO_LARGE');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('RESOURCE_TRACE_CHANGED'); offset += read.bytesRead; }
    return { stat, text: bytes.toString('utf8') };
  } finally { await file.close(); }
}
export async function segments(path: string, settings: ResourceObservationSettings): Promise<Segment[]> {
  const prefix = `${path.split('/').at(-1)!}.segment-`, names: string[] = [];
  const directory = await opendir(dirname(path));
  for await (const entry of directory) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!/^\d{16}-[a-f0-9-]{36}\.jsonl$/.test(entry.name.slice(prefix.length))) throw new Error('RESOURCE_TRACE_UNSAFE');
    names.push(entry.name);
    if (names.length > settings.maxStoreEntries + 1) throw new Error('RESOURCE_TRACE_TOO_LARGE');
  }
  names.sort(); const result: Segment[] = [];
  try { const { stat, text } = await contents(path, settings.maxStoreBytes), legacy = legacySchema.parse(JSON.parse(text));
    if (legacy.samples.length > settings.maxStoreEntries) throw new Error('RESOURCE_TRACE_TOO_LARGE');
    result.push({ path, name: '', bytes: stat.size, dev: stat.dev, ino: stat.ino, createdAtMs: 0, samples: legacy.samples,
      damaged: false, legacy: true, lastTrim: legacy.lastTrim ?? null });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let total = result.reduce((sum, row) => sum + row.bytes, 0), entries = result.reduce((sum, row) => sum + row.samples.length, 0);
  for (const name of names) {
    const target = join(dirname(path), name), { stat, text } = await contents(target, Math.min(settings.segmentMaxBytes, settings.maxStoreBytes));
    total += stat.size;
    if (total > settings.maxStoreBytes) throw new Error('RESOURCE_TRACE_TOO_LARGE');
    const lines = text.split('\n'), tail = lines.pop()!; let damaged = tail.length > 0 || text.length === 0;
    let createdAtMs = 0;
    if (lines.length) createdAtMs = headerSchema.parse(JSON.parse(lines.shift()!)).createdAtMs;
    const samples: ResourceSample[] = [];
    for (const line of lines) {
      try { samples.push(resourceSampleSchema.parse(JSON.parse(line))); }
      catch { damaged = true; }
    }
    entries += samples.length;
    if (entries > settings.maxStoreEntries || samples.length > settings.segmentMaxEntries) throw new Error('RESOURCE_TRACE_TOO_LARGE');
    result.push({ path: target, name, bytes: stat.size, dev: stat.dev, ino: stat.ino, createdAtMs, samples, damaged, legacy: false, lastTrim: null });
  }
  return result;
}
export function checkpointContent(lastTrim: Trim | null) { return JSON.stringify({ schemaVersion: 2, lastTrim }) + '\n'; }
export async function checkpoint(path: string, limit: number): Promise<{ lastTrim: Trim | null; bytes: number }> {
  try { const { text, stat } = await contents(`${path}.trim`, limit);
    return { lastTrim: checkpointSchema.parse(JSON.parse(text)).lastTrim, bytes: stat.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lastTrim: null, bytes: 0 }; throw error; }
}
export async function publishTrim(path: string, content: string, directory: FileHandle) {
  const temporary = `${path}.trim.pending`;
  // One known staging file: reclaim only this private regular file under the writer lock.
  // A crash cannot accumulate an unbounded set of random checkpoint temporaries.
  try { const previous = await privateFile(temporary); await previous.close(); await unlink(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, `${path}.trim`);
    await directory.sync();
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
export function header(createdAtMs: number) { return JSON.stringify({ schemaVersion: 2, createdAtMs }) + '\n'; }
