#!/usr/bin/env node
// Local mirror of the ubuntu job in .github/workflows/ci.yml (developer tooling; no dependencies).
// Runs the repository's own scripts/ci-*.mjs|sh in the workflow's order, on a clean worktree of an exact SHA,
// with HOME/XDG/DECKENT_GLOBAL_HOME isolated. It does not cover macOS or Windows cells.
// Usage: node scripts/ci-local.mjs [--ref <git-ref|HEAD>] [--node 24|26] [--keep] [--deadline <minutes, default 30>]
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCKER_IMAGE = 'node@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe';

/** Parses a GITHUB_ENV style file (KEY=VALUE lines) the way the runner merges it between steps. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/u)) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/** Environment inherited from the owner's shell, minus anything that can leak owner state or language. */
export function cleanBaseEnv(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    // VITEST_*/NODE_OPTIONS/GIT_*/npm_*: lane-worker tuning or owner repo state must not change the 4-worker CI shape.
    if (/^(DECKENT_|GITHUB_|RUNNER_|LC_|LANG$|LANGUAGE$|XDG_|HOME$|USERPROFILE$|TMPDIR$|TMP$|TEMP$|VITEST_|NODE_OPTIONS$|GIT_|npm_|NPM_)/u.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function parseArgs(argv) {
  const options = { ref: 'HEAD', node: '24', keep: false, deadline: '30' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--ref' || arg === '--node' || arg === '--deadline') {
      const value = argv[++i];
      if (!value) throw new Error(`CI_LOCAL_USAGE: ${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`CI_LOCAL_USAGE: unknown argument ${arg}`);
  }
  if (!/^\d+$/u.test(options.node)) throw new Error('CI_LOCAL_USAGE: --node must be a major number (24 or 26)');
  if (!/^\d+$/u.test(options.deadline) || Number(options.deadline) < 1) throw new Error('CI_LOCAL_USAGE: --deadline is whole minutes >= 1 (default 30, the workflow job bound)');
  return options;
}

/** Finds the bin directory of a node major: the running node, then nvm and fnm installs. Explicit error otherwise. */
export function findNodeBin(major, env = process.env) {
  if (String(process.versions.node.split('.')[0]) === major) return dirname(process.execPath);
  const roots = [
    join(env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node'),
    join(env.FNM_DIR || join(homedir(), '.local', 'share', 'fnm'), 'node-versions'),
    join(homedir(), '.fnm', 'node-versions'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(`v${major}.`)) continue;
      const bin = existsSync(join(root, name, 'installation', 'bin')) ? join(root, name, 'installation', 'bin') : join(root, name, 'bin');
      if (existsSync(join(bin, 'node'))) found.push({ name, bin });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!found.length) throw new Error(`CI_LOCAL_NODE_UNAVAILABLE: node ${major} not found (running ${process.version}; searched nvm/fnm). Install it, e.g. "nvm install ${major}".`);
  return found.at(-1).bin;
}

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The mirror manages POSIX process groups and an ubuntu workflow; Windows is a typed refusal, not a degraded run. */
export function assertSupportedPlatform(platform = process.platform) {
  if (platform === 'win32') throw new Error('CI_LOCAL_UNSUPPORTED_PLATFORM: ci:local needs POSIX process groups (negative-pid signals) and mirrors the ubuntu job; Windows is not supported');
}

/** A step whose process group could not be proven empty holds the run: it fails and nothing may be cleaned up. */
export function classifyStep(result) {
  const hold = result.reaped?.settled === false;
  return { outcome: result.code === 0 && !hold ? 'success' : 'failure', hold };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function groupAlive(pgid) { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Empties a whole process group: SIGTERM, bounded wait, SIGKILL, bounded wait. Returns exit evidence. */
export async function stopGroup(pgid, { termMs = 10_000, killMs = 5_000 } = {}) {
  const evidence = { pgid, sentTerm: false, sentKill: false, settled: !groupAlive(pgid), waitedMs: 0 };
  if (evidence.settled) return evidence;
  const started = Date.now();
  try { process.kill(-pgid, 'SIGTERM'); evidence.sentTerm = true; } catch { /* group vanished */ }
  while (groupAlive(pgid) && Date.now() - started < termMs) await sleep(50);
  if (groupAlive(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); evidence.sentKill = true; } catch { /* group vanished */ }
    while (groupAlive(pgid) && Date.now() - started < termMs + killMs) await sleep(50);
  }
  evidence.settled = !groupAlive(pgid); evidence.waitedMs = Date.now() - started;
  return evidence;
}

function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function lockBusyMessage(holder) {
  return `CI_LOCAL_BUSY: another ci:local run holds the lock (pid ${holder.pid}${holder.pgid ? `, process group ${holder.pgid}` : ''}, ref ${holder.ref}, since ${holder.startedAt}). Wait for it; two full runs overload the machine.`;
}
function publishAtomically(path, text, { exclusive }) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, text);
  try {
    if (exclusive) linkSync(temporary, path); else renameSync(temporary, path); // link fails with EEXIST: atomic, complete-content publication
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * One full run at a time per repository (all worktrees share the git common dir). The lock is published complete
 * (temp file + link), is owned by a token, and counts as held while the run process OR its step process group lives.
 * An unreadable lock is treated as held (fail closed); only a lock whose recorded pid and group are both gone is stale.
 */
export function acquireLock(path, info) {
  const token = randomBytes(8).toString('hex');
  const state = { ...info, token, pgid: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      publishAtomically(path, JSON.stringify(state), { exclusive: true });
      return {
        setGroup(pgid) { state.pgid = pgid; if (readLock(path)?.token === token) publishAtomically(path, JSON.stringify(state), { exclusive: false }); },
        release() { if (readLock(path)?.token === token) rmSync(path, { force: true }); },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readLock(path);
    if (!holder || !holder.token) throw new Error(`CI_LOCAL_BUSY: lock ${path} is unreadable; refusing (fail closed). Remove it manually only if no ci:local run is active.`);
    if (pidAlive(holder.pid) || (holder.pgid && groupAlive(holder.pgid))) throw new Error(lockBusyMessage(holder));
    // Stale: move it aside first so a concurrent winner's fresh lock is never deleted by mistake.
    const aside = `${path}.stale.${process.pid}`;
    try { renameSync(path, aside); } catch { continue; }
    if (readLock(aside)?.token !== holder.token) { try { linkSync(aside, path); } catch { /* someone re-published */ } rmSync(aside, { force: true }); throw new Error(lockBusyMessage(readLock(path) ?? holder)); }
    rmSync(aside, { force: true });
  }
  throw new Error('CI_LOCAL_LOCK_UNAVAILABLE');
}

let activeGroup = null;

/** Runs one step in its own process group; the group is reaped after exit and on timeout. */
export function runStep(label, command, args, { cwd, env, logFile, tee, timeoutMs, onGroup, reap = stopGroup }) {
  return new Promise(resolveStep => {
    const out = openSync(logFile, 'a');
    appendFileSync(logFile, `\n=== ${label}: ${command} ${args.join(' ')} ===\n`);
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pgid = child.pid;
    if (pgid) { activeGroup = pgid; onGroup?.(pgid); }
    const sink = tee ? openSync(tee, 'a') : null;
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; appendFileSync(logFile, `step deadline ${timeoutMs}ms reached; stopping process group\n`); if (pgid) void reap(pgid); }, timeoutMs) : null;
    const forward = chunk => {
      appendFileSync(out, chunk); if (sink !== null) appendFileSync(sink, chunk);
      if (process.env.CI_LOCAL_QUIET !== '1') process.stdout.write(chunk);
    };
    child.stdout.on('data', forward); child.stderr.on('data', forward);
    child.on('close', async (code, signal) => {
      if (timer) clearTimeout(timer);
      // Descendants that outlived the step (and closed their pipes) are reaped before the next step or any cleanup.
      const reaped = pgid ? await reap(pgid) : { settled: true };
      if (reaped.sentTerm) appendFileSync(logFile, `leaked descendants reaped after step exit: ${JSON.stringify(reaped)}\n`);
      if (activeGroup === pgid && reaped.settled) activeGroup = null;
      closeSync(out); if (sink !== null) closeSync(sink);
      const seconds = Math.round((Date.now() - started) / 1000);
      const status = timedOut ? 'failure (step deadline)' : code === 0 ? 'success' : `failure (${signal ?? `exit ${code}`})`;
      process.stdout.write(`--- ${label}: ${status} in ${seconds}s\n`);
      resolveStep({ code: timedOut ? 124 : (code ?? 1), seconds, reaped });
    });
    child.on('error', error => { appendFileSync(logFile, `spawn error: ${error.message}\n`); resolveStep({ code: 127, seconds: 0 }); });
  });
}

export async function main(argv, deps = {}) {
  assertSupportedPlatform();
  const options = parseArgs(argv);
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const sha = git(repo, 'rev-parse', '--verify', `${options.ref}^{commit}`);
  const commonDir = resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
  const nodeBin = findNodeBin(options.node);
  const nodeVersion = spawnSync(join(nodeBin, 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();
  const logDir = join(repo, '.pack', 'ci-local', `${sha.slice(0, 12)}-node${options.node}`);
  const lock = acquireLock(join(commonDir, 'ci-local.lock'), { pid: process.pid, ref: sha, startedAt: new Date().toISOString() });
  rmSync(logDir, { recursive: true, force: true }); mkdirSync(logDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'ci-local-'));
  const wt = join(scratch, 'wt');
  const dirs = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'runner-temp', 'tmp', 'global-home'].map(n => [n, join(scratch, n)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // Hosted runner homes are not empty (tests such as S9 need a regular file in HOME); seed neutral dotfiles, no owner content.
  for (const name of ['.profile', '.bashrc']) writeFileSync(join(dirs.home, name), '# ci-local placeholder\n');
  const githubEnvFile = join(scratch, 'github-env'); writeFileSync(githubEnvFile, '');
  const stepSummary = join(scratch, 'step-summary'); writeFileSync(stepSummary, '');
  const started = Date.now();
  let worktreeAdded = false;
  const cleanup = () => {
    if (!options.keep) {
      if (worktreeAdded) spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
      rmSync(scratch, { recursive: true, force: true });
      spawnSync('git', ['worktree', 'prune'], { cwd: repo });
    }
    lock.release();
  };
  // Cancellation and the whole-run deadline empty the active step's process group FIRST; the worktree is removed and the
  // lock released only after the group is verified gone. If it cannot be settled the lock stays (it records the group).
  let aborting = null;
  const abort = (reason, code) => {
    if (aborting) return aborting.done;
    const record = { reason, code, at: new Date().toISOString(), group: null };
    aborting = record;
    process.stderr.write(`ci:local ${reason}: stopping the active process group before cleanup\n`);
    record.done = (async () => {
      record.group = activeGroup ? await stopGroup(activeGroup) : { settled: true, pgid: null };
      if (record.group.settled) activeGroup = null;
      try { writeFileSync(join(logDir, 'cancel.json'), JSON.stringify({ reason, code, at: record.at, group: record.group }, null, 2) + '\n'); } catch { /* log dir already gone */ }
      if (record.group.settled) cleanup();
      else process.stderr.write(`ci:local: process group ${record.group.pgid} still alive after SIGKILL; lock and worktree kept (fail closed)\n`);
      process.exit(code);
    })();
    return record.done;
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void abort(sig, 130); });
  const deadlineTimer = setTimeout(() => { void abort(`deadline ${options.deadline}m`, 124); }, Number(options.deadline) * 60_000);
  deadlineTimer.unref();

  const outcomes = { temporaryParent: 'skipped', npmCi: 'skipped', dockerFixture: 'skipped', bubblewrap: 'skipped', shellRealm: 'skipped', verification: 'skipped' };
  const durations = {};
  let failed = false;
  let unsettled = null; // a step group that could not be proven gone: custody stays, nothing is cleaned up
  try {
    process.stdout.write(`ci:local ref=${options.ref} sha=${sha} node=${nodeVersion} scratch=${scratch} logs=${logDir}\n`);
    git(repo, 'worktree', 'add', '--detach', wt, sha); worktreeAdded = true;
    // CI shell reaches `bash` steps with the runner's clean HOME; the owner's HOME/.deckent/locale must not leak.
    const env = { ...cleanBaseEnv(process.env), PATH: `${nodeBin}${delimiter}${process.env.PATH}`,
      HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      DECKENT_GLOBAL_HOME: dirs['global-home'], LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true',
      GITHUB_ENV: githubEnvFile, GITHUB_STEP_SUMMARY: stepSummary, RUNNER_TEMP: dirs['runner-temp'],
      GITHUB_SHA: sha, GITHUB_REF: options.ref,
      // Bytes only: reuse the owner's npm download cache and docker client config without their user config.
      npm_config_cache: process.env.npm_config_cache || join(homedir(), '.npm'),
      npm_config_userconfig: join(scratch, 'npmrc') };
    if (existsSync(join(homedir(), '.docker')) && !process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = join(homedir(), '.docker');
    // Seed the locked bubblewrap downloads (verified by hash in build-bwrap.mjs) so a network outage cannot fail the run.
    const wtCache = join(wt, '.pack', 'bwrap', 'cache');
    const roots = [repo, resolve(commonDir, '..'), ...git(repo, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9))];
    const seed = roots.map(r => join(r, '.pack', 'bwrap', 'cache')).find(c => c !== wtCache && existsSync(c) && readdirSync(c).length);
    mkdirSync(wtCache, { recursive: true });
    if (seed) { cpSync(seed, wtCache, { recursive: true }); process.stdout.write(`bwrap cache seeded from ${seed}\n`); }
    else process.stdout.write('bwrap cache: no local seed found; build will download\n');
    // Docker: the workflow script always pulls. When the pinned digest is already local, skip only the pull (offline-safe).
    const shimDir = join(scratch, 'shim'); mkdirSync(shimDir);
    const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { env, encoding: 'utf8' }).stdout.trim();
    const present = realDocker && spawnSync(realDocker, ['image', 'inspect', '--format', '{{.Id}}', DOCKER_IMAGE], { env, stdio: 'ignore' }).status === 0;
    if (present) {
      writeFileSync(join(shimDir, 'docker'), `#!/bin/sh\nif [ "$1" = pull ]; then echo "ci-local: pinned image already local, pull skipped"; exit 0; fi\nexec "${realDocker}" "$@"\n`);
      chmodSync(join(shimDir, 'docker'), 0o755); env.PATH = `${shimDir}${delimiter}${env.PATH}`;
    }
    const step = async (key, label, command, args, extra = {}) => {
      if (failed || aborting || unsettled) return;
      Object.assign(env, parseEnvFile(readFileSync(githubEnvFile, 'utf8')));
      const result = await runStep(label, command, args, { cwd: wt, env: { ...env, ...extra.env }, logFile: join(logDir, `${label}.log`), tee: extra.tee, timeoutMs: extra.timeoutMs, onGroup: pgid => lock.setGroup(pgid), reap: deps.reap });
      const { outcome, hold } = classifyStep(result);
      outcomes[key] = outcome; durations[label] = result.seconds;
      if (outcome !== 'success') failed = true;
      if (hold) unsettled = { step: label, group: result.reaped };
    };
    await step('temporaryParent', 'temporary-parent', 'node', ['scripts/ci-temporary-environment.mjs']);
    await step('npmCi', 'npm-ci', 'npm', ['ci']);
    await step('dockerFixture', 'docker-fixture', 'bash', ['scripts/ci-docker-fixture.sh']);
    const bwrapOut = join(dirs['runner-temp'], 'bwrap-x86_64');
    await step('bubblewrap', 'bubblewrap-build', 'node', ['scripts/build-bwrap.mjs', '--arch', 'x86_64', '--out', bwrapOut]);
    await step('bubblewrap', 'bubblewrap-stage', 'node', ['scripts/build-bwrap.mjs', '--stage-dev', bwrapOut]);
    appendFileSync(githubEnvFile, `DECKENT_GLOBAL_HOME=${join(dirs['runner-temp'], 'deckent-global')}\n`);
    await step('shellRealm', 'build', 'node', ['scripts/build.mjs']);
    // The archived revision owns its verification protocol; older refs keep their original verify.
    const reuseBuild = existsSync(join(wt, 'scripts/ci-build-artifact.mjs'))
      && typeof JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).scripts?.['verify:built'] === 'string';
    if (reuseBuild) await step('shellRealm', 'seal-build', 'node', ['scripts/ci-build-artifact.mjs', 'seal']);
    await step('shellRealm', 'shell-realm', 'node', ['scripts/ci-shell-realm.mjs']);
    mkdirSync(join(wt, '.pack', 'ci-evidence'), { recursive: true });
    await step('verification', 'verify', 'bash', ['-c', `set -o pipefail; npm run ${reuseBuild ? 'verify:built' : 'verify'} 2>&1 | tee .pack/ci-evidence/verify.log`],
      { env: { DECKENT_TEST_STARTUP_COST: '1', DECKENT_TEST_TIMEOUT_MS: '30000' }, timeoutMs: 20 * 60_000 }); // workflow verify step bound
    if (aborting) await aborting.done;
    // The summary step is always() in the workflow.
    const summaryEnv = { ...env, DECKENT_CI_VERIFY_OUTCOME: outcomes.verification, DECKENT_CI_TEMP_OUTCOME: outcomes.temporaryParent,
      DECKENT_CI_INSTALL_OUTCOME: outcomes.npmCi, DECKENT_CI_DOCKER_OUTCOME: outcomes.dockerFixture,
      DECKENT_CI_BWRAP_OUTCOME: outcomes.bubblewrap, DECKENT_CI_REALM_OUTCOME: outcomes.shellRealm };
    mkdirSync(join(wt, '.pack', 'ci-evidence'), { recursive: true });
    if (!unsettled) {
      const summaryResult = await runStep('verification-summary', 'node', ['scripts/ci-verification-summary.mjs'],
        { cwd: wt, env: summaryEnv, logFile: join(logDir, 'verification-summary.log'), onGroup: pgid => lock.setGroup(pgid), reap: deps.reap });
      const { outcome, hold } = classifyStep(summaryResult);
      if (outcome !== 'success') failed = true;
      if (hold) unsettled = { step: 'verification-summary', group: summaryResult.reaped };
    }
    cpSync(join(wt, '.pack', 'ci-evidence'), join(logDir, 'ci-evidence'), { recursive: true });
    // Keep downloaded bubblewrap sources for the next run.
    const ownCache = join(repo, '.pack', 'bwrap', 'cache');
    if (existsSync(wtCache) && readdirSync(wtCache).length && !(existsSync(ownCache) && readdirSync(ownCache).length)) {
      mkdirSync(ownCache, { recursive: true }); cpSync(wtCache, ownCache, { recursive: true });
    }
  } catch (error) {
    failed = true; process.stderr.write(`ci:local error: ${error.message}\n`);
  }
  if (aborting) await aborting.done;
  clearTimeout(deadlineTimer);
  const total = Math.round((Date.now() - started) / 1000);
  let evidence = null; let failedTests = [];
  try {
    const summary = JSON.parse(readFileSync(join(logDir, 'ci-evidence', 'verify-evidence.json'), 'utf8'));
    evidence = summary.evidence; failedTests = summary.failedTests;
  } catch { /* summary not produced */ }
  const report = { ref: options.ref, sha, node: nodeVersion, outcomes, stepSeconds: durations, totalSeconds: total,
    counts: evidence?.counts ?? null, failedTests: failedTests.map(t => `${t.file ?? ''} :: ${t.test}`), unsettled, exit: failed ? 1 : 0 };
  writeFileSync(join(logDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`\nci:local result: ${failed ? 'FAILED' : 'PASSED'} in ${Math.floor(total / 60)}m${total % 60}s (node ${nodeVersion}, ${sha.slice(0, 12)})\n`);
  process.stdout.write(`outcomes: ${JSON.stringify(outcomes)}\n`);
  if (report.counts) process.stdout.write(`tests: ${JSON.stringify(report.counts)}\n`);
  if (failedTests.length) process.stdout.write(`failed tests (${failedTests.length}):\n${report.failedTests.map(t => `  - ${t}`).join('\n')}\n`);
  process.stdout.write(`logs: ${logDir}${options.keep ? `\nkept worktree: ${wt}` : ''}\n`);
  if (unsettled) {
    process.stderr.write(`ci:local: process group of step ${unsettled.step} not proven gone; FAILED, lock and worktree kept (fail closed): ${JSON.stringify(unsettled.group)}\n`);
    return 1;
  }
  cleanup();
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
}
