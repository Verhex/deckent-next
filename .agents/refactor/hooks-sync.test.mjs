import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSync, applyPlan, hookScripts, listWorktrees } from './hooks-sync.mjs';

const TOOL = fileURLToPath(new URL('./hooks-sync.mjs', import.meta.url));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const HOOKS = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cd "$CLAUDE_PROJECT_DIR" && node .agents/refactor/host-guard.mjs pre-tool' }] }] };
const settings = dir => path.join(dir, '.claude', 'settings.local.json');
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const snapshot = dirs => dirs.map(dir => { const file = settings(dir); try { return [file, fs.readFileSync(file, 'utf8')]; } catch { return [file, null]; } });

function repo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-hooks-sync-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  fs.mkdirSync(path.join(main, '.agents', 'refactor'), { recursive: true });
  fs.writeFileSync(path.join(main, '.agents', 'refactor', 'host-guard.mjs'), '');
  git(base, 'init', '-q', main); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'init');
  const wt = name => { const dir = path.join(base, name); git(main, 'worktree', 'add', '-q', '-b', name, dir); return dir; };
  const [kept, fresh, broken, same] = ['kept', 'fresh', 'broken', 'same'].map(wt);
  writeJson(settings(main), { permissions: { allow: ['Bash(ls)'] }, $comment: 'source', hooks: HOOKS });
  writeJson(settings(kept), { permissions: { deny: ['Bash(rm -rf:*)'] }, hooks: { Stop: [] }, other: 1 });
  fs.mkdirSync(path.dirname(settings(broken)), { recursive: true }); fs.writeFileSync(settings(broken), '{not json');
  writeJson(settings(same), { hooks: HOOKS });
  fs.rmSync(path.join(fresh, '.agents'), { recursive: true, force: true });
  const gone = wt('gone'); fs.rmSync(gone, { recursive: true, force: true });
  return { main, kept, fresh, broken, same, gone };
}

test('hook scripts are the relative node scripts named by hook commands', () => {
  assert.deepEqual(hookScripts({ A: [{ hooks: [{ command: 'node /abs/x.mjs && node .agents/refactor/host-guard.mjs pre-tool' }] }], B: [{ hooks: [{ command: 'cd x && node .agents/refactor/channel.mjs hook' }] }] }),
    ['.agents/refactor/channel.mjs', '.agents/refactor/host-guard.mjs']);
});

test('dry run plans per worktree and writes nothing', t => {
  const r = repo(t);
  const worktrees = listWorktrees(r.main);
  assert.equal(worktrees[0], r.main);
  const before = snapshot(worktrees);
  const { entries } = planSync({ source: settings(r.main), worktrees });
  const action = dir => entries.find(entry => entry.worktree === dir);
  assert.equal(action(r.main).action, 'skip'); assert.equal(action(r.main).reason, 'source settings');
  assert.equal(action(r.kept).action, 'update'); assert.equal(action(r.kept).reason, 'replaces hooks');
  assert.equal(action(r.fresh).action, 'create'); assert.deepEqual(action(r.fresh).missingScripts, ['.agents/refactor/host-guard.mjs']);
  assert.equal(action(r.broken).action, 'skip'); assert.match(action(r.broken).reason, /unreadable target/u);
  assert.equal(action(r.same).action, 'unchanged');
  assert.equal(action(r.gone).action, 'skip'); assert.match(action(r.gone).reason, /missing/u);
  assert.deepEqual(snapshot(worktrees), before);
  const cli = spawnSync(process.execPath, [TOOL, '--repo', r.main], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /dry run, nothing written; pass --apply to write/u);
  assert.match(cli.stdout, /create 1/u); assert.match(cli.stdout, /update 1/u);
  assert.deepEqual(snapshot(worktrees), before);
});

test('apply changes only the hooks key, creates missing files with hooks alone, keeps broken files, and is idempotent', t => {
  const r = repo(t);
  const worktrees = listWorktrees(r.main);
  const sourceBefore = fs.readFileSync(settings(r.main), 'utf8'), brokenBefore = fs.readFileSync(settings(r.broken), 'utf8');
  const cli = spawnSync(process.execPath, [TOOL, '--repo', r.main, '--apply'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /applied \(hooks key only\)/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings(r.kept), 'utf8')), { permissions: { deny: ['Bash(rm -rf:*)'] }, hooks: HOOKS, other: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(settings(r.fresh), 'utf8')), { hooks: HOOKS });
  assert.equal(fs.statSync(settings(r.fresh)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(settings(r.broken), 'utf8'), brokenBefore);
  assert.equal(fs.readFileSync(settings(r.main), 'utf8'), sourceBefore);
  assert.ok(!fs.existsSync(r.gone));
  const again = applyPlan(planSync({ source: settings(r.main), worktrees }));
  assert.ok(again.every(entry => entry.action === 'unchanged' || entry.action === 'skip'), JSON.stringify(again));
});

test('a source without hooks or a bad flag fails before any write', t => {
  const r = repo(t);
  writeJson(settings(r.main), { permissions: {} });
  const before = snapshot(listWorktrees(r.main));
  const run = spawnSync(process.execPath, [TOOL, '--repo', r.main, '--apply'], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.match(run.stderr, /no hooks object/u);
  assert.equal(spawnSync(process.execPath, [TOOL, '--source'], { encoding: 'utf8' }).status, 2);
  assert.deepEqual(snapshot(listWorktrees(r.main)), before);
});
