import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorChecks, firstJobStages, firstJobSteps, onboardingNext, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';

// The work family's actual stage decisions replace the old parallel first-job registry.
describe('U3-1a first-job states', () => {
  it('derives missing onboarding steps from family states, preserves supplied execution states and points doctor to the terminal', () => {
    const stages = firstJobStages({ execution: false, registry: false, pool: false }, 'erp-demo');
    expect(firstJobSteps(stages).map(stage => [stage.id, stage.state])).toEqual([['work:kind', 'blocked'], ['work:pool', 'blocked']]);
    expect(firstJobSteps(firstJobStages({ execution: true, registry: true, pool: false }, 'erp-demo')).map(stage => stage.id)).toEqual(['work:pool']);
    expect(firstJobSteps(firstJobStages({ execution: true, registry: true, pool: true }, 'erp-demo'))).toEqual([]);
    expect(firstJobSteps([{ id: 'execution:worker', phase: 'onboarding', title: 'setup.execution.workerTitle', state: 'needs-answer' },
      { id: 'core:policy', phase: 'install', title: 'setup.stage.policy', state: 'blocked' }]).map(stage => stage.id)).toEqual(['execution:worker']);
    expect(onboardingNext('Pool', 'en')).toContain('/setup');
    const report = { platform: 'linux', host: { cpuCores: 4, totalMemMB: 8192, recommendedMaxWorkers: 3 }, company: { companyId: 'default' }, principal: { id: 'me' },
      secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null };
    const facts: DoctorCheckFacts = { scopeId: 'erp-demo', toolchainsRequested: false, identityProfile: null, backupPassphraseStored: null,
      retiringModels: [], poolStatus: 'missing', toolchainUpdateEnabled: false, firstJob: { execution: true, registry: true } };
    const pool = doctorChecks(report, facts, 'en').find(row => row.id === 'work.pool');
    expect(pool).toMatchObject({ state: 'warning' });
    expect(pool?.next).toContain('/setup'); expect(pool?.next).not.toContain('deckent init');
  });

  it('no observation, apply-port or doctor unit starts a registry preview', async () => {
    const forbidden = /initializeNativeCodingRegistry|detectNativeCliVersion|native-coding|configureNativeCodingTemplate/u;
    const foreground = new Set(['src/surfaces/core/setup/internal/foreground.ts', 'src/surfaces/core/setup/internal/contract.ts']);
    for (const unit of ['src/composition/core/setup', 'src/surfaces/core/setup', 'src/surfaces/core/doctor']) {
      const files = (await readdir(unit, { recursive: true, encoding: 'utf8' })).filter(file => /\.(ts|json)$/u.test(file) && !foreground.has(`${unit}/${file}`));
      for (const file of files) expect(forbidden.test(await readFile(join(unit, file), 'utf8')), `${unit}/${file}`).toBe(false);
    }
  });
});

const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('U3 real binary: install phase only and no container from a pipe, agent, --json or --yes', () => {
  it('a recording docker on PATH sees no container command from the read-only phase documents', async () => {
    const base = await mkdtemp(join(tmpdir(), 'deckent-i-s7-')); roots.push(base);
    const root = join(base, 'erp-demo'), home = join(base, 'home'), bin = join(base, 'bin'), calls = join(base, 'docker-calls.txt');
    for (const dir of [root, home, bin]) await mkdir(dir, { recursive: true });
    // A fake docker that only records its argv (one line per call) and fails: detection reads "unknown", nothing can start.
    await writeFile(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`); await chmod(join(bin, 'docker'), 0o755);
    const env = { PATH: `${bin}:${resolve(process.execPath, '..')}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'dumb' };
    const run = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024 }).then(result => ({ code: 0, ...result }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    const document = (stdout: string) => JSON.parse(stdout) as { schemaVersion: number; stages: { phase: string; id: string }[]; firstJob?: unknown };
    const installOnly = (stdout: string) => { const doc = document(stdout); expect(doc.schemaVersion).toBe(2); expect(doc.firstJob).toBeUndefined(); expect(doc.stages.every(stage => stage.phase === 'install')).toBe(true); };
    const yes = await run(['init', '--yes', '--scope', 'erp-demo', '--json']);
    expect(yes.code, yes.stderr).toBe(0); installOnly(yes.stdout);
    installOnly((await run(['init'], { CLAUDECODE: '1' })).stdout);
    const onboard = await run(['init', '--json', '--phase', 'onboarding']);
    expect(onboard.code, onboard.stderr).toBe(0);
    expect(document(onboard.stdout).stages.every(stage => stage.phase === 'onboarding')).toBe(true);
    const execution = { docker: { executable: join(bin, 'docker'), imageId: `sha256:${'a'.repeat(64)}` }, git: { gitExecutable: '/usr/bin/git' } };
    const configPath = join(root, '.deckent', 'config.json'), before = await readFile(configPath, 'utf8');
    const set = await run(['config', 'set', 'execution', JSON.stringify(execution)]);
    expect(set.code).not.toBe(0); expect(set.stderr).toContain('The setting execution is protected');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    const doctor = await run(['doctor']);
    expect(doctor.stdout).toContain('/setup');
    const callsText = await readFile(calls, 'utf8').catch(() => '');
    expect(callsText).not.toMatch(/^(run|create|start|build|pull|tag|push)\b/mu);
  }, 150_000);
});
