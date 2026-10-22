import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeCliIds } from '#domain/index.js';
import { SetupStageRegistry, type SetupObservation } from '#engine/index.js';
import { assessPoolReadiness } from '#surfaces/core/cli-admin/index.js';
import { doctorChecks, firstJobCommand, firstJobLines, firstJobSteps, type DoctorCheckFacts, type FirstJobFacts } from '#surfaces/core/doctor/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY } from '#surfaces/core/project-instructions/index.js';
import { createSetupController, renderSetupLines, setupDocument, type SetupCommandContext } from '#surfaces/core/setup/index.js';
import { planSetup } from '#engine/index.js';

/**
 * I-S7 (owner 2026-10-19: "ordered list + doctor"): after `deckent init` the person sees, in order, the steps the first `/do` still needs
 * (worker image → execution configuration → first registry → pool), each with its exact command; doctor's pool row names the first one.
 * Facts are configuration and pool-ledger reads only: the registry preview starts a container and never runs from setup.
 */
const NONE: FirstJobFacts = { execution: false, registry: false, pool: false };
const ids = (facts: FirstJobFacts) => firstJobSteps(facts, 'erp-demo').map(step => step.id);

describe('I-S7 first-job steps (one ordered source for setup and doctor)', () => {
  it('lists only the missing steps, in order, with exact commands; nothing missing reads "ready"', () => {
    expect(ids(NONE)).toEqual(['worker-image', 'execution', 'registry', 'pool']);
    expect(ids({ execution: true, registry: false, pool: false })).toEqual(['registry', 'pool']);
    expect(ids({ execution: true, registry: true, pool: false })).toEqual(['pool']);
    expect(ids({ execution: true, registry: true, pool: true })).toEqual([]);
    const commands = firstJobSteps(NONE, 'erp-demo').map(firstJobCommand);
    expect(commands[0]).toBe('npm run worker:image -- <receipt.json>');
    // The execution JSON is quoted once for the shell; the minimal form the built binary accepts (docker executable + image, git executable).
    expect(commands[1]).toBe(`deckent config set execution '{"docker":{"executable":"<docker path>","imageId":"<image id>"},"git":{"gitExecutable":"<git path>"}}'`);
    // Every flag `init registry` requires; providers come from the native CLI registry, the scope is filled in.
    expect(commands[2]).toBe(`deckent init registry --scope erp-demo --provider <${nativeCliIds.join('|')}> --kind <kind> --pool <pool> --execution-slots <n> --in-flight-slots <n> --discovery <disabled|repository> --preview`);
    expect(commands[3]).toBe('deckent init pool --scope erp-demo --preview');
    expect(firstJobSteps(NONE, null).at(-1)?.argv).toContain('<scope>');
    expect(firstJobLines([], 'en')).toEqual(['Worker image, registry and pool are set up: ready for the first job.']);
    expect(firstJobLines(firstJobSteps({ execution: true, registry: true, pool: false }, 's'), 'tr'))
      .toEqual(['İlk işten (/do) önce, bu sırayla yapılacaklar:', '1. Worker havuzunu kurun: önce önizleme, sonra aynı komut --apply ile', '   $ deckent init pool --scope s --preview']);
  });
});

