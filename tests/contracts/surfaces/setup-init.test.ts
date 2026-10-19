import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SetupStageRegistry, type SetupObservation, type SetupStage } from '#engine/index.js';
import { MESSAGE_REGISTRY, clearConfigCache } from '#platform/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY } from '#surfaces/core/project-instructions/index.js';
import { createSetupController, setupInitCommand, type SetupApplyResult, type SetupCommandContext } from '#surfaces/core/setup/index.js';

// I-S4: bare `deckent init` renders the I-S1 plan as JSON, plain lines or the window, and applies only what INIT-D5 allows.
const base: SetupObservation = { schemaVersion: 1,
  environment: { platform: 'linux', node: 'supported' }, language: { configured: null, requested: null, system: 'tr' },
  folder: { installation: 'none', homeRoot: false, configuredScope: null, suggestedScope: 'my-erp' },
  profile: { available: [{ id: 'core:solo', version: 1 }, { id: 'core:team', version: 1 }] }, policy: { state: 'absent' },
  sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 0 }, check: { state: 'not-run' },
  families: { instructions: { file: 'missing', bridges: [{ id: 'claude-code', detected: true }, { id: 'agents-md', detected: false }] } } };
const registry = new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY]);
const tty = { isTTY: true }, pipe = { isTTY: false };
/** The operations `--yes` must never reach (INIT-D5): registry, pool, provider/model, upgrade, identity, Docker and the bridges write. */
const NEVER_UNATTENDED = ['installation.policy-upgrade', 'model.connect', 'identity-profile.preview', 'project-instructions.initialize', 'shell-realm.inspect'];

type Harness = Readonly<{ context: SetupCommandContext; out: () => string; err: () => string; applied: SetupStage[]; observed: () => number; rawMode: () => number }>;
function harness(input: Readonly<{ env?: NodeJS.ProcessEnv; stdout?: { isTTY: boolean }; stdin?: { isTTY: boolean }; observation?: (round: number) => SetupObservation;
  apply?: (stage: SetupStage) => SetupApplyResult['status'] }> = {}): Harness {
  let out = '', err = '', rounds = 0, raw = 0;
  const applied: SetupStage[] = [];
  const stdin = Object.assign({ setRawMode: () => { raw++; } }, input.stdin ?? pipe);
  const context = { root: '/nonexistent/setup-root', env: input.env ?? { LANG: 'en_US.UTF-8' }, locale: 'en' as const,
    stdout: Object.assign({ write: (text: string) => { out += text; } }, input.stdout ?? pipe), stderr: { write: (text: string) => { err += text; } },
    stdin: stdin as unknown as SetupCommandContext['stdin'],
    observeSetup: async () => ({ observation: (input.observation ?? (() => base))(rounds++), registry }),
    ...(input.apply ? { applySetupStage: async (_root: string, stage: SetupStage) => { applied.push(stage); return { stage: stage.id, operation: stage.operation!.id, status: input.apply!(stage) }; } }
      : { applySetupStage: async (_root: string, stage: SetupStage) => { applied.push(stage); return { stage: stage.id, operation: stage.operation!.id, status: 'not-wired' as const }; } }) };
  return { context, out: () => out, err: () => err, applied, observed: () => rounds, rawMode: () => raw };
}
async function failure(work: Promise<unknown>) { try { await work; } catch (error) { return (error as { code?: string }).code; } return 'no-error'; }

