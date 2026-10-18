#!/usr/bin/env node
// Copy the development hooks of the main checkout into every Git worktree (Jev g3-kancalar-takip copy_script,
// owner 2026-10-18). Host tooling only. The hooks live in the Git-ignored `.claude/settings.local.json`
// (2be86b6c keeps them out of tracked settings so product workers never inherit them), so new worktrees start
// without host-guard/channel hooks. This script copies ONLY the `hooks` key: permissions, comments and every other
// key of a target file stay as they are; a missing target file is created with `hooks` alone.
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

const writeAtomic = (file, value, mode) => {
  const temp = `${file}.hooks-sync-${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  try { fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
};

/** Applies create/update entries; only the hooks key changes. Each target is re-read so a concurrent edit is kept. */
export function applyPlan(plan) {
  return plan.entries.map(entry => {
    if (entry.action !== 'create' && entry.action !== 'update') return entry;
    try {
      if (entry.action === 'create') {
        fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
        writeAtomic(entry.target, { hooks: plan.hooks }, 0o600);
      } else {
        const current = readJson(entry.target), mode = fs.statSync(entry.target).mode & 0o777;
        writeAtomic(entry.target, { ...current, hooks: plan.hooks }, mode);
      }
      return { ...entry, applied: true };
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
