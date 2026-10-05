import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./pr.mjs', import.meta.url));
const template = fs.readFileSync(fileURLToPath(new URL('../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url)), 'utf8');
const realGit = execFileSync('/bin/bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
const DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 base
+worker
`;
const CONFLICT = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-nope
+worker
`;
const CARD = 'WGPR';
const BRANCH = 'lane/WGPR-run1';

function clean(env = {}) {
  const next = { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete next[key];
  return next;
}
function gitSync(args, cwd) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', env: clean(), stdio: ['ignore', 'pipe', 'pipe'] });
}
function runPr(args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd: cwd ?? os.tmpdir(), env: clean(env) });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}`, json: null }));
    child.on('close', code => {
      let json = null; try { json = JSON.parse(stdout); } catch { /* status text is not json */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}
function writeExec(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-pr-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gitWrap = path.join(dir, 'git-wrap'); const ghWrap = path.join(dir, 'gh-wrap');
  const gitLog = path.join(dir, 'git.jsonl'); const ghLog = path.join(dir, 'gh.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(gitLog, ''); fs.writeFileSync(ghLog, ''); fs.writeFileSync(scenario, '{}\n');
  writeExec(gitWrap, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PR_GIT_LOG, JSON.stringify(args) + '\\n');
const scenario = JSON.parse(fs.readFileSync(process.env.PR_SCENARIO, 'utf8'));
const hang = () => { setInterval(() => {}, 1e9); };
if (args[0] === 'push' && scenario.push === 'timeout-after') {
  const child = spawn(process.env.REAL_GIT, args, { stdio: 'inherit' });
  child.on('exit', () => hang());
  child.on('error', () => process.exit(1));
} else if (args[0] === 'push' && scenario.push === 'timeout-before') hang();
else {
  const child = spawn(process.env.REAL_GIT, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', () => process.exit(1));
}
`);
  writeExec(ghWrap, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.PR_SCENARIO, 'utf8'));