describe('I-S4 bare deckent init', () => {
  it('JSON contract: --json prints the versioned, locale-free plan document and applies nothing', async () => {
    const run = harness();
    await setupInitCommand(['init', '--json'], run.context);
    const document = JSON.parse(run.out()) as { schemaVersion: number; stages: { id: string; state: string }[]; apply: unknown };
    expect(document.schemaVersion).toBe(1);
    expect(document.apply).toEqual({ requested: false, results: [] });
    expect(document.stages.map(stage => stage.id)).toEqual(['core:environment', 'core:language', 'core:folder', 'core:profile', 'core:policy', 'core:sandbox',
      'core:model', 'instructions:bridges', 'core:final-check']);
    expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../../fixtures/setup/plan-fresh.json');
    // The same call in Turkish prints the same document: the contract carries message keys, not text.
    const tr = harness({ env: { LANG: 'tr_TR.UTF-8' } });
    await setupInitCommand(['init', '--json', '--lang', 'tr'], tr.context);
    expect(JSON.parse(tr.out())).toEqual(document);
  });

  it.each(['en', 'tr'] as const)('plain lines in %s: every stage, reason and command rendered from the catalog, no raw key, nothing applied', async locale => {
    const run = harness();
    await setupInitCommand(['init', '--lang', locale, '--scope', 'my-erp'], run.context);
    const text = run.out(), catalog = MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
    expect(text).not.toMatch(/setup\.(?:stage|reason|question|instructions|state|render)\./u);
    expect(text).not.toMatch(/\{[a-z]+\}/u);
    for (const key of ['setup.stage.policy', 'setup.instructions.title', 'setup.stage.finalCheck', 'setup.render.nothingApplied']) expect(text).toContain(catalog[key]!.split('{')[0]!.trim().slice(0, 20));
    expect(text).toContain('$ deckent init policy --scope my-erp --apply');
    expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true); // the command prints one final newline (Astra 2664 item 4)
    await expect(text).toMatchFileSnapshot(`../../fixtures/setup/plan-plain-${locale}.txt`);
  });

  it('EN/TR parity: both locales render the same stages and line structure, in different words', async () => {
    const lines = async (locale: 'en' | 'tr') => { const run = harness(); await setupInitCommand(['init', '--lang', locale], run.context); return run.out().trimEnd().split('\n'); };
    const [en, tr] = [await lines('en'), await lines('tr')];
    expect(tr.length).toBe(en.length);
    expect(tr.map(line => line.replace(/[^$?·.\d ]/gu, '').replace(/ +/gu, ' ').slice(0, 6))).toEqual(en.map(line => line.replace(/[^$?·.\d ]/gu, '').replace(/ +/gu, ' ').slice(0, 6)));
    expect(tr.filter((line, index) => line === en[index] && !line.includes('$ '))).toEqual([]);
  });

  it('a pipe (non-TTY) never prompts and never applies; it prints plain lines', async () => {
    const run = harness({ stdin: pipe, stdout: pipe });
    await setupInitCommand(['init'], run.context);
    expect(run.out()).toContain('Deckent setup plan'); expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
  });

  it('an AI agent on a real terminal gets JSON, is never asked and nothing is applied (INIT-D7, UX only)', async () => {
    for (const env of [{ CLAUDECODE: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { CI: 'true' }]) {
      const run = harness({ env, stdin: tty, stdout: tty });
      await setupInitCommand(['init'], run.context);
      expect(() => JSON.parse(run.out()), JSON.stringify(env)).not.toThrow();
      expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
    }
    // The installation's own agent list decides (`cli.agentEnvironment`), exact names only.
    const listed = harness({ env: { MY_AGENT: '1' }, stdin: tty, stdout: tty });
    await setupInitCommand(['init'], { ...listed.context, agentEnvironment: ['MY_AGENT'] });
    expect(() => JSON.parse(listed.out())).not.toThrow(); expect(listed.rawMode()).toBe(0);
  });

  it('--yes without --scope is refused before anything is observed (INIT-D5), on every surface mode', async () => {
    for (const stdout of [pipe, tty]) {
      const run = harness({ stdout, stdin: stdout });
      expect(await failure(setupInitCommand(['init', '--yes'], run.context))).toBe('CLI_SCOPE_REQUIRED');
      expect(await failure(setupInitCommand(['init', '--yes', '--json'], run.context))).toBe('CLI_SCOPE_REQUIRED');
      expect(run.observed()).toBe(0); expect(run.applied).toEqual([]); expect(run.out()).toBe('');
    }
    // A configured scope is never taken silently for --yes.
    const configured = harness({ observation: () => ({ ...base, folder: { ...base.folder, configuredScope: 'live' } }) });
    expect(await failure(setupInitCommand(['init', '--yes'], configured.context))).toBe('CLI_SCOPE_REQUIRED');
  });

  it('--yes applies only eligible stages through the apply port; until it is wired it says so, writes nothing and exits non-zero', async () => {
    const run = harness();
    expect(await failure(setupInitCommand(['init', '--yes', '--scope', 'my-erp', '--json'], run.context))).toBe('SETUP_APPLY_UNAVAILABLE');
    expect(run.applied.map(stage => stage.operation!.id)).toEqual(['installation.policy-template']);
    const document = JSON.parse(run.out()) as { apply: { requested: boolean; results: SetupApplyResult[] } };
    expect(document.apply).toEqual({ requested: true, results: [{ stage: 'core:policy', operation: 'installation.policy-template', status: 'not-wired' }] });
  });

  it('--yes with a working apply port: fresh policy, then language, then final check, each after a fresh observation; never anything else', async () => {
    const after = [base, { ...base, policy: { state: 'current' as const }, folder: { ...base.folder, installation: 'present' as const, configuredScope: 'my-erp' } }];
    const run = harness({ apply: () => 'applied', observation: round => after[Math.min(round, 1)]! });
    await setupInitCommand(['init', '--yes', '--scope', 'my-erp'], run.context);
    expect(run.applied.map(stage => [stage.id, stage.operation!.id])).toEqual([['core:policy', 'installation.policy-template'], ['core:language', 'config.set'],
      ['core:final-check', 'doctor.inspect']]);
    expect(run.applied.find(stage => stage.id === 'core:language')!.operation!.input).toEqual({ keyPath: 'language', value: 'tr', layer: 'project' });
    expect(run.observed()).toBe(4);
    expect(run.applied.some(stage => NEVER_UNATTENDED.includes(stage.operation!.id))).toBe(false);
  });

  it('--yes never upgrades, resumes, runs a non-eligible ready stage, connects, writes bridges or applies anything on an unsupported platform', async () => {
    for (const observation of [{ ...base, policy: { state: 'upgradable' as const }, folder: { ...base.folder, configuredScope: 'my-erp' } },
      { ...base, policy: { state: 'pending' as const } }, { ...base, environment: { platform: 'windows' as const, node: 'supported' as const } },
      // A stage that is ready but not eligible (an untested sandbox): `--yes` leaves it to a person.
      { ...base, sandbox: { realm: 'bubblewrap' as const, selfTest: 'not-run' as const, usernsRestricted: false } }]) {
      const run = harness({ apply: () => 'applied', observation: () => observation });
      await failure(setupInitCommand(['init', '--yes', '--scope', 'my-erp', '--json'], run.context));
      // Only a fresh policy, the language write and the read-only final check may run; never the upgrade, a resume or anything else.
      const eligible = ['installation.policy-template', 'config.set', 'doctor.inspect'];
      expect(run.applied.map(stage => stage.operation!.id).filter(id => !eligible.includes(id)), observation.policy.state).toEqual([]);
      if (observation.policy.state !== 'absent') expect(run.applied.map(stage => stage.operation!.id)).not.toContain('installation.policy-template');
      if (observation.environment.platform === 'windows') {
        expect(run.applied).toEqual([]);
        expect((JSON.parse(run.out()) as { stages: { state: string }[] }).stages.slice(1).every(stage => stage.state === 'unsupported')).toBe(true);
      }
    }
  });

  it('the real read-only observer on an empty folder writes nothing and puts no secret in the JSON', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deckent-setup-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-setup-root-'));
    roots.push(home, root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'erp-demo', scripts: { test: 'never run' } }));
    const secret = 'sk-ant-api03-SETUPSECRETSHOULDNEVERAPPEAR0123456789';
    let out = '';
    const context: SetupCommandContext = { root, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: secret, DECKENT_SECRET: secret },
      stdout: { write: (text: string) => { out += text; } }, stdin: pipe as unknown as SetupCommandContext['stdin'] };
    clearConfigCache();
    await setupInitCommand(['init', '--json'], context);
    expect(out).not.toContain(secret); expect(out).not.toContain('SETUPSECRET');
    const document = JSON.parse(out) as { stages: { id: string; state: string; default: unknown }[] };
    expect(document.stages.find(stage => stage.id === 'core:folder')).toMatchObject({ state: 'needs-answer', default: root.split('/').pop()!.toLowerCase() });
    expect(document.stages.find(stage => stage.id === 'core:policy')!.state).toBe('blocked');
    expect((await readdir(root)).sort()).toEqual(['package.json']); expect(await readdir(home)).toEqual([]);
  });
});