describe('I-S7 doctor: registry present, pool missing is a warning naming deckent init pool (not an error)', () => {
  const admission = { poolId: 'erp-workers', executionSlots: 1, inFlightSlots: 1 };
  const failing = (code: string) => ({ inspectPoolCapacity: async () => { throw Object.assign(new Error(code), { code }); } });
  it('pool readiness: a missing ledger row (RUN_POOL_REQUIRED) is "missing"; any other failure stays "unavailable"; no admission is "unconfigured"', async () => {
    expect(await assessPoolReadiness('/x', failing('RUN_POOL_REQUIRED'), {}, admission, 'erp-demo')).toMatchObject({ status: 'missing', code: 'RUN_POOL_REQUIRED' });
    expect(await assessPoolReadiness('/x', failing('RUN_STORE_CORRUPT'), {}, admission, 'erp-demo')).toMatchObject({ status: 'unavailable' });
    expect(await assessPoolReadiness('/x', failing('RUN_POOL_REQUIRED'), {}, null, 'erp-demo')).toMatchObject({ status: 'unconfigured' });
  });

  const report = { platform: 'linux', host: { cpuCores: 4, totalMemMB: 8192, recommendedMaxWorkers: 3 }, company: { companyId: 'default' }, principal: { id: 'me' },
    secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null };
  const facts = (extra: Partial<DoctorCheckFacts>): DoctorCheckFacts => ({ scopeId: 'erp-demo', toolchainsRequested: false, identityProfile: null, backupPassphraseStored: null,
    retiringModels: [], poolStatus: 'ready', toolchainUpdateEnabled: false, ...extra });
  const pool = (extra: Partial<DoctorCheckFacts>) => doctorChecks(report, facts(extra), 'en').find(row => row.id === 'work.pool');
  it('the pool row names the first missing step of the same list with its exact command', () => {
    expect(pool({ poolStatus: 'missing', firstJob: { execution: true, registry: true } })).toMatchObject({ state: 'warning',
      text: 'The worker pool is configured but not set up yet: Runs cannot start workers',
      next: 'Set up the worker pool: preview, then the same command with --apply: deckent init pool --scope erp-demo --preview' });
    expect(pool({ poolStatus: 'unconfigured', firstJob: { execution: false, registry: false } })?.next).toMatch(/^Build a worker image in the Deckent source checkout .*: npm run worker:image -- <receipt\.json>$/u);
    expect(pool({ poolStatus: 'unconfigured', firstJob: { execution: true, registry: false } })?.next).toMatch(/: deckent init registry --scope erp-demo --provider /u);
    expect(pool({ poolStatus: 'ready', firstJob: { execution: true, registry: true } })).toMatchObject({ state: 'ok' });
    expect(pool({ poolStatus: 'ready' })?.next).toBeUndefined();
    // A pool that exists but cannot be read or drifted stays an error with its own next step.
    expect(pool({ poolStatus: 'unavailable', firstJob: { execution: true, registry: true } })).toMatchObject({ state: 'error', next: 'deckent pool status --scope erp-demo' });
  });
});

const observation: SetupObservation = { schemaVersion: 1, environment: { platform: 'linux', node: 'supported' }, language: { configured: 'en', requested: null, system: 'en' },
  folder: { installation: 'present', homeRoot: false, configuredScope: 'erp-demo', suggestedScope: 'erp-demo' }, profile: { available: [{ id: 'core:solo', version: 1 }],
    selected: { id: 'core:solo', version: 1 } }, policy: { state: 'current' }, sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 1 }, check: { state: 'ok' },
  families: { instructions: { file: 'present', bridges: [] } } };
const registry = new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY]);

describe('I-S7 deckent init summary: text, window and --json show the same ordered list', () => {
  it('the text summary lists the missing steps after the stages; nothing missing is one ready line; without facts nothing is added', () => {
    const plan = planSetup(observation, undefined, registry), apply = { requested: false, results: [] };
    const text = renderSetupLines(plan, 'en', apply, NONE).split('\n');
    const at = text.indexOf('Before the first job (/do), still to do, in this order:');
    expect(at).toBeGreaterThan(0);
    expect(text.slice(at + 1).filter(line => /^\d\. /u.test(line))).toHaveLength(4);
    expect(text.at(-1)).toBe('   $ deckent init pool --scope erp-demo --preview');
    expect(renderSetupLines(plan, 'en', apply, { execution: true, registry: true, pool: true }).split('\n').at(-1)).toBe('Worker image, registry and pool are set up: ready for the first job.');
    expect(renderSetupLines(plan, 'en', apply)).not.toContain('first job');
    // --json: the same list as data (message keys and argv), additive to document schema 1.
    const doc = setupDocument(plan, apply, { execution: true, registry: false, pool: false });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.firstJob?.map(step => step.id)).toEqual(['registry', 'pool']);
    expect(doc.firstJob?.[1]).toEqual({ id: 'pool', title: 'doctor.firstJob.pool', cli: ['deckent', 'init', 'pool', '--scope', 'erp-demo', '--preview'] });
    expect('firstJob' in setupDocument(plan, apply)).toBe(false);
  });

  it('the window names the first missing step in its existing rows once nothing is left to answer; its height never changes', async () => {
    const context = { root: '/x', env: {}, locale: 'en' } as unknown as SetupCommandContext;
    const rows = async (firstJob?: FirstJobFacts) => {
      const controller = createSetupController({ context, root: '/x', locale: 'en', flags: { json: false, yes: false }, observed: { observation, registry, ...(firstJob ? { firstJob } : {}) } });
      // Nothing is open here (the solo profile is already saved): the rows name what the first job still needs.
      return controller.model().rows;
    };
    const missing = await rows({ execution: true, registry: true, pool: false }), ready = await rows({ execution: true, registry: true, pool: true }), none = await rows();
    expect(missing.length).toBe(none.length); expect(ready.length).toBe(none.length);
    expect(missing.at(-2)).toBe('Before the first job: Set up the worker pool: preview, then the same command with --apply');
    expect(missing.at(-1)).toBe('$ deckent init pool --scope erp-demo --preview');
    expect(ready.at(-2)).toBe('Worker image, registry and pool are set up: ready for the first job.');
    expect(none.slice(-2)).toEqual(['', '']);
  });

  it('negative (source): no setup or doctor unit can reach the registry preview (it starts a container)', async () => {
    const forbidden = /initializeNativeCodingRegistry|detectNativeCliVersion|native-coding|configureNativeCodingTemplate/u;
    for (const unit of ['src/composition/core/setup', 'src/surfaces/core/setup', 'src/surfaces/core/doctor']) {
      const files = (await readdir(unit, { recursive: true, encoding: 'utf8' })).filter(file => /\.(ts|json)$/u.test(file));
      expect(files.length, unit).toBeGreaterThan(0);
      for (const file of files) expect(forbidden.test(await readFile(join(unit, file), 'utf8')), `${unit}/${file}`).toBe(false);
    }
  });
});

