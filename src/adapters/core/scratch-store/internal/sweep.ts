import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCRATCH_VIEW_MAX_FILES } from '#domain/index.js';
import { SCRATCH_WALK_MAX_DEPTH, SCRATCH_WALK_MAX_ENTRIES, scratchUsage, type ScratchLimits } from './area.js';

const PART = /^[0-9a-f]{32}$/u;
const DAY_MS = 86_400_000;

/**
 * Areas in use by running turns (service-owned, in memory): a held area is never swept, whatever its age. `hold` returns the release;
 * holds are counted, so two turns of one conversation keep it until both end.
 */
export interface ScratchActivity { hold(key: string): () => void; has(key: string): boolean }
export function createScratchActivity(): ScratchActivity {
  const held = new Map<string, number>();
  return Object.freeze({
    hold(key: string) {
      held.set(key, (held.get(key) ?? 0) + 1);
      let released = false;
      return () => { if (released) return; released = true; const left = (held.get(key) ?? 1) - 1; if (left > 0) held.set(key, left); else held.delete(key); };
    },
    has: (key: string) => held.has(key),
  });
}

/** Newest modification time in a tree (the directory itself included; lstat, links never followed); null past the walk bounds. */
async function newestChange(dir: string): Promise<number | null> {
  let newest = (await lstat(dir)).mtimeMs, entries = 0;
  const walk = async (path: string, depth: number): Promise<boolean> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (++entries > SCRATCH_WALK_MAX_ENTRIES) return false;
      const child = join(path, entry.name), info = await lstat(child).catch(() => null);
      if (!info) continue;
      newest = Math.max(newest, info.mtimeMs);
      if (info.isDirectory() && (depth + 1 > SCRATCH_WALK_MAX_DEPTH || !await walk(child, depth + 1))) return false;
    }
    return true;
  };
  return await walk(dir, 0) ? newest : null;
}

export interface ScratchSweepResult { readonly removedSessions: number; readonly removedBytes: number; readonly kept: number; readonly unreadable: number }

/**
 * Retention of the scratch resource `root` (S4): a session area whose newest change is older than `retentionDays` is removed, unless a
 * running turn holds it; an owner directory left empty goes with it. Only `<32 hex>/<32 hex>` directories are areas; anything else
 * (a stray file, a link) is left alone and not followed. An area too large to measure within the walk bounds is kept (never removed
 * on a guess) and counted as unreadable. The caller runs this under endpoint custody (service start) or from the running service.
 */
export async function sweepScratch(root: string, limits: Pick<ScratchLimits, 'retentionDays'>, now: number, active: Pick<ScratchActivity, 'has'>): Promise<ScratchSweepResult> {
  let removedSessions = 0, removedBytes = 0, kept = 0, unreadable = 0;
  const cutoff = now - limits.retentionDays * DAY_MS;
  for (const owner of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!owner.isDirectory() || !PART.test(owner.name)) continue;
    const ownerDir = join(root, owner.name);
    for (const session of await readdir(ownerDir, { withFileTypes: true }).catch(() => [])) {
      if (!session.isDirectory() || !PART.test(session.name)) continue;
      const key = `${owner.name}/${session.name}`, dir = join(ownerDir, session.name);
      if (active.has(key)) { kept++; continue; }
      const [newest, bytes] = await Promise.all([newestChange(dir).catch(() => null), scratchUsage(dir)]);
      if (newest === null) { unreadable++; continue; }
      // Asked again right before removal: a turn that started while the area was measured holds it now.
      if (newest >= cutoff || active.has(key)) { kept++; continue; }
      await rm(dir, { recursive: true, force: true });
      removedSessions++; removedBytes += bytes ?? 0;
    }
    await rmdir(ownerDir).catch(() => undefined);
  }
  return Object.freeze({ removedSessions, removedBytes, kept, unreadable });
}

/** The periodic sweep of a running service (every `sweepIntervalMs`, unreferenced so it never holds the process), stopped by `signal`. */
export function startScratchSweeper(input: { readonly root: () => Promise<string | null>; readonly limits: Pick<ScratchLimits, 'retentionDays' | 'sweepIntervalMs'>;
  readonly active: Pick<ScratchActivity, 'has'>; readonly signal: AbortSignal; readonly now?: () => number;
  readonly onSweep?: (result: ScratchSweepResult) => void; readonly onError?: (error: unknown) => void }): void {
  if (input.signal.aborted) return;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void input.root().then(root => root === null ? null : sweepScratch(root, input.limits, (input.now ?? Date.now)(), input.active))
      .then(result => { if (result && (result.removedSessions || result.unreadable)) input.onSweep?.(result); }, error => input.onError?.(error))
      .finally(() => { running = false; });
  }, input.limits.sweepIntervalMs);
  timer.unref();
  input.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

export interface ScratchContents {
  readonly path: string; readonly exists: boolean; readonly bytes: number; readonly truncated: boolean;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly modifiedAtMs: number }[];
}
/** What the person's own session area holds (for `/scratch`): regular files by path (links are listed as nothing and never followed),
 * newest first, at most `maxFiles`; `bytes` is the whole area's usage. */
export async function inspectScratchSession(root: string, key: string, maxFiles = SCRATCH_VIEW_MAX_FILES): Promise<ScratchContents> {
  const dir = join(root, ...key.split('/'));
  const exists = await lstat(dir).then(info => info.isDirectory(), () => false);
  const files: { path: string; bytes: number; modifiedAtMs: number }[] = [];
  let entries = 0, truncated = false;
  const walk = async (path: string, rel: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > SCRATCH_WALK_MAX_ENTRIES) { truncated = true; return; }
      const child = join(path, entry.name), childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth + 1 <= SCRATCH_WALK_MAX_DEPTH) await walk(child, childRel, depth + 1); else truncated = true; }
      else if (entry.isFile()) { const info = await lstat(child).catch(() => null); if (info) files.push({ path: childRel, bytes: info.size, modifiedAtMs: Math.floor(info.mtimeMs) }); }
    }
  };
  if (exists) await walk(dir, '', 0);
  files.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.path.localeCompare(b.path));
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return Object.freeze({ path: dir, exists, bytes, truncated: truncated || files.length > maxFiles, files: Object.freeze(files.slice(0, maxFiles)) });
}

/** Empties the person's own session area (`/scratch clear`): its content goes, the directory stays (a shell's TMPDIR keeps existing). */
export async function clearScratchSession(root: string, key: string): Promise<{ readonly path: string; readonly removedFiles: number; readonly removedBytes: number }> {
  const view = await inspectScratchSession(root, key, Number.MAX_SAFE_INTEGER);
  if (view.exists) for (const entry of await readdir(view.path)) await rm(join(view.path, entry), { recursive: true, force: true });
  return Object.freeze({ path: view.path, removedFiles: view.files.length, removedBytes: view.bytes });
}
