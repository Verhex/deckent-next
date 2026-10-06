#!/usr/bin/env node
// Local mirror of the ubuntu job in .github/workflows/ci.yml (developer tooling; no dependencies).
// Runs the repository's own scripts/ci-*.mjs|sh in the workflow's order, on a clean worktree of an exact SHA,
// with HOME/XDG/DECKENT_GLOBAL_HOME isolated. It does not cover macOS or Windows cells.
// Usage: node scripts/ci-local.mjs [--ref <git-ref|HEAD>] [--node 24|26] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
    if (/^(DECKENT_|GITHUB_|RUNNER_|LC_|LANG$|LANGUAGE$|XDG_|HOME$|USERPROFILE$|TMPDIR$|TMP$|TEMP$)/u.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function parseArgs(argv) {
  const options = { ref: 'HEAD', node: '24', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--ref' || arg === '--node') {
      const value = argv[++i];
      if (!value) throw new Error(`CI_LOCAL_USAGE: ${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`CI_LOCAL_USAGE: unknown argument ${arg}`);
  }
  if (!/^\d+$/u.test(options.node)) throw new Error('CI_LOCAL_USAGE: --node must be a major number (24 or 26)');
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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** One full run at a time per repository (all worktrees share the git common dir). */
function acquireLock(path, info) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify(info)); closeSync(fd);
      return () => { try { rmSync(path); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = {};
      try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable lock is treated as stale */ }
      if (holder.pid && pidAlive(holder.pid)) throw new Error(`CI_LOCAL_BUSY: another ci:local run holds the lock (pid ${holder.pid}, ref ${holder.ref}, since ${holder.startedAt}). Wait for it; two full runs overload the machine.`);
      rmSync(path, { force: true });
    }
  }
  throw new Error('CI_LOCAL_LOCK_UNAVAILABLE');
}

function runStep(label, command, args, { cwd, env, logFile, tee }) {
  return new Promise(resolveStep => {
    const out = openSync(logFile, 'a');
    appendFileSync(logFile, `\n=== ${label}: ${command} ${args.join(' ')} ===\n`);
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    const sink = tee ? openSync(tee, 'a') : null;
    const forward = chunk => {
      appendFileSync(out, chunk); if (sink !== null) appendFileSync(sink, chunk);
      if (process.env.CI_LOCAL_QUIET !== '1') process.stdout.write(chunk);
    };
    child.stdout.on('data', forward); child.stderr.on('data', forward);
    child.on('close', (code, signal) => {
      activeChild = null; closeSync(out); if (sink !== null) closeSync(sink);
      const seconds = Math.round((Date.now() - started) / 1000);
      process.stdout.write(`--- ${label}: ${code === 0 ? 'success' : `failure (${signal ?? `exit ${code}`})`} in ${seconds}s\n`);
      resolveStep({ code: code ?? 1, seconds });
    });
    child.on('error', error => { appendFileSync(logFile, `spawn error: ${error.message}\n`); resolveStep({ code: 127, seconds: 0 }); });
  });
}

let activeChild = null;

export async function main(argv) {
  const options = parseArgs(argv);
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const sha = git(repo, 'rev-parse', '--verify', `${options.ref}^{commit}`);
  const commonDir = resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
  const nodeBin = findNodeBin(options.node);
  const nodeVersion = spawnSync(join(nodeBin, 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();
  const logDir = join(repo, '.pack', 'ci-local', `${sha.slice(0, 12)}-node${options.node}`);
  const release = acquireLock(join(commonDir, 'ci-local.lock'), { pid: process.pid, ref: sha, startedAt: new Date().toISOString() });
  rmSync(logDir, { recursive: true, force: true }); mkdirSync(logDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'ci-local-'));
  const wt = join(scratch, 'wt');
  const dirs = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'runner-temp', 'tmp', 'global-home'].map(n => [n, join(scratch, n)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const githubEnvFile = join(scratch, 'github-env'); writeFileSync(githubEnvFile, '');
  const stepSummary = join(scratch, 'step-summary'); writeFileSync(stepSummary, '');
  const started = Date.now();
  let worktreeAdded = false;
  const cleanup = () => {
    if (activeChild) activeChild.kill('SIGTERM');
    if (!options.keep) {
      if (worktreeAdded) spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
      rmSync(scratch, { recursive: true, force: true });
      spawnSync('git', ['worktree', 'prune'], { cwd: repo });
    }
    release();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

  const outcomes = { temporaryParent: 'skipped', npmCi: 'skipped', dockerFixture: 'skipped', bubblewrap: 'skipped', shellRealm: 'skipped', verification: 'skipped' };
  const durations = {};
  let failed = false;
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
      if (failed) return;
      Object.assign(env, parseEnvFile(readFileSync(githubEnvFile, 'utf8')));
      const result = await runStep(label, command, args, { cwd: wt, env: { ...env, ...extra.env }, logFile: join(logDir, `${label}.log`), tee: extra.tee });
      outcomes[key] = result.code === 0 ? 'success' : 'failure'; durations[label] = result.seconds;
      if (result.code !== 0) failed = true;
    };
    await step('temporaryParent', 'temporary-parent', 'node', ['scripts/ci-temporary-environment.mjs']);
    await step('npmCi', 'npm-ci', 'npm', ['ci']);
    await step('dockerFixture', 'docker-fixture', 'bash', ['scripts/ci-docker-fixture.sh']);
    const bwrapOut = join(dirs['runner-temp'], 'bwrap-x86_64');
    await step('bubblewrap', 'bubblewrap-build', 'node', ['scripts/build-bwrap.mjs', '--arch', 'x86_64', '--out', bwrapOut]);
    await step('bubblewrap', 'bubblewrap-stage', 'node', ['scripts/build-bwrap.mjs', '--stage-dev', bwrapOut]);
    appendFileSync(githubEnvFile, `DECKENT_GLOBAL_HOME=${join(dirs['runner-temp'], 'deckent-global')}\n`);
    await step('shellRealm', 'build', 'node', ['scripts/build.mjs']);
    await step('shellRealm', 'shell-realm', 'node', ['scripts/ci-shell-realm.mjs']);
    mkdirSync(join(wt, '.pack', 'ci-evidence'), { recursive: true });
    await step('verification', 'verify', 'bash', ['-c', 'set -o pipefail; npm run verify 2>&1 | tee .pack/ci-evidence/verify.log'],
      { env: { DECKENT_TEST_STARTUP_COST: '1', DECKENT_TEST_TIMEOUT_MS: '30000' } });
    // The summary step is always() in the workflow.
    const summaryEnv = { ...env, DECKENT_CI_VERIFY_OUTCOME: outcomes.verification, DECKENT_CI_TEMP_OUTCOME: outcomes.temporaryParent,
      DECKENT_CI_INSTALL_OUTCOME: outcomes.npmCi, DECKENT_CI_DOCKER_OUTCOME: outcomes.dockerFixture,
      DECKENT_CI_BWRAP_OUTCOME: outcomes.bubblewrap, DECKENT_CI_REALM_OUTCOME: outcomes.shellRealm };
    mkdirSync(join(wt, '.pack', 'ci-evidence'), { recursive: true });
    const summaryResult = await runStep('verification-summary', 'node', ['scripts/ci-verification-summary.mjs'],
      { cwd: wt, env: summaryEnv, logFile: join(logDir, 'verification-summary.log') });
    if (summaryResult.code !== 0) failed = true;
    cpSync(join(wt, '.pack', 'ci-evidence'), join(logDir, 'ci-evidence'), { recursive: true });
    // Keep downloaded bubblewrap sources for the next run.
    const ownCache = join(repo, '.pack', 'bwrap', 'cache');
    if (existsSync(wtCache) && readdirSync(wtCache).length && !(existsSync(ownCache) && readdirSync(ownCache).length)) {
      mkdirSync(ownCache, { recursive: true }); cpSync(wtCache, ownCache, { recursive: true });
    }
  } catch (error) {
    failed = true; process.stderr.write(`ci:local error: ${error.message}\n`);
  }
  const total = Math.round((Date.now() - started) / 1000);
  let evidence = null; let failedTests = [];
  try {
    const summary = JSON.parse(readFileSync(join(logDir, 'ci-evidence', 'verify-evidence.json'), 'utf8'));
    evidence = summary.evidence; failedTests = summary.failedTests;
  } catch { /* summary not produced */ }
  const report = { ref: options.ref, sha, node: nodeVersion, outcomes, stepSeconds: durations, totalSeconds: total,
    counts: evidence?.counts ?? null, failedTests: failedTests.map(t => `${t.file ?? ''} :: ${t.test}`), exit: failed ? 1 : 0 };
  writeFileSync(join(logDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`\nci:local result: ${failed ? 'FAILED' : 'PASSED'} in ${Math.floor(total / 60)}m${total % 60}s (node ${nodeVersion}, ${sha.slice(0, 12)})\n`);
  process.stdout.write(`outcomes: ${JSON.stringify(outcomes)}\n`);
  if (report.counts) process.stdout.write(`tests: ${JSON.stringify(report.counts)}\n`);
  if (failedTests.length) process.stdout.write(`failed tests (${failedTests.length}):\n${report.failedTests.map(t => `  - ${t}`).join('\n')}\n`);
  process.stdout.write(`logs: ${logDir}${options.keep ? `\nkept worktree: ${wt}` : ''}\n`);
  cleanup();
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
}
