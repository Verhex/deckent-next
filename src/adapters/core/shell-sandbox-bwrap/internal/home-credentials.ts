import type { Dir, Dirent } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { BASELINE_IGNORED_DIRS, HOME_CREDENTIAL_PATHS } from '#adapters/core/workspace-read/index.js';
import { resolveLocale, t } from '#platform/index.js';
/** Security/resource invariants. Oversized subtrees are hidden whole; an oversized HOME root refuses. */
export const BUBBLEWRAP_HOME_WALK_MAX_DEPTH = 3;
export const BUBBLEWRAP_HOME_WALK_MAX_ENTRIES = 20_000;
export const HOME_CREDENTIAL_REFUSAL = 'SHELL_HOME_CREDENTIALS_UNDETERMINED';
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
/** Streaming read: retain at most the remaining budget, plus one sentinel; close on every exit. */
async function boundedNames(path: string, remaining: number): Promise<{ names: Dirent[]; complete: boolean }> {
  let dir: Dir | undefined; const names: Dirent[] = [];
  try {
    dir = await opendir(path); for (;;) {
      const entry = await dir.read(); if (!entry) return { names, complete: true };
      if (names.length >= remaining) return { names, complete: false };
      names.push(entry);
    }
  } catch { return { names, complete: false }; } finally { await dir?.close().catch(() => undefined); }
}
/** Known locations first; then the existing depth-3 credential floor. Never expose a partially inspected subtree. */
export async function maskHomeCredentials(home: string, denied: (rel: string) => boolean, skip: readonly string[],
  directories: string[], files: string[], maxMasks: number, environment: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const refuse = (detail: string) => t('shell.homeCredentialsRefused', { detail, entries: BUBBLEWRAP_HOME_WALK_MAX_ENTRIES }, resolveLocale(undefined, environment));
  const overMasks = () => directories.length + files.length > maxMasks ? refuse('mask bound') : null;
  const hide = (path: string): string | null => {
    if (path === home || skip.some(root => under(root, path))) return refuse('HOME root or project/state ancestor cannot be inspected');
    for (const list of [directories, files]) for (let i = list.length - 1; i >= 0; i--) if (under(list[i]!, path)) list.splice(i, 1);
    directories.push(path); return overMasks();
  };
  let probes = 0;
  for (const rel of HOME_CREDENTIAL_PATHS) {
    let path = home; const parts = rel.split('/'); for (let i = 0; i < parts.length; i++) {
      if (++probes > BUBBLEWRAP_HOME_WALK_MAX_ENTRIES) return refuse('known-path probe bound');
      path = join(path, parts[i]!); if (skip.some(root => under(path, root)) || directories.some(root => under(path, root))) break;
      let info; try { info = await lstat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        return refuse('known credential location cannot be inspected');
      }
      if (info.isSymbolicLink()) return refuse(`credential path is a symbolic link (${relative(home, path)})`);
      if (i < parts.length - 1) { if (!info.isDirectory()) break; continue; }
      if (info.isDirectory()) {
        if (skip.some(root => under(root, path))) return refuse('known credential directory holds project/state');
        directories.push(path);
      } else files.push(path);
      const over = overMasks(); if (over) return over;
    }
  }
  const queue = [{ path: home, rel: '', depth: 0 }]; let entries = 0;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!; if (directories.some(root => under(current.path, root))) continue;
    if (entries === BUBBLEWRAP_HOME_WALK_MAX_ENTRIES) { const refused = hide(current.path); if (refused) return refused; continue; }
    const listed = await boundedNames(current.path, BUBBLEWRAP_HOME_WALK_MAX_ENTRIES - entries); entries += listed.names.length;
    if (!listed.complete) { const refused = hide(current.path); if (refused) return refused; continue; }
    for (const entry of listed.names) {
      const path = join(current.path, entry.name), rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (skip.some(root => under(path, root)) || directories.some(root => under(path, root)) || files.includes(path)) continue;
      if (entry.isSymbolicLink()) {
        if (denied(rel)) return refuse(`credential path is a symbolic link (${rel})`);
        const target = await realpath(path).catch(() => null);
        if (target && (denied(target.slice(1)) || denied(basename(target)))) return refuse('symbolic link points to a credential');
        continue;
      }
      if (entry.isSocket() || denied(rel)) {
        (entry.isDirectory() ? directories : files).push(path); const over = overMasks(); if (over) return over; continue;
      }
      if (entry.isDirectory() && !BASELINE_IGNORED_DIRS.has(entry.name) && current.depth + 1 < BUBBLEWRAP_HOME_WALK_MAX_DEPTH) queue.push({ path, rel, depth: current.depth + 1 });
    }
  }
  return null;
}
