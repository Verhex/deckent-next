import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SetupStageRegistry, type SetupObservation, type SetupStage } from '#engine/index.js';
import { configuredSetup } from '#composition/core/setup/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY } from '#surfaces/core/project-instructions/index.js';
import { createSetupController, setupInitCommand, type SetupApplyResult, type SetupCommandContext } from '#surfaces/core/setup/index.js';

/**
 * I-S3: every `deckent init` stage reaches its existing owner. The real binary (dist) in a throwaway folder and HOME drives the unattended
 * path; the composition port is called directly for the refusals; the window controller is driven without Ink. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const ELIGIBLE = ['installation.policy-template', 'config.set'];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-i-s3-')); roots.push(base);
  const root = join(base, 'erp-demo'), home = join(base, 'home'), empty = join(base, 'no-tools');
  for (const dir of [root, home, empty]) await mkdir(dir, { recursive: true });
  // A clean environment (the runner may itself run inside an AI agent or CI): no agent marker, English, no Deckent variables.
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'dumb' };
  const run = async (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra },
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).then(result => ({ code: 0, ...result }), (error: { code?: number; stdout?: string; stderr?: string }) =>
    ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  type Document = { stages: { id: string; state: string; operation: { id: string } | null }[]; apply: { requested: boolean; results: SetupApplyResult[] } };
  const document = (stdout: string) => JSON.parse(stdout) as Document;
  return { base, root, home, empty, env, run, document };
}
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

describe.skipIf(process.platform !== 'linux')('I-S3 deckent init: unattended --yes through the real owners (real binary)', () => {
  it('--yes --scope in a pipe: fresh policy and language through their owners; a second run applies nothing', async () => {
    await access(cli);
    const f = await fixture();
    const first = await f.run(['init', '--yes', '--scope', 'erp-demo', '--json']);
    expect(first.code, first.stderr).toBe(0);
    const one = f.document(first.stdout);
    expect(one.apply.results.map(result => [result.stage, result.operation, result.status])).toEqual([['core:policy', 'installation.policy-template', 'applied'],
      ['core:language', 'config.set', 'applied']]);
    const state = (doc: Document, id: string) => doc.stages.find(stage => stage.id === id)?.state;
    expect([state(one, 'core:policy'), state(one, 'core:language'), state(one, 'core:folder')]).toEqual(['done', 'done', 'done']);
    // No hand-written JSON: the installation's documents exist and name the scope; the language is the detected one.
    const policy = join(f.root, '.deckent', 'policy.json');
    expect(await readFile(policy, 'utf8')).toContain('erp-demo');
    expect(await readFile(join(f.root, '.deckent', 'config.json'), 'utf8')).toMatch(/"language":\s*"en"/u);
    // Never anything but the two eligible operations, never the Docker install (no person answers in a pipe).
    expect(one.apply.results.every(result => ELIGIBLE.includes(result.operation))).toBe(true);
    expect(one.stages.some(stage => stage.operation?.id === 'execution-environment.install')).toBe(false);
    const before = await digest(policy);
    const second = await f.run(['init', '--yes', '--scope', 'erp-demo', '--json']);
    expect(second.code, second.stderr).toBe(0);
    const two = f.document(second.stdout);
    // Done stages are detected again, not remembered: the policy and language are not applied a second time.
    expect([state(two, 'core:policy'), state(two, 'core:language')]).toEqual(['done', 'done']);
    expect(two.apply.results).toEqual([]);
    expect(await digest(policy)).toBe(before);
  }, 180_000);

  it('SOLO-PROFILE: the solo selection goes through the same governed writer as team (global layer, never --yes); the next observation reads it done', async () => {
    await access(cli);
    const f = await fixture();
    expect((await f.run(['init', '--yes', '--scope', 'erp-demo'])).code).toBe(0);
    // `--yes` (INIT-D5) never writes the profile: without a person the answer is solo, ready to apply, and the doctor still asks for it.
    const stages = async () => (JSON.parse((await f.run(['init', '--json'])).stdout) as { stages: SetupStage[] }).stages;
    const ready = (await stages()).find(stage => stage.id === 'core:profile')!;
    expect(ready).toMatchObject({ state: 'ready', autoEligible: false, operation: { id: 'identity-profile.preview', input: { scopeId: 'erp-demo', profile: { id: 'core:solo', version: 1 } } } });
    expect((await f.run(['doctor'])).stdout).toMatch(/warning\s+No identity profile selected\./u);
    // alpha.55.1: `identity.profile` is protected — off a person's terminal the stage is refused by name and nothing is written.
    expect(await configuredSetup({}, { attest: async () => false }).applySetupStage(f.root, ready, { env: f.env, scopeId: 'erp-demo' }))
      .toEqual({ stage: 'core:profile', operation: 'identity-profile.preview', status: 'refused', code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect((JSON.parse(await readFile(join(f.home, '.deckent', 'config.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>)['identity']).toBeUndefined();
    // The person in the window (the terminal witness attests) applies it.
    const result = await configuredSetup({}, { attest: async () => true }).applySetupStage(f.root, ready, { env: f.env, scopeId: 'erp-demo' });
    expect(result).toEqual({ stage: 'core:profile', operation: 'identity-profile.preview', status: 'applied' });
    expect(JSON.parse(await readFile(join(f.home, '.deckent', 'config.json'), 'utf8'))).toMatchObject({ identity: { profile: { id: 'core:solo', version: 1 } } });
    // Nothing in the folder's own configuration: the selection is the user's, as `config set identity.profile --global`.
    expect((JSON.parse(await readFile(join(f.root, '.deckent', 'config.json'), 'utf8')) as Record<string, unknown>)['identity']).toBeUndefined();
    expect((await stages()).find(stage => stage.id === 'core:profile')).toMatchObject({ state: 'done', reason: { code: 'setup.reason.profileConfigured', params: { profile: 'core:solo' } },
      operation: null, cli: null });
    expect((await f.run(['doctor'])).stdout).toMatch(/ok\s+Identity profile: Solo/u);
  }, 180_000);

  it('an AI agent environment: the plan only without --yes, never a Docker install offer, nothing written to the folder', async () => {
    await access(cli);
    const f = await fixture();
    // No docker on PATH: the person-only install offer must still never reach an agent.
    const plan = await f.run(['init'], { CLAUDECODE: '1', PATH: f.empty });
    expect(plan.code, plan.stderr).toBe(0);
    const doc = f.document(plan.stdout);
    expect(doc.apply).toEqual({ requested: false, results: [] });
    expect(doc.stages.find(stage => stage.id === 'execution:runtime')).toBeUndefined();
    expect(await readdir(f.root)).toEqual([]);
    // The same without an agent marker: `--json` and `--yes` are never a person answering, so no install offer either (I-D2 delta §1).
    for (const args of [['init', '--json'], ['init', '--yes', '--scope', 'erp-demo', '--json']]) {
      const document = f.document((await f.run(args, { PATH: f.empty })).stdout);
      expect(document.stages.find(stage => stage.id === 'execution:runtime'), args.join(' ')).toBeUndefined();
    }
    const yes = await f.run(['init', '--yes', '--scope', 'erp-demo'], { CLAUDECODE: '1', PATH: f.empty });
    const applied = f.document(yes.stdout);
    expect(applied.apply.results.every(result => ELIGIBLE.includes(result.operation)), yes.stdout).toBe(true);
    expect(applied.stages.some(stage => stage.operation?.id === 'execution-environment.install')).toBe(false);
  }, 180_000);

  it('a hand-built policy is left as it is: the stage is skipped, its bytes stay, and the next stage that needs it is refused by name', async () => {
    await access(cli);
    const f = await fixture();
    await mkdir(join(f.root, '.deckent'), { recursive: true });
    const policy = join(f.root, '.deckent', 'policy.json');
    await writeFile(policy, '{"hand":"built"}\n');
    const before = await digest(policy);
    const result = await f.run(['init', '--yes', '--scope', 'erp-demo', '--json']);
    const doc = f.document(result.stdout);
    expect(doc.stages.find(stage => stage.id === 'core:policy')?.state).toBe('skipped');
    expect(doc.apply.results.map(item => item.operation)).not.toContain('installation.policy-template');
    // The language write needs a valid policy: its owner refuses, the call stops with the stage named, and nothing else is written.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('core:language');
    expect(await digest(policy)).toBe(before);
    expect((await readdir(join(f.root, '.deckent'))).sort()).toEqual(['policy.json']);
  }, 180_000);
});

describe('I-S3 apply port: stages that take the terminal are refused off the window, nothing half-run', () => {
  const stage = (id: string, operation: string, input: Record<string, string> = { scopeId: 'erp-demo' }): SetupStage => ({ id, namespace: id.split(':')[0]!, phase: id === 'core:policy' ? 'install' : 'onboarding', title: 'setup.stage.policy',
    state: 'ready', reason: { code: 'setup.reason.policyUpgrade', params: {} }, operation: { id: operation, version: 1, input }, question: null, default: null, cli: null, autoEligible: false });
  it.each([['core:policy', 'installation.policy-upgrade'], ['execution:runtime', 'execution-environment.install'], ['core:model', 'model.connect'],
    ['instructions:bridges', 'project-instructions.initialize']])('%s (%s) → refused TERMINAL_TTY_REQUIRED, the folder stays empty', async (id, operation) => {
    const base = await mkdtemp(join(tmpdir(), 'deckent-i-s3-port-')); roots.push(base);
    const result = await configuredSetup({}).applySetupStage(base, stage(id, operation), { env: { HOME: base, PATH: '' } });
    expect(result).toEqual({ stage: id, operation, status: 'refused', code: 'TERMINAL_TTY_REQUIRED' });
    expect(await readdir(base)).toEqual([]);
  });
});

const base: SetupObservation = { schemaVersion: 2, environment: { platform: 'linux', node: 'supported' }, language: { configured: 'en', requested: null, system: 'en' },
  folder: { installation: 'present', homeRoot: false, configuredScope: 'erp-demo', suggestedScope: 'erp-demo' }, profile: { available: [{ id: 'core:solo', version: 1 }],
    selected: { id: 'core:solo', version: 1 } }, policy: { state: 'current' }, sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 1 }, check: { state: 'not-run' },
  families: { instructions: { file: 'present', bridges: [] } } };
const registry = new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY]);
function surface(apply: (stage: SetupStage) => SetupApplyResult['status'], observation: SetupObservation = base) {
  const applied: string[] = []; let out = '';
  const context: SetupCommandContext = { root: '/nonexistent/i-s3', env: { LANG: 'en_US.UTF-8' }, locale: 'en', stdout: { write: (text: string) => { out += text; } },
    stderr: { write: () => true }, stdin: { isTTY: false } as unknown as SetupCommandContext['stdin'], observeSetup: async () => ({ observation, registry }),
    applySetupStage: async (_root, stage) => { applied.push(stage.operation!.id); return { stage: stage.id, operation: stage.operation!.id, status: apply(stage), code: 'TERMINAL_TTY_REQUIRED' }; } };
  return { context, applied, out: () => out };
}

describe('I-S3 surface: refusals are typed and name the stage; the window never runs a terminal-taking owner inside itself', () => {
  it('--yes: a refused stage stops the call with SETUP_STAGE_REFUSED naming it, after the plan and its results are printed', async () => {
    const run = surface(() => 'refused', { ...base, policy: { state: 'absent' }, folder: { ...base.folder, installation: 'none' } });
    const error = await setupInitCommand(['init', '--yes', '--scope', 'erp-demo', '--json'], run.context).then(() => null, (failure: { code?: string; params?: Record<string, unknown> }) => failure);
    expect(error?.code).toBe('SETUP_STAGE_REFUSED');
    expect(error?.params).toMatchObject({ stage: 'core:policy', code: 'TERMINAL_TTY_REQUIRED' });
    expect(run.applied).toEqual(['installation.policy-template']);
    expect((JSON.parse(run.out()) as { apply: { results: SetupApplyResult[] } }).apply.results).toEqual([{ stage: 'core:policy', operation: 'installation.policy-template', status: 'refused', code: 'TERMINAL_TTY_REQUIRED' }]);
  });

  it('the window closes for a terminal-taking stage (the final check runs the human doctor) instead of calling the apply port inside it', async () => {
    const run = surface(() => 'applied');
    const controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    expect(controller.model().rows.find(row => row.startsWith('>'))).toMatch(/Final check/u);
    expect(controller.model().options.map(option => option.id)).toEqual(['apply', 'later']);
    expect(await controller.step('apply')).toBeNull();
    expect(run.applied).toEqual([]);
  });

  it('SOLO-PROFILE: a person who answers solo applies it like any profile, through the apply port (it was never applied before)', async () => {
    const unsaved = { ...base, profile: { available: base.profile.available } };
    const run = surface(() => 'applied', unsaved);
    const controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: unsaved, registry }, flags: { json: false, yes: false } });
    await controller.step('core:solo');
    expect(controller.model().rows.find(row => row.startsWith('>'))).toMatch(/Who uses this installation · ready/u);
    expect(controller.model().options.map(option => option.id)).toEqual(['apply', 'later']);
    await controller.step('apply');
    expect(run.applied).toEqual(['identity-profile.preview']);
    // The fake observation still has no saved profile: the stage is put off for this window, never offered again in a loop.
    expect(controller.model().rows.find(row => row.startsWith('>'))).toMatch(/Final check/u);
  });

  it('an applied stage that is still open after the fresh observation is put off, never offered again in a loop', async () => {
    const pending = { ...base, model: { connections: 0 }, language: { configured: null, requested: null, system: 'en' as const } };
    const run = surface(() => 'applied', pending);
    const controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: pending, registry }, flags: { json: false, yes: false } });
    await controller.step('en');
    expect(controller.model().rows.find(row => row.startsWith('>'))).toMatch(/Language/u);
    await controller.step('apply');
    expect(run.applied).toEqual(['config.set']);
    // The observation still says "not configured" (a fake port): the stage is put off; the window moves on.
    // The profile is saved and model connection belongs to onboarding, so init goes on to its read-only final check.
    expect(controller.model().rows.find(row => row.startsWith('>'))).toMatch(/Final check/u);
    expect(controller.model().options.map(option => option.id)).toEqual(['apply', 'later']);
    expect(await controller.step('apply')).toBeNull();
    expect(run.applied).toEqual(['config.set']);
  });
});
