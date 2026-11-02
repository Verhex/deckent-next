import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorRegistry } from '#platform/index.js';
const views = new AsyncLocalStorage<{ maximum: number; copies: Map<string, string>; directories: string[] }>();
/** Preview-only: no SQLite open touches source sidecars. Normal invocation keeps its existing live read path. */
export async function withSideEffectFreeSqliteReads<T>(maximum: number, work: () => Promise<T>) {
  const view = { maximum, copies: new Map<string, string>(), directories: [] as string[] };
  try { return await views.run(view, work); } finally { for (const directory of view.directories) rmSync(directory, { recursive: true, force: true }); }
}
export function openReadOnlySqlite(path: string, timeout: number): DatabaseSync {
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const view = views.getStore(); if (!view) return new NativeDatabase(path, { readOnly: true, timeout });
  const cached = view.copies.get(path); if (cached) return new NativeDatabase(cached, { readOnly: true, timeout });
  const stat = (file: string) => { try { const item = lstatSync(file, { bigint: true });
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || item.uid !== BigInt(process.getuid?.() ?? -1) || (item.mode & 0o022n) !== 0n) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
    return { stamp: [item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs, item.mode, item.nlink].join(':'), size: item.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  if (stat(`${path}-journal`)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
  const files = ['', '-wal'].map(suffix => ({ suffix, before: stat(path + suffix) }));
  if (files.reduce((sum, item) => sum + (item.before?.size ?? 0n), 0n) > BigInt(view.maximum)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_READ_LIMIT', { params: { limit: view.maximum } });
  const directory = mkdtempSync(join(tmpdir(), 'deckent-sqlite-view-')), copy = join(directory, 'read.db');
  view.directories.push(directory);
  try {
    for (const item of files) if (item.before) copyFileSync(path + item.suffix, copy + item.suffix);
    if (files.some(item => stat(path + item.suffix)?.stamp !== item.before?.stamp) || stat(`${path}-journal`)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
    view.copies.set(path, copy); return new NativeDatabase(copy, { readOnly: true, timeout });
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
