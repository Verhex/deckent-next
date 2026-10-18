#!/usr/bin/env node
// Copy the development hooks of the main checkout into every Git worktree (Jev g3-kancalar-takip copy_script,
// owner 2026-10-18). Host tooling only. The hooks live in the Git-ignored `.claude/settings.local.json`
// (2be86b6c keeps them out of tracked settings so product workers never inherit them), so new worktrees start
// without host-guard/channel hooks. This script copies ONLY the `hooks` key: permissions, comments and every other
// key of a target file stay as they are; a missing target file is created with `hooks` alone, never over a file that
// appeared meanwhile. Concurrent-writer limit: see updateChecked.
//
// Default is a dry run that writes nothing. `--apply` writes; owner or lead runs it.
//
//   node .agents/refactor/hooks-sync.mjs [--apply] [--source FILE] [--repo DIR] [--json]
//
// --source defaults to `.claude/settings.local.json` of the main worktree (first `git worktree list` entry).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const SETTINGS = path.join('.claude', 'settings.local.json');
const MAX_BYTES = 1024 * 1024;

/** Worktree directories in `git worktree list` order; the first one is the main worktree. */
export function listWorktrees(repo) {
  const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
}

const readJson = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level is not an object');
  return value;
};

/** Relative hook scripts (e.g. `.agents/refactor/host-guard.mjs`) a worktree checkout must contain for the hooks to work. */
export function hookScripts(hooks) {
  const scripts = new Set();
  for (const groups of Object.values(hooks)) for (const group of Array.isArray(groups) ? groups : [])
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : [])
      for (const match of String(hook?.command ?? '').matchAll(/\bnode\s+(\.?[\w.-]+(?:\/[\w.-]+)+\.m?js)\b/gu))
        if (!path.isAbsolute(match[1])) scripts.add(match[1]);
  return [...scripts].sort();
}

/** Pure plan: one entry per worktree with action create | update | unchanged | skip and the reason. Reads only. */
export function planSync({ source, worktrees }) {
  const sourceSettings = readJson(source);
  if (!sourceSettings.hooks || typeof sourceSettings.hooks !== 'object' || Array.isArray(sourceSettings.hooks)) throw new Error(`${source} has no hooks object`);
  const hooks = sourceSettings.hooks, scripts = hookScripts(hooks), sourceReal = fs.realpathSync(source);
  return { source, hooks, entries: worktrees.map(dir => {
    const target = path.join(dir, SETTINGS);
    const entry = (action, reason = null, extra = {}) => ({ worktree: dir, target, action, reason, ...extra });
    if (!fs.existsSync(dir)) return entry('skip', 'worktree directory missing (prunable)');
    if (fs.existsSync(target) && fs.realpathSync(target) === sourceReal) return entry('skip', 'source settings');
    const missingScripts = scripts.filter(script => !fs.existsSync(path.join(dir, script)));
    if (!fs.existsSync(target)) {
      try { fs.lstatSync(target); return entry('skip', 'dangling symlink'); } catch { /* absent: create */ }
      return entry('create', null, { missingScripts });
    }
    let current;
    try { current = readJson(target); } catch (error) { return entry('skip', `unreadable target, left untouched: ${error.message}`); }
    if (isDeepStrictEqual(current.hooks, hooks)) return entry('unchanged', null, { missingScripts });
    return entry('update', current.hooks === undefined ? 'adds hooks' : 'replaces hooks', { missingScripts });
  }) };
}

const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const conflict = (entry, code, reason) => ({ ...entry, applied: false, conflict: code, error: `${code}: ${reason}` });

/** Writes a private temp file next to the target; the caller commits or removes it. */
const writeTemp = (file, value, mode) => {
  const temp = `${file}.hooks-sync-${process.pid}.tmp`;
  fs.writeFileSync(temp, serialize(value), { mode, flag: 'wx' });
  return temp;
};

/**
 * No-clobber create (Astra 2648 F1): `link(temp, target)` fails with EEXIST when any file appeared at the target after
 * planning, so another writer's settings are never replaced. Filesystems without hard links fall back to `open(target, 'wx')`
 * and an in-place write, which is no-clobber but not atomic for readers. Returns false when the target already exists.
 */
