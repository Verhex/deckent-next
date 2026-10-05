// Host-only worker branch/PR tool (WORKER-GIT-PR). Not product runtime and not an acceptance gate.
// External processes are execFile only. Git identity comes from the host's user.name/email.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(here, '../../.github/PULL_REQUEST_TEMPLATE.md');
const USAGE = 'Usage: prepare <patch-dir> --card <ID> [--scope <glob>]... [--repo <path>] [--json] | open <patch-dir> --card <ID> --push [--remote origin] [--repo <path>] [--scope <glob>]... [--timeout-ms N] [--json] | status <card>-<runId> [--repo <path>] [--json]';
const CARD_RE = /^[A-Z0-9][A-Z0-9-]{1,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FLAGS = new Set(['json', 'push']);
const OPTIONS = new Set(['card', 'scope', 'repo', 'remote', 'timeout-ms']);
const fail = (code, detail, extra = {}) => Object.assign(new Error(`${code}${detail ? `: ${detail}` : ''}`), { code, detail: detail ?? null, ...extra });
const asString = value => (value == null ? '' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
const detailOf = error => asString(error.stderr || error.stdout || error.message).trim().split('\n').filter(Boolean).at(-1) || 'command failed';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cell = value => asString(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 500);
const gitBin = () => process.env.DECKENT_PR_GIT || 'git';
const ghBin = () => process.env.DECKENT_PR_GH || 'gh';

function baseEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}
function run(bin, args, { cwd, timeout, env } = {}) {
  try {
    return execFileSync(bin, args, { cwd, timeout, env: baseEnv(env), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) ?? '';
  } catch (error) {
    error.stdout = asString(error.stdout); error.stderr = asString(error.stderr); throw error;
  }
}
function isUncertain(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ETIMEDOUT' || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_FAIL', 'EPIPE'].includes(error.code)) return true;
  return /timed out|could not resolve host|unable to access|network is unreachable|connection reset by peer/i.test(`${error.stderr || ''}\n${error.message || ''}`);
}
function git(cwd, args, opts = {}) {
  try { return run(gitBin(), args, { cwd: opts.cwd ?? cwd, timeout: opts.timeout, env: opts.env }); }
  catch (error) { if (opts.raw || (typeof error.code === 'string' && error.code.startsWith('PR_'))) throw error; throw fail('PR_GIT', detailOf(error)); }
}
function gh(cwd, args, opts) {
  try { return run(ghBin(), args, { cwd, timeout: opts.timeout }); }
  catch (error) { if (isUncertain(error)) throw error; throw fail('PR_GH_FAILED', detailOf(error)); }
}
function parseArgs(argv) {
  const opts = { scope: [], _: [], json: false, push: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const key = arg.slice(2);
    if (FLAGS.has(key)) { opts[key] = true; continue; }
    if (!OPTIONS.has(key)) throw fail('PR_USAGE', `unknown option --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw fail('PR_USAGE', `missing value for --${key}`);
    i += 1;
    if (key === 'scope') opts.scope.push(value); else opts[key] = value;
  }
  return opts;
}
function timeoutOf(opts) {
  if (opts['timeout-ms'] === undefined) return 120_000;
  if (!/^\d+$/.test(opts['timeout-ms'])) throw fail('PR_USAGE', '--timeout-ms must be a positive integer');
  const value = Number(opts['timeout-ms']);
  if (!Number.isSafeInteger(value) || value < 1) throw fail('PR_USAGE', '--timeout-ms must be a positive integer');
  return value;
}
function validRun(runId) {
  return RUN_RE.test(runId) && !runId.includes('..') && !runId.endsWith('.') && !runId.endsWith('.lock');
}
function receiptPath(repo, key) {
  const dir = path.resolve(repo, '.deckent/host/pr-receipts');
  const file = path.resolve(dir, `${key}.json`);
  if (path.dirname(file) !== dir) throw fail('PR_INVALID_ID', 'receipt path escaped the host receipt directory');
  return file;
}
function readReport(file) {
  if (!file) return null;
  if (file.endsWith('.json')) {
    let body; try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('PR_PATCH_SCHEMA', 'report.json is not JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('PR_PATCH_SCHEMA', 'report.json must be an object');
    const checks = Array.isArray(body.checks) ? body.checks.flatMap(item => {
      if (typeof item === 'string' && item.trim()) return [{ command: item.trim(), result: 'reported' }];
      if (item && typeof item === 'object' && typeof item.command === 'string') return [{ command: item.command, result: asString(item.result ?? item.evidence ?? 'reported') }];
      return [];
    }) : [];
    const risks = Array.isArray(body.risks) ? body.risks.map(asString) : typeof body.risks === 'string' ? [body.risks] : [];
    return { checks, risks, summary: typeof body.summary === 'string' ? body.summary : null };
  }
  const checks = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line);
    if (!match) continue;
    const command = match[1].trim(); const result = match[2].trim();
    if (!command || command === 'Exact command' || command.includes('---')) continue;
    checks.push({ command, result });
  }
  return { checks, risks: [], summary: null };
}
function loadPatch(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail('PR_PATCH_MISSING', 'patch directory is required');
  const patchFile = path.join(dir, 'patch.json'); const diffFile = path.join(dir, 'unified.diff');
  if (!fs.existsSync(patchFile) || !fs.existsSync(diffFile) || !fs.statSync(patchFile).isFile() || !fs.statSync(diffFile).isFile()) throw fail('PR_PATCH_MISSING', 'patch.json and unified.diff are required');
  let body; try { body = JSON.parse(fs.readFileSync(patchFile, 'utf8')); } catch { throw fail('PR_PATCH_SCHEMA', 'patch.json is not JSON'); }
  const patch = body?.patch;
  if (!patch || patch.kind !== 'workspace-patch' || typeof patch.identity?.runId !== 'string' || !/^[0-9a-f]{40}$/i.test(patch.baseCommit ?? '') || !Array.isArray(patch.changes)) {
    throw fail('PR_PATCH_SCHEMA', 'patch.kind, identity.runId, baseCommit and changes are required');
  }
  const reportFile = fs.existsSync(path.join(dir, 'report.json')) ? path.join(dir, 'report.json') : fs.existsSync(path.join(dir, 'report.md')) ? path.join(dir, 'report.md') : null;
  return { dir, diffFile, runId: patch.identity.runId, base: patch.baseCommit.toLowerCase(), patchSha256: sha256(patchFile), diffSha256: sha256(diffFile), reportSha256: reportFile ? sha256(reportFile) : null, report: readReport(reportFile), reportFile };
}
function bindRepo(opts) {
  const given = path.resolve(opts.repo ?? process.cwd());
  try { opts.repo = git(given, ['rev-parse', '--show-toplevel']).trim(); } catch (error) { throw fail('PR_GIT', detailOf(error)); }
  return opts.repo;
}
function isAncestor(repo, base) {
  try { git(repo, ['cat-file', '-e', `${base}^{commit}`], { raw: true }); }
  catch (error) { if (typeof error.status === 'number') return false; throw fail('PR_GIT', detailOf(error)); }
  try { git(repo, ['merge-base', '--is-ancestor', base, 'origin/main'], { raw: true }); return true; }
  catch (error) { if (typeof error.status === 'number') return false; throw fail('PR_GIT', detailOf(error)); }
}
function existingCommit(repo, branch) {
  try { return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { raw: true }).trim(); }
  catch (error) { if (typeof error.status === 'number') return null; throw fail('PR_GIT', detailOf(error)); }
}
function outsideScope(files, globs) {
  return globs.length ? files.filter(file => !globs.some(pattern => matchesGlob(file, pattern))) : [];
}
function requireScope(files, globs) {
  const paths = outsideScope(files, globs);
  if (paths.length) throw fail('PR_SCOPE_VIOLATION', paths.join(', '), { paths });
}
function readReceipt(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!body || body.schemaVersion !== 1 || typeof body.commit !== 'string' || typeof body.branch !== 'string') throw fail('PR_RECEIPT_SCHEMA', 'receipt');
    return body;
  } catch (error) { if (error.code === 'PR_RECEIPT_SCHEMA') throw error; throw fail('PR_RECEIPT_SCHEMA', 'receipt is not JSON'); }
}
function writeReceipt(file, receipt) {
  const body = { schemaVersion: 1, card: receipt.card, runId: receipt.runId, base: receipt.base, branch: receipt.branch, commit: receipt.commit, tree: receipt.tree, patchSha256: receipt.patchSha256, diffSha256: receipt.diffSha256, reportSha256: receipt.reportSha256 ?? null, phase: receipt.phase, at: receipt.at };
  if (receipt.pr) body.pr = { number: receipt.pr.number, url: receipt.pr.url };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  return body;
}
function names(cwd, args, repo) {
  return git(repo, args, { cwd, raw: true }).split('\0').filter(Boolean);
}
function mapApply(error) {
  const blob = `${error.stderr || ''}\n${error.message || ''}`;
  if (/No valid patches|empty patch/i.test(blob)) throw fail('PR_EMPTY_PATCH', 'diff produced no changes');
  throw fail('PR_PATCH_CONFLICT', detailOf(error));
}
function applyDiff(tmp, diffFile) {
  try { git(tmp, ['apply', '--index', '--check', diffFile], { raw: true }); }
  catch (error) { mapApply(error); }
  try { git(tmp, ['apply', '--index', diffFile], { raw: true }); }
  catch (error) { mapApply(error); }
}
function hostIdentity(repo) {
  const read = key => { try { return git(repo, ['config', key], { raw: true }).trim(); } catch { return ''; } };
  const name = read('user.name'); const email = read('user.email');
  if (!name || !email) throw fail('PR_GIT_IDENTITY', 'git config user.name and user.email are required');
  return { name, email };
}
function createCommit(repo, tree, parent, message) {
  const { name, email } = hostIdentity(repo);
  const file = path.join(os.tmpdir(), `deckent-pr-msg-${crypto.randomUUID()}`);
  fs.writeFileSync(file, message);
  try {
    return git(repo, ['commit-tree', tree, '-p', parent, '-F', file], { env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } }).trim();
  } finally { fs.rmSync(file, { force: true }); }
}
function withWorktree(repo, base, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-pr-'));
  try {
    git(repo, ['worktree', 'add', '--detach', tmp, base]);
    return fn(tmp);
  } finally {
    try { git(repo, ['worktree', 'remove', '--force', tmp], { raw: true }); }
    catch { fs.rmSync(tmp, { recursive: true, force: true }); }
    try { git(repo, ['worktree', 'prune'], { raw: true }); } catch { /* temporary worktree is already gone */ }
  }
}
function prepare(opts) {
  const dir = opts._[0]; const card = opts.card;
  if (!dir || !card) throw fail('PR_USAGE', USAGE);
  if (!CARD_RE.test(card)) throw fail('PR_INVALID_ID', 'card id');
  const loaded = loadPatch(path.resolve(dir));
  if (!validRun(loaded.runId)) throw fail('PR_INVALID_ID', 'run id');
  const repo = bindRepo(opts);
  if (!isAncestor(repo, loaded.base)) throw fail('PR_STALE_BASE', `${loaded.base} is not an ancestor of origin/main`);
  const branch = `lane/${card}-${loaded.runId}`;
  const file = receiptPath(repo, `${card}-${loaded.runId}`);
  const previous = readReceipt(file);
  const current = existingCommit(repo, branch);
  if (previous && current === previous.commit && previous.patchSha256 === loaded.patchSha256 && previous.diffSha256 === loaded.diffSha256 && (previous.reportSha256 ?? null) === loaded.reportSha256) {
    requireScope(names(repo, ['diff', '--name-only', '-z', previous.base, previous.commit], repo), opts.scope);
    return previous;
  }
  return withWorktree(repo, loaded.base, tmp => {
    applyDiff(tmp, loaded.diffFile);
    const files = names(tmp, ['diff', '--cached', '--name-only', '-z'], repo);
    if (!files.length) throw fail('PR_EMPTY_PATCH', 'diff produced no changes');
    requireScope(files, opts.scope);
    const tree = git(tmp, ['write-tree']).trim();
    const existing = existingCommit(repo, branch);
    if (existing) {
      const existingTree = git(repo, ['rev-parse', `${existing}^{tree}`]).trim();
      if (existingTree !== tree) throw fail('PR_BRANCH_EXISTS_DIFFERENT', branch);
      if (previous && previous.tree === tree) return previous;
      return writeReceipt(file, { ...loaded, card, branch, commit: existing, tree, phase: 'prepared', at: new Date().toISOString() });
    }
    const message = `feat(worker): ${card} ${loaded.runId}\n\npatch.json ${loaded.patchSha256}\nunified.diff ${loaded.diffSha256}\nbase ${loaded.base}\n`;
    const commit = createCommit(repo, tree, loaded.base, message);
    git(repo, ['branch', branch, commit]);
    return writeReceipt(file, { ...loaded, card, branch, commit, tree, phase: 'prepared', at: new Date().toISOString() });
  });
}
function renderBody(fields) {
  let template; try { template = fs.readFileSync(TEMPLATE, 'utf8'); } catch { throw fail('PR_GIT', 'pull request template is missing'); }
  const heads = template.split('\n').filter(line => line.startsWith('## '));
  const boxes = template.split('\n').filter(line => line.startsWith('- [ ]'));
  if (heads.length < 5 || !boxes.length) throw fail('PR_GIT', 'pull request template headings changed');
  const unknown = fields.report ? 'unknown — worker report has no structured checks' : 'unknown — worker report missing';
  const rows = fields.checks.length ? fields.checks.map(item => `| ${cell(item.command)} | ${cell(item.result)} |`).join('\n') : `| ${unknown} | ${unknown} |`;
  const risks = fields.risks.length ? fields.risks.map(item => `- ${cell(item)}`).join('\n') : (fields.report ? 'unknown — worker report has no risks field' : 'unknown — worker report missing');
  return `${heads[0]}\n\n- Owner-admitted PLAN card id: ${fields.card}\n- Branch (\`lane/<card>\`, worker \`lane/<card>-<runId>\` or \`release/<version>\`): ${fields.branch}\n- Base commit / candidate commit: ${fields.base} / ${fields.commit}\n- Author / worker run id (if applicable): ${fields.runId}\n\n${heads[1]}\n\n${fields.summary ? `Worker report summary: ${cell(fields.summary)}\n\n` : ''}Changed files:\n${fields.files.map(file => `- ${file}`).join('\n')}\n\n${heads[2]}\n\n${fields.checks.length ? 'Checks below are copied from the worker report.' : unknown}\n\n| Exact command | Result / evidence |\n|---|---|\n${rows}\n\n${heads[3]}\n\n- Status: pending\n- Independent reviewer and evidence link:\n- Blocking findings and resolution:\n\nAuthor checks, worker reports, Jev and CI do not constitute independent PASS.\nLanding remains the lead's gate: independent review + targeted checks and owner authorization.\n\n${heads[4]}\n\n${risks}\n\n${boxes.join('\n')}\n`;
}
function remoteOid(stdout, branch) {
  const line = stdout.split('\n').map(item => item.trim()).find(item => item.endsWith(`refs/heads/${branch}`));
  if (!line) return null;
  const oid = line.split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(oid)) throw fail('PR_REMOTE_DIVERGED', 'remote ref is not a commit');
  return oid;
}
function markUncertain(repo, receipt) {
  writeReceipt(receiptPath(repo, `${receipt.card}-${receipt.runId}`), { ...receipt, phase: 'uncertain', at: new Date().toISOString() });
  throw fail('PR_UNCERTAIN', `${receipt.branch} was not confirmed on the remote`);
}
function prFromUrl(stdout) {
  const url = stdout.trim().split('\n').filter(Boolean).at(-1) || '';
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!/^https?:\/\//.test(url) || !Number.isSafeInteger(number)) throw fail('PR_GH_FAILED', 'pr create returned no pull url');
  return { number, url };
}
function publish(repo, receipt, loaded, opts) {
  if (receipt.phase === 'opened' && Number.isSafeInteger(receipt.pr?.number) && typeof receipt.pr?.url === 'string') return receipt;
  const timeout = timeoutOf(opts); const remote = opts.remote ?? 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(remote) || remote.includes('..')) throw fail('PR_USAGE', '--remote');
  const file = receiptPath(repo, `${receipt.card}-${receipt.runId}`);
  let listed;
  try { listed = git(repo, ['ls-remote', remote, `refs/heads/${receipt.branch}`], { raw: true, timeout }); }
  catch (error) { if (isUncertain(error)) markUncertain(repo, receipt); throw fail('PR_PUSH_FAILED', detailOf(error)); }
  const oid = remoteOid(listed, receipt.branch);
  if (oid && oid !== receipt.commit) throw fail('PR_REMOTE_DIVERGED', `${remote} ${receipt.branch} is ${oid}`);
  if (!oid) {
    try { git(repo, ['push', remote, `${receipt.branch}:refs/heads/${receipt.branch}`], { raw: true, timeout }); }
    catch (error) { if (isUncertain(error)) markUncertain(repo, receipt); throw fail('PR_PUSH_FAILED', detailOf(error)); }
  }
  let prs;
  try { prs = JSON.parse(gh(repo, ['pr', 'list', '--head', receipt.branch, '--state', 'all', '--json', 'number,url,headRefOid'], { timeout }) || '[]'); }
  catch (error) { if (error.code === 'PR_GH_FAILED') throw error; if (isUncertain(error)) markUncertain(repo, receipt); throw fail('PR_GH_FAILED', detailOf(error)); }
  if (!Array.isArray(prs)) throw fail('PR_GH_FAILED', 'pr list was not a JSON array');
  const found = prs.find(item => asString(item.headRefOid).toLowerCase() === receipt.commit && Number.isSafeInteger(item.number) && typeof item.url === 'string');
  if (found) return writeReceipt(file, { ...receipt, phase: 'opened', at: new Date().toISOString(), pr: { number: found.number, url: found.url } });
  const files = names(repo, ['diff', '--name-only', '-z', receipt.base, receipt.commit], repo);
  const body = renderBody({ ...receipt, files, checks: loaded.report?.checks ?? [], risks: loaded.report?.risks ?? [], summary: loaded.report?.summary ?? null, report: Boolean(loaded.reportFile) });
  const bodyFile = path.join(os.tmpdir(), `deckent-pr-body-${crypto.randomUUID()}.md`);
  fs.writeFileSync(bodyFile, body);
  try {
    const created = prFromUrl(gh(repo, ['pr', 'create', '--base', 'main', '--head', receipt.branch, '--title', `feat(worker): ${receipt.card} ${receipt.runId}`, '--body-file', bodyFile], { timeout }));
    return writeReceipt(file, { ...receipt, phase: 'opened', at: new Date().toISOString(), pr: created });
  } catch (error) {
    if (error.code === 'PR_GH_FAILED') throw error;
    if (isUncertain(error)) markUncertain(repo, receipt);
    throw error;
  } finally { fs.rmSync(bodyFile, { force: true }); }
}
function open(opts) {
  if (!opts.push) throw fail('PR_PUSH_NOT_AUTHORIZED', 'pass --push to push and open a pull request');
  timeoutOf(opts);
  if (opts.remote !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(opts.remote) || opts.remote.includes('..'))) throw fail('PR_USAGE', '--remote');
  const receipt = prepare(opts);
  return publish(opts.repo, receipt, loadPatch(path.resolve(opts._[0])), opts);
}
function status(opts) {
  const key = opts._[0];
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,160}$/.test(key) || key.includes('..')) throw fail('PR_USAGE', USAGE);
  const repo = bindRepo(opts);
  const receipt = readReceipt(receiptPath(repo, key));
  if (!receipt) throw fail('PR_RECEIPT_MISSING', key);
  return receipt;
}
function formatStatus(receipt) {
  const pr = receipt.pr ? `${receipt.pr.number} ${receipt.pr.url}` : '—';
  return `phase: ${receipt.phase}\ncard: ${receipt.card}\nrun: ${receipt.runId}\nbranch: ${receipt.branch}\nbase: ${receipt.base}\ncommit: ${receipt.commit}\ntree: ${receipt.tree}\npr: ${pr}\n`;
}
function emit(receipt, json) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, code: null, phase: receipt.phase, branch: receipt.branch, commit: receipt.commit, tree: receipt.tree, receipt })}\n`);
  else process.stdout.write(formatStatus(receipt));
}
function failOut(error, json) {
  const payload = { ok: false, code: typeof error.code === 'string' ? error.code : 'PR_ERROR', detail: error.detail ?? error.message };
  if (error.paths) payload.paths = error.paths;
  const line = `${payload.code}${payload.detail ? `: ${payload.detail}` : ''}${payload.paths ? ` ${payload.paths.join(', ')}` : ''}\n`;
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`); else process.stderr.write(line);
  process.exitCode = payload.code === 'PR_USAGE' ? 2 : 3;
}
function main() {
  const [command, ...rest] = process.argv.slice(2);
  let opts = { json: rest.includes('--json') };
  try {
    opts = parseArgs(rest);
    if (command === 'prepare') return emit(prepare(opts), opts.json);
    if (command === 'open') return emit(open(opts), opts.json);
    if (command === 'status') return emit(status(opts), opts.json);
    throw fail('PR_USAGE', USAGE);
  } catch (error) { failOut(error, Boolean(opts.json)); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
