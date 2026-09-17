import { lstat, open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ErrorRegistry } from '#platform/core/errors/index.js';

export type JsonRecord = Record<string, unknown>;
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
}
export function assertSafeKeys(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertSafeKeys); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw ErrorRegistry.createError('CONFIG_UNSAFE_KEY');
    assertSafeKeys(child);
  }
}
export function deepMerge<T>(base: T, override: Partial<T>): T {
  assertSafeKeys(base); assertSafeKeys(override);
  const out = structuredClone(base) as JsonRecord;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isRecord(out[key]) && isRecord(value) ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out as T;
}
export function digestText(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export type JsonRead = { kind: 'absent' } | { kind: 'corrupt'; text: string; digest: string }
  | { kind: 'ready'; value: unknown; text: string; digest: string } | { kind: 'io'; error: unknown };
export async function readJsonFile(path: string): Promise<JsonRead> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024) return { kind: 'io', error: ErrorRegistry.createError('CONFIG_READ_IO_HOLD') };
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev) return { kind: 'io', error: ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD') };
    const text = await handle.readFile('utf8');
    const digest = digestText(text);
    try { return { kind: 'ready', value: JSON.parse(text) as unknown, text, digest }; }
    catch { return { kind: 'corrupt', text, digest }; }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'io', error };
  } finally { await handle?.close(); }
}
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, (_key, item: unknown) => item === undefined ? null : item, 2)}\n`);
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, path);
    if (process.platform !== 'win32') { const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
