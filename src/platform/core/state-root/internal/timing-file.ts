import COMMANDS from './timing-commands.json' with { type: 'json' };
import { constants, type Stats } from 'node:fs';
import { mkdir, open, rename, rmdir, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PRODUCT_LAYOUT_REGISTRY } from '#platform/core/common/index.js';
import { resolveGlobalStateRoot } from './state-root.js';
import { openPinnedParent } from '#platform/core/utils/index.js';
import REGISTRY from './timing-registry.json' with { type: 'json' };
import type { TimingRecord } from './timing-trace.js';

const at = (parent: FileHandle, name: string) => `/proc/self/fd/${parent.fd}/${name}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function parentOf(env: NodeJS.ProcessEnv, create: boolean) {
  const found = resolveGlobalStateRoot(env, process.platform);
  if (!found.ok) return null;
  const root = await openPinnedParent(join(found.root, 'unused'));
  if (!root) return null;
  try { const info = await root.stat(); if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) return null; } finally { await root.close(); }
  const path = join(found.root, PRODUCT_LAYOUT_REGISTRY.resources.timingTrace), parent = await openPinnedParent(path, create ? found.root : undefined);
  if (!parent) return null;
  const info = await parent.stat();
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) { await parent.close(); return null; }
  return { parent, name: basename(path) };
}
function safeFile(info: Stats) {
  return info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & REGISTRY.permissionMask) === REGISTRY.fileMode && info.size <= REGISTRY.maxBytes;
}
async function leaf(parent: FileHandle, name: string, write = false) {
  const handle = await open(at(parent, name), (write ? constants.O_RDWR | constants.O_CREAT | constants.O_APPEND : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  if (!safeFile(await handle.stat())) { await handle.close(); throw new Error('unsafe'); }
  return handle;
}
/** A pinned parent and exclusive directory lock serialize all CLI/terminal writers; no stale lock is stolen. Two bounded generations. */
export async function appendTiming(record: TimingRecord, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let held: Awaited<ReturnType<typeof parentOf>> = null, locked = false;
  try {
    const line = encodeRecord(record);
    if (Buffer.byteLength(line) > REGISTRY.maxRecordBytes) return false;
    held = await parentOf(env, true); if (!held) return false;
    const { parent, name } = held, lock = at(parent, `${name}.lock`);
    await mkdir(lock, { mode: 0o700 }); locked = true;
    let handle = await leaf(parent, name, true);
    try {
      if ((await handle.stat()).size + Buffer.byteLength(line) > REGISTRY.maxBytes) {
        await handle.close();
        // rename replaces the archive name itself, never follows an archive link or opens its target.
        await rename(at(parent, name), at(parent, `${name}.1`));
        handle = await leaf(parent, name, true);
      }
      await handle.writeFile(line); return true;
    } finally { await handle.close(); }
  } catch { return false; }
  finally { if (held) { if (locked) await rmdir(at(held.parent, `${held.name}.lock`)).catch(() => undefined); await held.parent.close().catch(() => undefined); } }
}
/** Read only, including while tracing is off; no directory or file creation. Bad or partial lines are ignored by the allowlist reader. */
export async function readTimingFiles(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const held = await parentOf(env, false).catch(() => null); if (!held) return [];
  try {
    const files: string[] = [];
    for (const name of [`${held.name}.1`, held.name]) {
      const handle = await leaf(held.parent, name).catch(error => { if (missing(error)) return null; throw error; });
      if (handle) try {
        const buffer = Buffer.alloc(REGISTRY.maxBytes + 1); let offset = 0;
        while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        if (offset > REGISTRY.maxBytes) return [];
        files.push(buffer.subarray(0, offset).toString('utf8'));
      } finally { await handle.close(); }
    }
    return files;
  } catch { return []; }
  finally { await held.parent.close(); }
}

/** Serialize a fresh allowlisted object even if a JS caller passes extra properties or poisoned labels. */
function encodeRecord(record: TimingRecord): string {
  const finite = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
  const counts: TimingRecord['counts'] = {};
  for (const read of [...REGISTRY.reads, ...REGISTRY.runtimeMethods.map(method => `runtime-request.${method}`)]) for (const cache of REGISTRY.cacheOutcomes) {
    const key = `${read}:${cache}`, value = record.counts[key];
    if (value) counts[key] = { count: Math.floor(finite(value.count)), totalMs: finite(value.totalMs) };
  }
  counts['dropped'] = { count: Math.floor(finite(record.counts['dropped']?.count ?? 0)), totalMs: 0 };
  return JSON.stringify({ schemaVersion: 1, buildId: /^[a-zA-Z0-9.+-]+(?::[a-f0-9]{64})?$/u.test(record.buildId) ? record.buildId : 'unknown',
    traceId: /^[a-f0-9-]{36}$/u.test(record.traceId) ? record.traceId : '00000000-0000-0000-0000-000000000000',
    command: COMMANDS.includes(record.command) ? record.command : 'unknown', phase: REGISTRY.phases.includes(record.phase) ? record.phase : 'finished',
    elapsedMs: finite(record.elapsedMs), counts, cacheOutcome: REGISTRY.cacheOutcomes.includes(record.cacheOutcome) ? record.cacheOutcome : 'none',
    result: REGISTRY.results.includes(record.result) ? record.result : 'unknown' }) + '\n';
}