const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('I-S7 real binary: the list as data, never a container from a pipe, an agent, --json or --yes', () => {
  it('a recording docker on PATH sees no container command; --json lists 4 steps, then 2 after the execution configuration', async () => {
    const base = await mkdtemp(join(tmpdir(), 'deckent-i-s7-')); roots.push(base);
    const root = join(base, 'erp-demo'), home = join(base, 'home'), bin = join(base, 'bin'), calls = join(base, 'docker-calls.txt');
    for (const dir of [root, home, bin]) await mkdir(dir, { recursive: true });
    // A fake docker that only records its argv (one line per call) and fails: detection reads "unknown", nothing can start.
    await writeFile(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`); await chmod(join(bin, 'docker'), 0o755);
    const env = { PATH: `${bin}:${resolve(process.execPath, '..')}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'dumb' };
    const run = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024 }).then(result => ({ code: 0, ...result }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    const steps = (stdout: string) => (JSON.parse(stdout) as { firstJob: { id: string }[] | null }).firstJob?.map(step => step.id);
    const yes = await run(['init', '--yes', '--scope', 'erp-demo', '--json']);
    expect(yes.code, yes.stderr).toBe(0);
    expect(steps(yes.stdout)).toEqual(['worker-image', 'execution', 'registry', 'pool']);
    const piped = await run(['init']);
    expect(piped.stdout).toContain('Before the first job (/do), still to do, in this order:');
    expect(piped.stdout).toContain('   $ deckent init pool --scope erp-demo --preview');
    expect(steps((await run(['init'], { CLAUDECODE: '1' })).stdout)).toEqual(['worker-image', 'execution', 'registry', 'pool']);
    const set = await run(['config', 'set', 'execution', JSON.stringify({ docker: { executable: join(bin, 'docker'), imageId: `sha256:${'a'.repeat(64)}` }, git: { gitExecutable: '/usr/bin/git' } })]);
    expect(set.code, set.stderr).toBe(0);
    expect(steps((await run(['init', '--json'])).stdout)).toEqual(['registry', 'pool']);
    const doctor = await run(['doctor']);
    expect(doctor.stdout).toMatch(/warning\s+No worker pool is set up yet: Runs cannot start workers\n\s+next: Declare the first work kind and its worker pool: preview, then the same command with --apply: deckent init registry --scope erp-demo /u);
    const recorded = await readFile(calls, 'utf8').catch(() => '');
    expect(recorded.split('\n').filter(line => /^(create|run|start|container|image)\b|\b(create|run|start)\b.*--name/u.test(line))).toEqual([]);
  }, 240_000);
});