describe('I-S4 setup window controller (no Ink)', () => {
  it('keeps one height, answers re-plan, "not now" and a not-wired apply put a stage off, and nothing is applied without Apply', async () => {
    const run = harness();
    const controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    const first = controller.model();
    expect(first.options.map(option => option.id)).toEqual(['en', 'tr', 'later']);
    expect(first.rows[1]).toMatch(/^> 2\. Language/u);
    const sizes = [first.rows.length];
    let model = (await controller.step('en'))!; sizes.push(model.rows.length);
    expect(model.rows[2]).toMatch(/^> 3\. Folder and scope/u); expect(model.options.map(option => option.id)).toEqual(['yes', 'later']);
    model = (await controller.step('yes'))!; sizes.push(model.rows.length);
    model = (await controller.step('core:solo'))!; sizes.push(model.rows.length);
    expect(model.rows[4]).toMatch(/^> 5\. Permissions · needs your answer/u);
    model = (await controller.step('yes'))!; sizes.push(model.rows.length);
    expect(model.options.map(option => option.id)).toEqual(['apply', 'later']);
    expect(run.applied).toEqual([]);
    model = (await controller.step('apply'))!; sizes.push(model.rows.length);
    expect(run.applied.map(stage => stage.operation!.id)).toEqual(['installation.policy-template']);
    expect(model.rows.at(-1)).toContain('cannot apply setup stages yet');
    expect(new Set(sizes).size).toBe(1);
    expect(model.optionRows).toBe(first.optionRows);
    expect(await controller.step('not-an-option')).toBeNull();
    expect(controller.outcome().results).toEqual([{ stage: 'core:policy', operation: 'installation.policy-template', status: 'not-wired' }]);
  });
});

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