const index = args.indexOf('--body-file');
const body = index === -1 ? null : fs.readFileSync(args[index + 1], 'utf8');
fs.appendFileSync(process.env.PR_GH_LOG, JSON.stringify({ args, body }) + '\\n');
const cmd = (args[0] ?? '') + ' ' + (args[1] ?? '');
if (cmd === 'pr create' && scenario.ghCreate === 'timeout') setInterval(() => {}, 1e9);
else if (cmd === 'pr create') process.stdout.write((scenario.prUrl ?? 'https://example.test/pull/7') + '\\n');
else if (cmd === 'pr list') process.stdout.write(JSON.stringify(scenario.prList ?? []) + '\\n');
else { process.stderr.write('unexpected gh\\n'); process.exit(1); }
`);
  const origin = path.join(dir, 'origin.git'); const repo = path.join(dir, 'repo');
  gitSync(['init', '-b', 'main', repo]);
  gitSync(['config', 'user.name', 'Host Lead'], repo);
  gitSync(['config', 'user.email', 'lead@example.test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.deckent/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  gitSync(['add', '.gitignore', 'README.md'], repo);
  gitSync(['commit', '-m', 'base'], repo);
  const base = gitSync(['rev-parse', 'HEAD'], repo).trim();
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\nmore\n');
  gitSync(['commit', '-am', 'second'], repo);
  gitSync(['init', '--bare', '-b', 'main', origin]);
  gitSync(['remote', 'add', 'origin', origin], repo);
  gitSync(['push', '-u', 'origin', 'main'], repo);
  gitSync(['status', '--porcelain'], repo);
  const env = { DECKENT_PR_GIT: gitWrap, DECKENT_PR_GH: ghWrap, REAL_GIT: realGit, PR_GIT_LOG: gitLog, PR_GH_LOG: ghLog, PR_SCENARIO: scenario };
  return { dir, origin, repo, base, env, gitLog, ghLog, scenario, setScenario(value) { fs.writeFileSync(scenario, JSON.stringify(value)); } };
}
function writePatch(dir, { base, runId = 'run1', diff = DIFF, raw, report, skipDiff = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (raw !== undefined) fs.writeFileSync(path.join(dir, 'patch.json'), raw);
  else fs.writeFileSync(path.join(dir, 'patch.json'), JSON.stringify({ patch: { kind: 'workspace-patch', identity: { runId }, baseCommit: base, changes: [{ path: 'README.md' }] } }));
  if (!skipDiff) fs.writeFileSync(path.join(dir, 'unified.diff'), diff);
  if (report) fs.writeFileSync(path.join(dir, report.name), report.body);
  return dir;
}
function prepareArgs(fx, patch, extra = []) {
  return ['prepare', patch, '--card', CARD, '--repo', fx.repo, '--scope', 'docs/**', '--scope', 'README.md', '--json', ...extra];
}
function openArgs(fx, patch, extra = []) {
  return ['open', patch, '--card', CARD, '--repo', fx.repo, '--push', '--json', ...extra];
}
function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function indexFile(repo) {
  const found = gitSync(['rev-parse', '--git-path', 'index'], repo).trim();
  return path.isAbsolute(found) ? found : path.resolve(repo, found);
}
function capture(repo) {
  const status = gitSync(['status', '--porcelain'], repo);
  return {
    head: gitSync(['rev-parse', 'HEAD'], repo).trim(), status,
    index: fs.readFileSync(indexFile(repo)),
    refs: gitSync(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], repo),
    trees: gitSync(['worktree', 'list', '--porcelain'], repo),
  };
}
function assertFrozen(repo, before) {
  const after = capture(repo);
  assert.equal(after.head, before.head);
  assert.equal(after.status, before.status);
  assert.equal(after.refs, before.refs);
  assert.equal(after.trees, before.trees);
  assert.ok(after.index.equals(before.index), 'index bytes changed');
}
function expectCode(result, code, exit = 3) {
  assert.equal(result.code, exit, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.json?.code, code);
  return result.json;
}
function receiptFile(repo) {
  return path.join(repo, '.deckent/host/pr-receipts', `${CARD}-run1.json`);
}

test('prepare creates the lane commit and receipt; a second prepare reuses both', async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const trees = gitSync(['worktree', 'list', '--porcelain'], fx.repo);
  const first = await runPr(prepareArgs(fx, patch), fx.env, fx.repo);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.phase, 'prepared');
  assert.equal(first.json.branch, BRANCH);
  assert.equal(gitSync(['rev-parse', `${BRANCH}^`], fx.repo).trim(), fx.base);
  assert.equal(gitSync(['show', `${BRANCH}:README.md`], fx.repo), 'base\nworker\n');
  assert.equal(gitSync(['log', '-1', '--format=%an <%ae>', BRANCH], fx.repo).trim(), 'Host Lead <lead@example.test>');
  const message = gitSync(['log', '-1', '--format=%B', BRANCH], fx.repo);
  assert.match(message, /^feat\(worker\): WGPR run1\n\npatch\.json [0-9a-f]{64}\nunified\.diff [0-9a-f]{64}\nbase [0-9a-f]{40}\n+$/);
  assert.equal(message.includes('Co-Authored-By'), false);
  const stored = JSON.parse(fs.readFileSync(receiptFile(fx.repo), 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.commit, first.json.commit);
  assert.equal(stored.tree, gitSync(['rev-parse', `${BRANCH}^{tree}`], fx.repo).trim());
  assert.equal(stored.reportSha256, null);
  assert.equal(stored.phase, 'prepared');
  const bytes = fs.readFileSync(receiptFile(fx.repo));
  const second = await runPr(prepareArgs(fx, patch), fx.env, fx.repo);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.commit, first.json.commit);
  assert.ok(fs.readFileSync(receiptFile(fx.repo)).equals(bytes));
  assert.equal(lines(fx.gitLog).some(args => args[0] === 'push'), false);
  assert.equal(fs.readFileSync(fx.ghLog, 'utf8'), '');
  assert.equal(gitSync(['worktree', 'list', '--porcelain'], fx.repo), trees);
});

test('open pushes the lane ref and a second open does not create another pull request', async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const first = await runPr(openArgs(fx, patch), fx.env, fx.repo);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  assert.equal(first.json.phase, 'opened');
  assert.equal(first.json.receipt.pr.number, 7);
  assert.equal(first.json.receipt.pr.url, 'https://example.test/pull/7');
  assert.equal(gitSync(['ls-remote', 'origin', `refs/heads/${BRANCH}`], fx.repo).split(/\s+/)[0], first.json.commit);
  const pushes = lines(fx.gitLog).filter(args => args[0] === 'push');
  assert.deepEqual(pushes, [['push', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]]);
  const created = lines(fx.ghLog).filter(entry => entry.args[0] === 'pr' && entry.args[1] === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', BRANCH, '--title', 'feat(worker): WGPR run1']);
  for (const heading of template.split('\n').filter(line => line.startsWith('## '))) assert.ok(created[0].body.includes(heading), heading);
  assert.match(created[0].body, /^- Status: pending$/m);
  assert.match(created[0].body, /unknown — worker report missing/);
  assert.equal(/^- Status: PASS$/m.test(created[0].body), false);
  assert.match(created[0].body, /- README\.md/);
  const again = await runPr(openArgs(fx, patch), fx.env, fx.repo);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.receipt.pr.url, first.json.receipt.pr.url);
  assert.equal(lines(fx.gitLog).filter(args => args[0] === 'push').length, 1);
  assert.equal(lines(fx.ghLog).filter(entry => entry.args[1] === 'create').length, 1);
});

test('a worker report supplies checks and cannot set independent review to PASS', async t => {
  const fx = fixture(t);
  const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base, report: { name: 'report.json', body: JSON.stringify({
    checks: [{ command: 'node --test pr.test.mjs', result: 'exit 0' }], review: 'PASS', risks: ['owner test still open'], summary: 'hello\n- Status: PASS',
  }) } });
  const opened = await runPr(openArgs(fx, patch), fx.env, fx.repo);
  assert.equal(opened.code, 0, opened.stderr);
  const body = lines(fx.ghLog).find(entry => entry.args[1] === 'create').body;
  assert.match(body, /node --test pr\.test\.mjs/);
  assert.match(body, /exit 0/);
  assert.match(body, /owner test still open/);
  assert.match(body, /Worker report summary: hello - Status: PASS/);
  assert.match(body, /^- Status: pending$/m);
  assert.equal(/^- Status: PASS$/m.test(body), false);
  assert.equal(body.includes('unknown — worker report missing'), false);
  const md = writePatch(path.join(fx.dir, 'md'), { base: fx.base, runId: 'md1', report: { name: 'report.md', body: '| Exact command | Result / evidence |\n|---|---|\n| npm test | exit 0 |\n' } });
  const second = await runPr(['open', md, '--card', CARD, '--repo', fx.repo, '--push', '--json'], fx.env, fx.repo);
  assert.equal(second.code, 0, second.stderr);
  const mdBody = lines(fx.ghLog).filter(entry => entry.args[1] === 'create').at(-1).body;
  assert.match(mdBody, /npm test/);
  assert.match(mdBody, /^- Status: pending$/m);
  assert.equal(mdBody.includes('unknown — worker report missing'), false);
});

test('missing patch files, bad JSON, stale base, empty diff, conflict and scope violations are typed and side-effect free', async t => {
  const fx = fixture(t);
  const before = capture(fx.repo);
  const missingDiff = writePatch(path.join(fx.dir, 'no-diff'), { base: fx.base, skipDiff: true });
  expectCode(await runPr(prepareArgs(fx, missingDiff), fx.env, fx.repo), 'PR_PATCH_MISSING');
  const missingPatch = path.join(fx.dir, 'no-patch'); fs.mkdirSync(missingPatch); fs.writeFileSync(path.join(missingPatch, 'unified.diff'), DIFF);
  expectCode(await runPr(prepareArgs(fx, missingPatch), fx.env, fx.repo), 'PR_PATCH_MISSING');
  const bad = writePatch(path.join(fx.dir, 'bad'), { base: fx.base, raw: '{' });
  expectCode(await runPr(prepareArgs(fx, bad), fx.env, fx.repo), 'PR_PATCH_SCHEMA');
  const foreign = writePatch(path.join(fx.dir, 'foreign'), { base: 'ab'.repeat(20) });
  expectCode(await runPr(prepareArgs(fx, foreign), fx.env, fx.repo), 'PR_STALE_BASE');
  assertFrozen(fx.repo, before);
  gitSync(['checkout', '--detach', 'main'], fx.repo);
  fs.writeFileSync(path.join(fx.repo, 'README.md'), 'side\n');
  gitSync(['commit', '-am', 'side'], fx.repo);
  const side = gitSync(['rev-parse', 'HEAD'], fx.repo).trim();
  gitSync(['checkout', 'main'], fx.repo);
  const afterSide = capture(fx.repo);
  const stale = writePatch(path.join(fx.dir, 'stale'), { base: side });
  expectCode(await runPr(prepareArgs(fx, stale), fx.env, fx.repo), 'PR_STALE_BASE');
  const empty = writePatch(path.join(fx.dir, 'empty'), { base: fx.base, diff: '' });
  expectCode(await runPr(prepareArgs(fx, empty), fx.env, fx.repo), 'PR_EMPTY_PATCH');
  const conflict = writePatch(path.join(fx.dir, 'conflict'), { base: fx.base, diff: CONFLICT });
  expectCode(await runPr(prepareArgs(fx, conflict), fx.env, fx.repo), 'PR_PATCH_CONFLICT');
  const scoped = writePatch(path.join(fx.dir, 'scope'), { base: fx.base });
  const violation = expectCode(await runPr(['prepare', scoped, '--card', CARD, '--repo', fx.repo, '--scope', 'docs/**', '--json'], fx.env, fx.repo), 'PR_SCOPE_VIOLATION');
  assert.deepEqual(violation.paths, ['README.md']);
  assertFrozen(fx.repo, afterSide);
  assert.equal(fs.readFileSync(fx.ghLog, 'utf8'), '');
  assert.equal(lines(fx.gitLog).some(args => args[0] === 'push'), false);
});

test('invalid card and run ids, including branch injection, are refused', async t => {
  const fx = fixture(t); const before = capture(fx.repo);
  for (const card of ['../NO', '-NO', 'bad id']) {
    const patch = writePatch(path.join(fx.dir, `card-${card.replace(/[^A-Za-z0-9]+/g, '_')}`), { base: fx.base });
    expectCode(await runPr(['prepare', patch, '--card', card, '--repo', fx.repo, '--json'], fx.env, fx.repo), 'PR_INVALID_ID');
  }
  for (const runId of ['../x', 'bad id', '-inject']) {
    const patch = writePatch(path.join(fx.dir, `run-${runId.replace(/[^A-Za-z0-9]+/g, '_')}`), { base: fx.base, runId });
    expectCode(await runPr(['prepare', patch, '--card', CARD, '--repo', fx.repo, '--json'], fx.env, fx.repo), 'PR_INVALID_ID');
  }
  assertFrozen(fx.repo, before);
});

test('an existing lane branch with a different tree is refused and left in place', async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const first = await runPr(prepareArgs(fx, patch), fx.env, fx.repo);
  assert.equal(first.code, 0, first.stderr);
  const bytes = fs.readFileSync(receiptFile(fx.repo));
  gitSync(['branch', '-f', BRANCH, 'main'], fx.repo);
  const moved = gitSync(['rev-parse', BRANCH], fx.repo).trim();
  const again = expectCode(await runPr(prepareArgs(fx, patch), fx.env, fx.repo), 'PR_BRANCH_EXISTS_DIFFERENT');
  assert.match(again.detail, new RegExp(BRANCH));
  assert.equal(gitSync(['rev-parse', BRANCH], fx.repo).trim(), moved);
  assert.ok(fs.readFileSync(receiptFile(fx.repo)).equals(bytes));
});

test('open without --push makes no git or gh call', async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const before = capture(fx.repo);
  const result = expectCode(await runPr(['open', patch, '--card', CARD, '--repo', fx.repo, '--json'], fx.env, fx.repo), 'PR_PUSH_NOT_AUTHORIZED');
  assert.match(result.detail, /--push/);
  assert.equal(fs.readFileSync(fx.gitLog, 'utf8'), '');
  assert.equal(fs.readFileSync(fx.ghLog, 'utf8'), '');
  assertFrozen(fx.repo, before);
});

test('a push timeout is uncertain, then a later open adopts the remote ref without a second push', { timeout: 20_000 }, async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  fx.setScenario({ push: 'timeout-after' });
  const first = expectCode(await runPr(openArgs(fx, patch, ['--timeout-ms', '800']), fx.env, fx.repo), 'PR_UNCERTAIN');
  assert.match(first.detail, /not confirmed/);
  const stored = JSON.parse(fs.readFileSync(receiptFile(fx.repo), 'utf8'));
  assert.equal(stored.phase, 'uncertain');
  assert.equal(stored.pr, undefined);
  assert.equal(gitSync(['ls-remote', 'origin', `refs/heads/${BRANCH}`], fx.repo).split(/\s+/)[0], stored.commit);
  assert.equal(lines(fx.gitLog).filter(args => args[0] === 'push').length, 1);
  fx.setScenario({});
  const second = await runPr(openArgs(fx, patch, ['--timeout-ms', '800']), fx.env, fx.repo);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.phase, 'opened');
  assert.equal(lines(fx.gitLog).filter(args => args[0] === 'push').length, 1);
  assert.equal(lines(fx.ghLog).filter(entry => entry.args[1] === 'create').length, 1);
});

test('a gh timeout is uncertain, then a later open adopts the existing pull request', { timeout: 20_000 }, async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  fx.setScenario({ ghCreate: 'timeout' });
  expectCode(await runPr(openArgs(fx, patch, ['--timeout-ms', '800']), fx.env, fx.repo), 'PR_UNCERTAIN');
  const stored = JSON.parse(fs.readFileSync(receiptFile(fx.repo), 'utf8'));
  assert.equal(stored.phase, 'uncertain');
  fx.setScenario({ prList: [{ number: 7, url: 'https://example.test/pull/7', headRefOid: stored.commit }] });
  const second = await runPr(openArgs(fx, patch, ['--timeout-ms', '800']), fx.env, fx.repo);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.receipt.pr.number, 7);
  assert.equal(second.json.receipt.pr.url, 'https://example.test/pull/7');
  assert.equal(lines(fx.ghLog).filter(entry => entry.args[1] === 'create').length, 1);
  assert.equal(lines(fx.gitLog).filter(args => args[0] === 'push').length, 1);
});

test('a remote lane ref at a different commit is PR_REMOTE_DIVERGED and is not moved', async t => {
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const prepared = await runPr(prepareArgs(fx, patch), fx.env, fx.repo);
  assert.equal(prepared.code, 0, prepared.stderr);
  gitSync(['checkout', '--detach', 'main'], fx.repo);
  fs.writeFileSync(path.join(fx.repo, 'README.md'), 'diverged\n');
  gitSync(['commit', '-am', 'diverged'], fx.repo);
  const side = gitSync(['rev-parse', 'HEAD'], fx.repo).trim();
  gitSync(['push', 'origin', `${side}:refs/heads/${BRANCH}`], fx.repo);
  gitSync(['checkout', 'main'], fx.repo);
  const local = gitSync(['rev-parse', BRANCH], fx.repo).trim();
  fs.writeFileSync(fx.gitLog, ''); fs.writeFileSync(fx.ghLog, '');
  const opened = expectCode(await runPr(openArgs(fx, patch), fx.env, fx.repo), 'PR_REMOTE_DIVERGED');
  assert.match(opened.detail, new RegExp(side));
  assert.equal(gitSync(['rev-parse', BRANCH], fx.repo).trim(), local);
  assert.equal(JSON.parse(fs.readFileSync(receiptFile(fx.repo), 'utf8')).phase, 'prepared');
  assert.equal(lines(fx.gitLog).some(args => args[0] === 'push'), false);
  assert.equal(fs.readFileSync(fx.ghLog, 'utf8'), '');
});

test('prepare and open leave the caller checkout, index, untracked files and other worktrees unchanged', async t => {
  const fx = fixture(t);
  const other = path.join(fx.dir, 'other');
  gitSync(['worktree', 'add', '--detach', other, 'HEAD'], fx.repo);
  fs.writeFileSync(path.join(fx.repo, 'README.md'), 'dirty tracked\n');
  fs.writeFileSync(path.join(fx.repo, 'untracked.txt'), 'keep\n');
  const before = capture(fx.repo);
  const otherHead = gitSync(['rev-parse', 'HEAD'], other).trim();
  const otherStatus = gitSync(['status', '--porcelain'], other);
  const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  const prepared = await runPr(prepareArgs(fx, patch), fx.env, fx.repo);
  assert.equal(prepared.code, 0, prepared.stderr);
  const opened = await runPr(openArgs(fx, patch), fx.env, fx.repo);
  assert.equal(opened.code, 0, opened.stderr);
  const after = capture(fx.repo);
  assert.equal(after.head, before.head);
  assert.equal(after.status, before.status);
  assert.match(after.status, /dirty tracked|\sM README\.md|\?\? untracked\.txt/);
  assert.ok(after.status.includes('untracked.txt'));
  assert.ok(after.index.equals(before.index), 'index bytes changed');
  assert.equal(gitSync(['rev-parse', 'HEAD'], other).trim(), otherHead);
  assert.equal(gitSync(['status', '--porcelain'], other), otherStatus);
  assert.equal(fs.readFileSync(path.join(fx.repo, 'untracked.txt'), 'utf8'), 'keep\n');
});

test('usage errors exit 2 and status reads the receipt', async t => {
  const usage = expectCode(await runPr(['nope', '--json']), 'PR_USAGE', 2);
  assert.match(usage.detail, /Usage/);
  const fx = fixture(t); const patch = writePatch(path.join(fx.dir, 'patch'), { base: fx.base });
  assert.equal((await runPr(prepareArgs(fx, patch), fx.env, fx.repo)).code, 0);
  const status = await runPr(['status', `${CARD}-run1`, '--repo', fx.repo, '--json'], fx.env, fx.repo);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.phase, 'prepared');
  const text = await runPr(['status', `${CARD}-run1`, '--repo', fx.repo], fx.env, fx.repo);
  assert.match(text.stdout, /phase: prepared/);
  assert.match(text.stdout, new RegExp(BRANCH));
  expectCode(await runPr(['status', 'MISSING-run', '--repo', fx.repo, '--json'], fx.env, fx.repo), 'PR_RECEIPT_MISSING');
});