const createNoClobber = (file, value) => {
  const temp = writeTemp(file, value, 0o600);
  try {
    try { fs.linkSync(temp, file); return true; } catch (error) {
      if (error.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
    }
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try { fs.writeFileSync(fd, serialize(value)); } finally { fs.closeSync(fd); }
    return true;
  } finally { fs.rmSync(temp, { force: true }); }
};

/**
 * Update keeps every key but `hooks` from a fresh read. Concurrent-writer limit: no lock is shared with Claude Code or any
 * other writer of settings.local.json. The target identity (device, inode, size, mtime, ctime) read before the merge is checked
 * again right before the rename; a change returns a typed TARGET_CHANGED conflict and writes nothing. A write that lands
 * in the remaining window between that check and the rename itself is still lost, so run --apply while no session edits
 * its settings. `beforeCommit` is a test seam that runs inside that window.
 */
const updateChecked = (entry, hooks, beforeCommit) => {
  const before = fs.statSync(entry.target, { bigint: true }), current = readJson(entry.target);
  const temp = writeTemp(entry.target, { ...current, hooks }, Number(before.mode) & 0o777);
  try {
    beforeCommit?.(entry);
    if (identity(fs.statSync(entry.target, { bigint: true })) !== identity(before))
      return conflict(entry, 'TARGET_CHANGED', 'target changed after it was read; nothing written, re-run to merge');
    fs.renameSync(temp, entry.target);
    return { ...entry, applied: true };
  } finally { fs.rmSync(temp, { force: true }); }
};

/**
 * Applies create/update entries; only the hooks key changes. A create whose target appeared after planning is re-planned
 * as an update (read and merge), so the other writer's keys survive.
 */
export function applyPlan(plan, { beforeCommit } = {}) {
  return plan.entries.map(entry => {
    if (entry.action !== 'create' && entry.action !== 'update') return entry;
    try {
      if (entry.action === 'create') {
        fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
        beforeCommit?.(entry);
        if (createNoClobber(entry.target, { hooks: plan.hooks })) return { ...entry, applied: true };
        const merged = updateChecked({ ...entry, action: 'update', reason: 'target appeared after planning; merged as update' }, plan.hooks);
        return { ...merged, replanned: true };
      }
      return updateChecked(entry, plan.hooks, beforeCommit);
    } catch (error) { return { ...entry, applied: false, error: error.message }; }
  });
}

export function formatPlan(entries, { apply }) {
  const counts = Object.entries(Object.groupBy(entries, entry => entry.action)).map(([action, list]) => `${action} ${list.length}`).join(', ');
  const lines = entries.map(entry => `hooks-sync: ${entry.action} ${entry.target}${entry.reason ? ` (${entry.reason})` : ''}`
    + `${entry.missingScripts?.length ? ` [hook scripts missing in this checkout: ${entry.missingScripts.join(', ')}]` : ''}`
    + `${entry.applied === false ? ` FAILED: ${entry.error}` : ''}`);
  return [...lines, `hooks-sync: ${entries.length} worktree(s): ${counts}; ${apply ? 'applied (hooks key only)' : 'dry run, nothing written; pass --apply to write'}`].join('\n') + '\n';
}

function main(argv) {
  const value = flag => { const at = argv.indexOf(flag); return at > -1 ? argv[at + 1] : undefined; };
  for (const flag of ['--source', '--repo']) if (argv.includes(flag) && (!value(flag) || value(flag).startsWith('--'))) { process.stderr.write(`hooks-sync: ${flag} needs a path\n`); return 2; }
  const repo = path.resolve(value('--repo') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const apply = argv.includes('--apply');
  try {
    const worktrees = listWorktrees(repo);
    const source = path.resolve(value('--source') ?? path.join(worktrees[0], SETTINGS));
    const plan = planSync({ source, worktrees });
    const entries = apply ? applyPlan(plan) : plan.entries;
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify({ source, apply, entries }, null, 2)}\n` : formatPlan(entries, { apply }));
    return entries.some(entry => entry.applied === false) ? 1 : 0;
  } catch (error) { process.stderr.write(`hooks-sync: ${error.message}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
