import { personMarkersUnset } from '../support/person-env.js';
import { decisionArmLabels } from '#surfaces/core/cli-human/index.js';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as observe from '#surfaces/core/cli-observe/index.js';
import * as cards from '#surfaces/core/cli-human/index.js';
import { executionSetupFamily, type RuntimeFacts } from '#adapters/core/setup-detect-execution/index.js';
import { planSetup, SETUP_PERMISSIONS_FAMILY, SetupStageRegistry, WORK_SETUP_FAMILY, type SetupObservation, type SetupStage } from '#engine/index.js';
import { ErrorRegistry, MESSAGE_REGISTRY, clearConfigCache } from '#platform/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY } from '#surfaces/core/project-instructions/index.js';
import { runForegroundStage, createSetupController, renderSetupLines, setupInitCommand, setupMessage, parseSetupFlags, stageChoices, type SetupApplyResult, type SetupCommandContext } from '#surfaces/core/setup/index.js';
import { loadOnboardingScreens, type OnboardingPort, type OnboardingSnapshot } from '#surfaces/core/terminal-onboarding/index.js';
import { offerTarget } from '#surfaces/core/cli-kit/index.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

// I-S4: bare `deckent init` renders the I-S1 plan as JSON, plain lines or the window, and applies only what INIT-D5 allows.
const base: SetupObservation = { schemaVersion: 2,
  environment: { platform: 'linux', node: 'supported' }, language: { configured: null, requested: null, system: 'tr' },
  folder: { installation: 'none', homeRoot: false, configuredScope: null, suggestedScope: 'my-erp' },
  profile: { available: [{ id: 'core:solo', version: 1 }, { id: 'core:team', version: 1 }] }, policy: { state: 'absent' },
  sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 0 }, check: { state: 'not-run' },
  families: { instructions: { file: 'missing', bridges: [{ id: 'claude-code', detected: true }, { id: 'agents-md', detected: false }] } } };
const registry = new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY]);
const tty = { isTTY: true }, pipe = { isTTY: false };
it('F5: profile choices use registry labels and presentation order, with the same id/version answers', () => {
  const available = ['core:custom', 'core:enterprise', 'core:team', 'core:solo'].map(id => ({ id, version: 1 }));
  const stage = { id: 'core:profile', state: 'needs-answer' } as SetupStage;
  const choices = stageChoices(stage, { ...base, profile: { available } }, 'tr');
  expect(choices.map(row => row.label)).toEqual(['Bireysel', 'Ekip', 'Kurumsal', 'Özel', 'Şimdi değil']);
  expect(choices[1]!.answer).toEqual({ id: 'core:team', version: 1 });
  expect(MESSAGE_REGISTRY.catalogs.tr['setup.question.profile']).toBe('Bu kurulumu kimler kullanacak?');
});
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
  it('U7 proposes the repository top only without an installation, accepts --here and reports an enclosing installation outside JSON', async () => {
    expect(offerTarget(true, '/repo', '/repo/installed')).toBe('/repo/installed');
    expect(offerTarget(false, '/repo', '/repo/a')).toBe('/repo');
    expect(offerTarget(false, null, '/scratch')).toBe('/scratch');
    expect(parseSetupFlags(['init', '--here', '--json'])).toMatchObject({ here: true, json: true });
    expect(() => parseSetupFlags(['init', '--here', '--here'])).toThrow(expect.objectContaining({ code: 'CLI_USAGE' }));
    const run = harness();
    await setupInitCommand(['init', '--json'], { ...run.context, rootResolution: { root: run.context.root!, folder: 'a', found: true, gitTop: null } });
    expect(JSON.parse(run.out()).schemaVersion).toBe(2);
    expect(run.err()).toContain('deckent init --here');
    expect(run.err()).toContain(run.context.root);
  });
  it('JSON contract: --json prints the versioned, locale-free plan document and applies nothing', async () => {
    const run = harness();
    await setupInitCommand(['init', '--json'], run.context);
    const document = JSON.parse(run.out()) as { schemaVersion: number; stages: { id: string; state: string }[]; apply: unknown };
    expect(document.schemaVersion).toBe(2);
    expect(document.apply).toEqual({ requested: false, results: [] });
    expect(document.stages.map(stage => stage.id)).toEqual(['core:language', 'core:environment', 'core:folder', 'core:profile', 'core:policy', 'core:sandbox', 'core:final-check']);
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
    for (const key of ['setup.stage.policy', 'setup.stage.finalCheck', 'setup.render.nothingApplied']) expect(text).toContain(catalog[key]!.split('{')[0]!.trim().slice(0, 20));
    expect(text).not.toContain('Model connection');
    expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true); // the command prints one final newline (Astra 2664 item 4)
    await expect(text).toMatchFileSnapshot(`../../fixtures/setup/plan-plain-${locale}.txt`);
  });

});

describe('I-S4 setup outcomes', () => {
  it('U3-2: language switches immediately, declined foreground stays unapplied, warnings do not enter a repeated --yes loop', async () => {
    const fresh = harness(), first = createSetupController({ context: fresh.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    const turkish = (await first.step('tr'))!;
    expect(turkish.title).toBe(MESSAGE_REGISTRY.catalogs.tr['setup.window.title']);
    expect(first.locale()).toBe('tr');
    const saved: SetupObservation = { ...base, language: { configured: 'en', requested: null, system: null },
      profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } }, folder: { ...base.folder, installation: 'present', configuredScope: 'my-erp' },
      policy: { state: 'upgradable' }, check: { state: 'warnings', pending: 2 } };
    const run = harness({ observation: () => saved }), controller = createSetupController({ context: run.context, root: '/x', locale: 'en',
      observed: { observation: saved, registry }, flags: { json: false, yes: false } });
    run.context.upgradePolicyTemplateInstallation = async () => ({ status: 'preview', expect: 'preview-digest', rules: [] });
    const stub = vi.spyOn(cards, 'askCliCard').mockResolvedValueOnce('no');
    try {
      await controller.step('yes');
      expect(await controller.step('apply')).toBeNull();
      expect(await controller.runPending()).toBe(true);
      expect(controller.model().rows.join('\n')).toContain('not applied');
      expect(controller.model().rows.join('\n')).toContain('Permissions: not applied. The confirmation step ended without approval.');
      expect(controller.model().rows.join('\n')).not.toContain('applied; observed again');
      await controller.step('later'); // defer the read-only check
      expect(controller.model().rows.join('\n')).toContain('step(s) put off');
      expect(controller.model().rows.join('\n')).not.toContain('Nothing left to answer');
    } finally { stub.mockRestore(); }
    const rerun = harness({ observation: () => ({ ...saved, policy: { state: 'current' } }), apply: () => 'applied' });
    await setupInitCommand(['init', '--yes', '--scope', 'my-erp', '--json'], rerun.context);
    expect(rerun.applied).toEqual([]);
    const doc = JSON.parse(rerun.out());
    expect(doc.stages.find((stage: { id: string }) => stage.id === 'core:final-check').state).toBe('done');
    expect(doc).not.toHaveProperty('firstJob');
    for (const locale of ['en', 'tr'] as const) {
      const human = harness({ observation: () => ({ ...saved, language: { configured: locale, requested: null, system: null }, policy: { state: 'current' } }) });
      await setupInitCommand(['init', '--lang', locale], human.context);
      expect(human.out()).toContain(locale === 'en' ? 'Final check · check ran · The final check ran; 2 item(s) wait for you. Run deckent doctor for the results and next steps.' : 'Son kontrol · kontrol çalıştı · Son kontrol çalıştı; 2 madde sizi bekliyor. Sonuçlar ve sonraki adımlar için deckent doctor çalıştırın.');
      expect(human.out()).not.toContain(locale === 'en' ? 'Final check · done' : 'Son kontrol · tamam');
    }
    const onboard = harness();
    await setupInitCommand(['init', '--json', '--phase', 'onboarding'], onboard.context);
    expect(JSON.parse(onboard.out()).stages.map((stage: { id: string }) => stage.id)).toEqual(['core:model', 'instructions:bridges']);
    expect(onboard.applied).toEqual([]);
    expect(await failure(setupInitCommand(['init', '--json', '--phase', 'onboarding', '--yes', '--scope', 's'], onboard.context))).toBe('CLI_USAGE');
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
    expect(run.out()).toContain('deckent setup plan'); expect(run.applied).toEqual([]); expect(run.rawMode()).toBe(0);
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
    // A folder with no scope yet asks for a new name instead of "valid scopes: -".
    const message = await setupInitCommand(['init', '--yes'], harness({}).context).then(() => '', (error: Error) => error.message);
    expect(message).toContain('--scope my-project'); expect(message).not.toContain('Valid scopes');
    // A configured scope alone is not taken for --yes; several installed scopes still need --scope.
    const configured = harness({ observation: () => ({ ...base, folder: { ...base.folder, configuredScope: 'live' } }) });
    expect(await failure(setupInitCommand(['init', '--yes'], configured.context))).toBe('CLI_SCOPE_REQUIRED');
    const scopes = (values: readonly string[]) => ({ configChoiceSources: () => ({ list: async () => values.map(value => ({ value })) }) });
    const several = harness();
    expect(await failure(setupInitCommand(['init', '--yes'], { ...several.context, ...scopes(['live', 'test']) } as never))).toBe('CLI_SCOPE_REQUIRED');
    // INIT-D5 amended (REALSURF2 2026-10-26): an installed folder with exactly one scope re-runs in it and says which.
    const single = harness({ observation: () => ({ ...base, folder: { ...base.folder, installation: 'present', configuredScope: 'live' } }) });
    expect(await failure(setupInitCommand(['init', '--yes'], { ...single.context, ...scopes(['live']) } as never))).not.toBe('CLI_SCOPE_REQUIRED');
    expect(single.out()).toContain('live'); expect(single.observed()).toBeGreaterThan(0);
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
    expect(run.applied.map(stage => [stage.id, stage.operation!.id])).toEqual([['core:policy', 'installation.policy-template'], ['core:language', 'config.set']]);
    expect(run.applied.find(stage => stage.id === 'core:language')!.operation!.input).toEqual({ keyPath: 'language', value: 'tr', layer: 'global' });
    expect(run.observed()).toBe(3);
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
        expect((JSON.parse(run.out()) as { stages: { id: string; state: string }[] }).stages.filter(stage => stage.id !== 'core:environment').every(stage => stage.state === 'unsupported')).toBe(true);
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

it('N2: name the postponed permission step and keep each earlier apply outcome separate', async () => {
  const registry = new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY, SETUP_PERMISSIONS_FAMILY]);
  const saved: SetupObservation = { ...base, language: { configured: 'en', requested: null, system: null },
    folder: { ...base.folder, configuredScope: 'my-erp' }, profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } },
    sandbox: { ...base.sandbox, selfTest: 'not-run' }, families: { ...base.families, permissions: null } };
  const installed: SetupObservation = { ...saved, folder: { ...saved.folder, installation: 'present' }, policy: { state: 'current' },
    families: { ...saved.families, permissions: { state: 'needs-confirmation', digest: 'preview', profile: 'core:solo', principal: 'person',
      mode: 'full-auto', effectiveMode: 'standart', selectedProfile: { id: 'core:solo', version: 1 } } } };
  const run = harness({ apply: () => 'applied' });
  const create = () => createSetupController({ context: { ...run.context, observeSetup: async () => ({ observation: installed, registry }) },
    root: '/x', locale: 'en', observed: { observation: saved, registry }, flags: { json: false, yes: false } });
  const earlier = create(), policy = await earlier.step('yes');
  expect(policy?.rows.find(row => row.startsWith('>'))).toContain('Permissions · ready to apply');
  await earlier.step('later');
  const beforeApply = earlier.outcome();
  expect(beforeApply.results).toEqual([]);
  expect(run.applied).toEqual([]);
  const controller = create();
  await controller.step('yes');
  expect(await controller.step('apply')).toBeNull();
  await controller.runPending();
  expect(controller.model().rows.find(row => row.startsWith('>'))).toContain('Starting permissions · ready to apply');
  const sandbox = await controller.step('later');
  expect(sandbox?.rows.find(row => row.startsWith('>'))).toContain('Command sandbox · ready to apply');
  await controller.step('later');
  const outcome = controller.outcome();
  expect(run.applied.map(stage => stage.id)).toEqual(['core:policy']);
  for (const [locale, applied, starting, sandboxPostponed, installing] of [
    ['en', 'Permissions: applied; observed again.', 'You postponed “Starting permissions”. Run deckent init in this folder to continue.',
      'You postponed “Command sandbox”.', 'You postponed “Permissions”. Run deckent init in this folder to continue.'],
    ['tr', 'İzinler: uygulandı; yeniden gözlendi.', '“Başlangıç izinleri” adımını ertelediniz. Devam etmek için bu klasörde deckent init çalıştırın.',
      '“Komut korumalı alanı” adımını ertelediniz.', '“İzinler” adımını ertelediniz. Devam etmek için bu klasörde deckent init çalıştırın.'],
  ] as const) {
    const summary = renderSetupLines(outcome.plan, locale, { requested: false, results: outcome.results }, outcome);
    expect(summary).toContain(applied);
    expect(summary).toContain(starting);
    expect(summary).toContain(sandboxPostponed);
    expect(summary).not.toMatch(/you said no|vazgeçtiniz|Authority pending|Yetki onayı bekliyor/u);
    const earlierSummary = renderSetupLines(beforeApply.plan, locale, { requested: false, results: beforeApply.results }, beforeApply);
    expect(earlierSummary).toContain(installing);
    expect(earlierSummary).not.toContain(starting);
    expect(earlierSummary).not.toMatch(/you said no|vazgeçtiniz|Authority pending|Yetki onayı bekliyor/u);
  }
});

it('N2: the open model and coding-work cards name their own next choices in EN and TR', async () => {
  const question = await import('../../../src/surfaces/core/terminal-onboarding/internal/question.js');
  const { runOnboardingSession } = await loadOnboardingScreens();
  const docker: RuntimeFacts = { id: 'docker', label: 'Docker', support: 'supported', cli: 'found', path: '/usr/bin/docker', version: null,
    daemon: 'reachable', serverVersion: null, kind: 'engine', endpoint: 'system', group: null };
  const worker = { configured: null, receipt: null, image: 'not-run', git: '/usr/bin/git' };
  const workFacts = { execution: false, registry: false, pool: false, poolMissing: true };
  const observation: SetupObservation = { ...base, folder: { ...base.folder, installation: 'present', configuredScope: 'my-erp' },
    policy: { state: 'current' }, families: { execution: { schemaVersion: 1, runtimes: [docker], worker }, work: workFacts } };
  const setupRegistry = new SetupStageRegistry([executionSetupFamily({ person: true }), WORK_SETUP_FAMILY]);
  const makePlan = (facts: SetupObservation, values: Readonly<Record<string, unknown>> = {}) =>
    planSetup(facts, { schemaVersion: 2, values }, setupRegistry, { phase: 'onboarding' });
  const plan = makePlan(observation);
  const snapshot: OnboardingSnapshot = { observation, plan, configBasis: { projectDigest: 'a'.repeat(64), globalDigest: 'b'.repeat(64) },
    answers: {}, deferred: ['onboarding:first-task:done'], modelUsable: false, folder: '/fixture', folderFacts: { kind: 'coding', entries: [] }, scopeId: 'my-erp',
    hosts: [{ id: 'codex', cli: 'found', login: 'found' }], budget: { needed: false, presetUsd: 10, presetsUsd: [], currentUsd: null },
    permissions: { state: 'applied', reason: '' }, pending: [] };
  const image = { provider: 'codex', image: 'present', receipt: { imageId: `sha256:${'a'.repeat(64)}`, imageVersion: 'r5-20261023' } };
  const chosenCli: SetupObservation = { ...observation, families: { ...observation.families,
    execution: { schemaVersion: 1, runtimes: [docker], worker: { ...worker, ...image } } } };
  const connection = { id: 'codex-subscription', provider: 'codex' };
  const port = { assertPerson: async () => {}, defer: async () => {} };
  const ask = vi.spyOn(question, 'askOnboardingQuestion');
  try {
    for (const [locale, model, work, outside, readyTitle, subscription] of [
      ['en', 'Choose “Enter · Continue” here to connect a chat model.', 'Choose “Enter · Continue” to use codex for the first work kind.',
        'The first worker cannot start because no worker pool is set up. Choose the first work kind in /setup, then set up its pool.',
        'Execution settings', 'Choose a subscription here to confirm the first work kind and set up its worker pool.'],
      ['tr', 'Sohbet modeli bağlamak için bu kartta “Enter · Devam”ı seçin.', 'İlk iş türünde codex kullanmak için “Enter · Devam”ı seçin.',
        'İşçi havuzu kurulmadığı için ilk işçi başlatılamıyor. /setup içinde ilk iş türünü seçin, ardından havuzunu kurun.',
        'Çalıştırma ayarları', 'İlk iş türünü onaylamak ve işçi havuzunu kurmak için bu kartta bir abonelik seçin.'],
    ] as const) {
      const pool = plan.stages.find(stage => stage.id === 'work:pool')!;
      expect(setupMessage(pool.reason.code, pool.reason.params, locale)).toBe(outside);
      ask.mockReset().mockResolvedValue({ id: 'exit' }).mockResolvedValueOnce({ id: 'later' }).mockResolvedValueOnce({ id: 'change' })
        .mockResolvedValueOnce({ id: 'codex' }).mockResolvedValueOnce({ id: 'codex' });
      await runOnboardingSession({ ...port, observe: async answers => answers['work:kind']
        ? { ...snapshot, answers, observation: chosenCli, plan: makePlan(chosenCli, answers) } : snapshot } as OnboardingPort, { locale } as never, { locale });
      const [modelCard, workCard, picker, confirmation, destination] = ask.mock.calls.map(([card]) => card);
      expect(modelCard?.title).toBe(locale === 'en' ? 'Model connection' : 'Model bağlantısı');
      expect(workCard?.title).toBe(locale === 'en' ? 'Use codex for coding work?' : 'Kodlama işlerini codex yapsın mı?');
      expect(destination?.title).toBe(readyTitle);
      const poolStep = locale === 'en' ? `Set up its pool at “${destination?.title}”.` : `Havuzu “${destination?.title}” adımında kurun.`;
      const modelPoolStep = locale === 'en' ? `If you choose a coding CLI, set up its pool at “${destination?.title}”.`
        : `Kodlama CLI seçerseniz havuzu “${destination?.title}” adımında kurun.`;
      expect(modelCard?.body?.join(' ')).toContain(model);
      expect(modelCard?.body).toContain(modelPoolStep);
      expect(workCard?.body?.join(' ')).toContain(work);
      expect(workCard?.body?.join(' ')).toContain(poolStep);
      expect(picker?.choices.map(choice => choice.id)).toContain('codex');
      expect(picker?.body?.join(' ')).toContain(poolStep);
      expect(confirmation?.body?.join(' ')).toContain(work);
      expect(confirmation?.body?.join(' ')).toContain(poolStep);
      expect([...(modelCard?.body ?? []), ...(workCard?.body ?? [])].join(' ')).not.toContain('/setup');

      const applied: string[] = [];
      const offered = { ...snapshot, connections: [connection] };
      ask.mockReset().mockResolvedValue({ id: 'exit' }).mockResolvedValueOnce({ id: 'later' }).mockResolvedValueOnce({ id: `connection:${connection.id}` });
      await runOnboardingSession({ ...port, apply: async stage => { applied.push(stage.id); return { status: 'applied' }; }, observe: async answers => {
        if (!answers['work:kind']) return offered;
        const execution = applied.includes('execution:worker-settings'), registry = applied.includes('work:kind'), pool = applied.includes('work:pool');
        const facts = { ...observation, families: { execution: { schemaVersion: 1, runtimes: [docker], worker: { ...worker, connection: execution ? 'configured' : 'pending' } },
          work: { ...workFacts, execution, registry, pool, connection } } };
        return { ...offered, answers, observation: facts, plan: makePlan(facts, answers) };
      } } as OnboardingPort, { locale } as never, { locale });
      const [subscriptionModel, subscriptionWork] = ask.mock.calls.map(([card]) => card);
      expect(applied).toEqual(['execution:worker-settings', 'work:kind', 'work:pool']);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(subscriptionModel?.body?.join(' ')).toContain(model);
      expect(subscriptionModel?.body?.join(' ')).not.toMatch(/set up its pool at|havuzu .* adımında kurun/iu);
      expect(subscriptionWork?.body?.join(' ')).toContain(subscription);
    }
  } finally { ask.mockRestore(); }
});

describe('I-S4 setup window controller (no Ink)', () => {
  it('U3 lead round 1: language and profile answers precede permissions; only the installation permits saving them', async () => {
    let observed = base;
    const run = harness({ observation: () => observed, apply: stage => {
      if (stage.id === 'core:policy') observed = { ...observed, policy: { state: 'current' }, folder: { ...base.folder, installation: 'present', configuredScope: 'my-erp' } };
      if (stage.id === 'core:language') observed = { ...observed, language: { ...base.language, configured: 'en' } };
      if (stage.id === 'core:profile') observed = { ...observed, profile: { ...base.profile, selected: { id: 'core:team', version: 1 } } };
      return 'applied';
    } });
    const controller = () => createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    const deferred = controller();
    await deferred.step('later'); await deferred.step('yes'); await deferred.step('core:team');
    expect(deferred.outcome().plan.stages.find(stage => stage.id === 'core:policy')).toMatchObject({ state: 'blocked', operation: null,
      reason: { code: 'setup.reason.waitsFor', params: { stage: 'core:language' } } });
    const fresh = controller();
    await fresh.step('en'); await fresh.step('yes');
    expect(fresh.model().rows.join('\n')).toContain('1. Language · answered');
    await fresh.step('later');
    expect(fresh.outcome().plan.stages.find(stage => stage.id === 'core:policy')).toMatchObject({ state: 'blocked', operation: null,
      reason: { code: 'setup.reason.waitsFor', params: { stage: 'core:profile' } } });
    const chosen = controller();
    await chosen.step('en'); await chosen.step('yes'); await chosen.step('core:team');
    expect(chosen.model().rows.join('\n')).toContain('4. Who uses this installation · answered');
    expect(run.applied).toEqual([]);
    await chosen.step('yes'); expect(await chosen.step('apply')).toBeNull();
    expect(run.applied).toEqual([]); expect(await chosen.runPending()).toBe(true);
    expect(run.applied[0]!.operation!.input).toEqual({ scopeId: 'my-erp' });
    expect(chosen.model().rows.find(row => row.startsWith('>'))).toContain('1. Language');
    await chosen.step('apply');
    expect(chosen.model().rows.find(row => row.startsWith('>'))).toContain('4. Who uses this installation');
    await chosen.step('apply');
    expect(run.applied.map(stage => stage.id)).toEqual(['core:policy', 'core:language', 'core:profile']);
    expect(chosen.outcome().plan.stages.filter(stage => ['core:language', 'core:profile', 'core:policy'].includes(stage.id)).every(stage => stage.state === 'done')).toBe(true);
  });

  it('keeps one height, answers re-plan, "not now" and a not-wired apply put a stage off, and nothing is applied without Apply', async () => {
    const run = harness();
    const controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    const first = controller.model();
    expect(first.options.map(option => option.id)).toEqual(['en', 'tr', 'later']);
    // Owner 2026-10-26: the recommended answer is highlighted (the detected Turkish), so Enter accepts it; reason and question wrap in fixed rows.
    expect(first.initial).toBe(1); expect(first.heights?.slice(-3)).toEqual([3, 2, 1]);
    expect(first.rows[0]).toMatch(/^> 1\. Language/u);
    const sizes = [first.rows.length];
    let model = (await controller.step('en'))!; sizes.push(model.rows.length);
    expect(model.rows[2]).toMatch(/^> 3\. Folder and scope/u); expect(model.options.map(option => option.id)).toEqual(['yes', 'later']); expect(model.initial).toBe(0);
    model = (await controller.step('yes'))!; sizes.push(model.rows.length);
    model = (await controller.step('core:solo'))!; sizes.push(model.rows.length);
    // A profile reads as its label, never the raw `core:solo`.
    const lines = renderSetupLines(controller.outcome().plan, 'en', { requested: false, results: [] });
    expect(lines).toMatch(/4\. Who uses this installation · [^\n]* · Solo · /u); expect(lines).not.toContain('core:solo');
    // BeUser S-10: a refused encrypted-store default is said, with where to fix it (keys otherwise silently come from the environment).
    const refusedStore = renderSetupLines(controller.outcome().plan, 'en', { requested: true, results: [{ stage: 'core:policy', operation: 'installation.policy-template', status: 'applied',
      secretStore: { status: 'not-set', backend: null, code: 'SECRET_STORE_UNSAFE' } }] });
    expect(refusedStore).toContain('the encrypted key store could not be set up here (SECRET_STORE_UNSAFE)'); expect(refusedStore).toContain('deckent secret store');
    expect(model.rows[4]).toMatch(/^> 5\. Permissions · needs your answer/u);
    model = (await controller.step('yes'))!; sizes.push(model.rows.length);
    expect(model.options.map(option => option.id)).toEqual(['apply', 'later']);
    expect(run.applied).toEqual([]);
    expect(await controller.step('apply')).toBeNull(); expect(run.applied).toEqual([]);
    expect(await controller.runPending()).toBe(true); model = controller.model(); sizes.push(model.rows.length);
    expect(run.applied.map(stage => stage.operation!.id)).toEqual(['installation.policy-template']);
    expect(model.rows.at(-1)).toContain('cannot apply setup stages yet');
    expect(new Set(sizes).size).toBe(1);
    expect(model.optionRows).toBe(first.optionRows);
    expect(await controller.step('not-an-option')).toBeNull();
    expect(controller.outcome().results).toEqual([{ stage: 'core:policy', operation: 'installation.policy-template', status: 'not-wired' }]);
    // The single "Close" answer is highlighted too, so Enter closes the finished window (REALSURF: Enter was ignored there).
    for (let turn = 0; turn < 20 && model.options[0]?.id !== 'close'; turn++) model = (await controller.step(model.options.at(-1)!.id))!;
    expect(model.options.map(option => option.id)).toEqual(['close']); expect(model.initial).toBe(0);
  });
});

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('N3 + walk19R: a long reason wraps whole at 72 columns; an answer being applied shows it, a key then is visibly not used and never answers the next step', async () => {
  const { PassThrough, Writable } = await import('node:stream'), { mountSetupWindow } = await import('#surfaces/core/project-instructions/index.js');
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 72, rows: 36 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const reason = 'my-project scope for HOST/1000 starts with the Solo profile in full-auto. Usual work follows the company policy; protected settings, secrets and destructive operations keep their own approval rules. Switch the mode with Shift+Tab or /mode at any time; nothing else changes.';
  const model = { title: 'deckent setup', rows: ['> 7. Start permissions · ready to apply', '', reason, '', ''], heights: [1, 1, 3, 2, 1], options: [{ id: 'apply', label: 'Apply now' }],
    optionRows: 2, initial: 0, hints: 'Esc close', decisionArm: decisionArmLabels('en'), applying: 'Applying…', busyKey: 'keys ignored', position: '{from}-{to}/{total}', reveal: 0 };
  const sent: string[] = [];
  let release = () => {};
  const closed = mountSetupWindow(model, id => { sent.push(id); return sent.length > 1 ? Promise.resolve(null) : new Promise(resolve => { release = () => resolve({ ...model, rows: ['> 8. Final check · ready to apply', '', 'Next step', '', ''] }); }); },
    { stdin: stdin as never, stdout: stdout as never, env: { NO_COLOR: '1' } });
  await new Promise(resolve => setTimeout(resolve, 150));
  const text = () => frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' '); // eslint-disable-line no-control-regex
  expect(text()).toContain(reason);
  // A decision window counts keys only after its quiet arming period; then Enter applies. While it applies, a second Enter is shown as not used.
  const { DECISION_ARM_DEFAULT } = await import('#surfaces/core/terminal-window/index.js'), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await pause(DECISION_ARM_DEFAULT + 200); stdin.write('\r'); await pause(150);
  expect(text()).toContain('Applying…'); stdin.write('\r'); await pause(150);
  expect(text()).toContain('Applying… · keys ignored'); expect(sent).toEqual(['apply']);
  // The next step's window re-arms: the key typed during the apply did not answer it; Enter after its arming does.
  release(); await pause(150); expect(text()).toContain('Next step'); expect(sent).toEqual(['apply']);
  await pause(DECISION_ARM_DEFAULT + 200); stdin.write('\r');
  await Promise.race([closed, pause(2000).then(() => { throw new Error(`setup did not close: ${JSON.stringify(sent)} ${text()}`); })]); expect(sent).toEqual(['apply', 'apply']);
});
/** Mounts the real guided window on a fake TTY with one controller model; returns the drawn text and the answers the window sent. */
async function setupWindowAt(model: import('#surfaces/core/project-instructions/index.js').SetupWindowModel,
  options: { columns?: number; rows?: number; early?: boolean; step?: import('#surfaces/core/project-instructions/index.js').SetupWindowStep } = {}) {
  const { PassThrough, Writable } = await import('node:stream'), { mountSetupWindow } = await import('#surfaces/core/project-instructions/index.js');
  let frame = '', finished = false;
  const sent: string[] = [];
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: options.columns ?? 100, rows: options.rows ?? 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const closed = mountSetupWindow(model, async id => { sent.push(id); const next = options.step ? await options.step(id) : null; finished = next === null; return next; }, { stdin: stdin as never, stdout: stdout as never, env: { NO_COLOR: '1' } });
  const text = () => terminalBuffers(frame, stdout.columns, stdout.rows).text.replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' ');
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(predicate(), text()).toBe(true);
  };
  await wait(() => text().includes(model.title));
  const armed = async () => { await new Promise(resolve => setTimeout(resolve, 30)); await wait(() => text().includes(model.hints) || text().includes(model.decisionArm.typedText) || text().includes(model.decisionArm.ignored)); };
  if (!options.early) await wait(() => text().includes(model.hints));
  return { text, screen: () => terminalBuffers(frame, stdout.columns, stdout.rows).text, sent, armed, wait, press: async (keys: string) => { stdin.write(keys); await new Promise(resolve => setTimeout(resolve, 100)); },
    close: async () => { if (!finished) { await armed(); stdin.write('\u001b'); } await closed; } };
}
it('walk16: every yes/no stage of the guided window shows and takes (y)/(n), "Not now" beside a real No stays letterless; language has no letters, Enter still sends', async () => {
  const controller = createSetupController({ context: harness().context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
  // A true multi-choice question (the language): no letters, a typed y is not an answer, Enter sends the highlighted (recommended) one.
  const language = await setupWindowAt(controller.model());
  try {
    expect(language.text()).toContain('2. Türkçe'); expect(language.text()).not.toMatch(/\d\. [^\n]* \([a-z]\)/u);
    await language.press('y'); expect(language.sent).toEqual([]);
    await language.press('\r'); expect(language.sent).toEqual([]);
    await language.press('\r'); expect(language.sent).toEqual(['tr']);
  } finally { await language.close(); }
  await controller.step('en'); await controller.step('yes'); await controller.step('core:solo');
  const permissions = controller.model();
  expect(permissions.rows[4]).toMatch(/^> 5\. Permissions · needs your answer/u);
  for (const [typed, answer] of [['y', 'yes'], ['n', 'no']] as const) {
    const view = await setupWindowAt(permissions);
    try {
      expect(view.text()).toContain('1. Yes (y)'); expect(view.text()).toContain('2. No (n)');
      expect(view.text()).toContain('3. Not now'); expect(view.text()).not.toContain('Not now (');
      await view.press(typed); expect(view.sent).toEqual([answer]);
    } finally { await view.close(); }
  }
  // The apply step that follows asks yes or not now: Apply takes y, "Not now" (its only no) takes n.
  const apply = (await controller.step('yes'))!;
  const view = await setupWindowAt(apply);
  try {
    expect(view.text()).toContain('1. Apply now (y)'); expect(view.text()).toContain('2. Not now (n)');
    await view.press('n'); expect(view.sent).toEqual(['later']);
  } finally { await view.close(); }
});

it('107: individually typed text, a rejected burst or a paste (armed or early) each block one Enter, in EN/TR', async () => {
  for (const locale of ['en', 'tr'] as const) for (const input of ['typed', 'paste', 'burst', 'early-text', 'early-paste', 'early-burst']) {
    const run = harness(), controller = createSetupController({ context: run.context, root: '/x', locale, observed: { observation: base, registry }, flags: { json: false, yes: false } });
    await controller.step(locale);
    const model = controller.model(), view = await setupWindowAt(model, { early: input.startsWith('early'), step: controller.step });
    try {
      if (input.startsWith('early')) expect(view.text()).not.toContain(model.hints);
      if (input === 'typed') for (const char of '/help') await view.press(char); // Separate stdin reads, beyond the production arming wait.
      else await view.press(input.endsWith('paste') ? '\u001b[200~/help\r\ny1\u001b[201~' : input.endsWith('burst') ? '\u001b[Ay' : '/');
      if (input !== 'typed') { expect(view.text()).toContain(model.decisionArm.arming); expect(view.text()).not.toContain(model.decisionArm.typedText); }
      await view.armed(); expect(view.text()).toContain(input === 'early-text' ? model.decisionArm.ignored : model.decisionArm.typedText);
      await view.press('\r');
      expect(view.sent, `${locale}/${input}`).toEqual([]); expect(run.applied).toEqual([]);
      expect(controller.model().rows).toEqual(model.rows);
      expect(view.text()).toContain(model.decisionArm.unchosen); expect(view.text()).toContain(model.hints); expect(view.text()).not.toContain(model.decisionArm.typedText);
      await view.press('\r'); expect(view.sent).toEqual(['yes']);
      // The next step has its own arming period and no inherited text flag.
      await view.armed(); await view.press('\r'); expect(view.sent).toEqual(['yes', 'core:solo']);
    } finally { await view.close(); }
  }
}, 30_000);

it('108 probe 1: /task typed in separate reads then Enter never answers the highlighted setup row', async () => {
  const controller = createSetupController({ context: harness().context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
  await controller.step('en');
  const view = await setupWindowAt(controller.model());
  try {
    for (const char of '/task') await view.press(char);
    await view.press('\r'); expect(view.sent).toEqual([]);
  } finally { await view.close(); }
});

it('108 probe 2: /policy typed in separate reads never answers the setup card by its y', async () => {
  const controller = createSetupController({ context: harness().context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
  await controller.step('en');
  const view = await setupWindowAt(controller.model());
  try {
    for (const char of '/policy') await view.press(char);
    expect(view.sent).toEqual([]);
  } finally { await view.close(); }
});

it('109: slow-apply text follows the next setup question; a lone early y repeats, never carries into question two', async () => {
  const controller = createSetupController({ context: harness().context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
  await controller.step('en'); const model = controller.model();
  let release!: () => void;
  const view = await setupWindowAt(model, { step: async id => id === 'close' ? null : new Promise(resolve => { release = () => resolve({ ...model, title: 'Next setup card' }); }) });
  try {
    await view.press('y'); expect(view.sent).toEqual(['yes']);
    await view.press('e'); await view.press('s');
    expect(view.text()).toContain(model.decisionArm.typedText);
    release(); await view.wait(() => view.text().includes('Next setup card')); await view.armed();
    expect(view.text()).toContain('Next setup card');
    await view.press('\r'); expect(view.sent).toEqual(['yes']);
  } finally { release?.(); await view.close(); }
  const early = await setupWindowAt(model, { early: true, step: async id => id === 'close' ? null : ({ ...model, title: 'Second question' }) });
  try {
    await early.press('y'); expect(early.sent).toEqual([]); expect(early.text()).toContain(model.decisionArm.arming); expect(early.text()).not.toContain(model.decisionArm.typedText);
    await early.wait(() => early.text().includes(model.decisionArm.ignored));
    await early.press('y'); expect(early.sent).toEqual(['yes']);
    await early.wait(() => early.text().includes('Second question') && early.text().includes(model.hints));
    expect(early.text()).not.toContain(model.decisionArm.ignored);
    await early.press('n'); expect(early.sent).toEqual(['yes', 'later']);
  } finally { await early.close(); }
});

it('108/111: only arrows clear typed text; first-key y, n and digits and early Enter keep their meaning; a first j or k is text', async () => {
  const run = harness(), controller = createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
  await controller.step('en'); const model = controller.model();
  for (const key of ['\u001b[B', 'j', 'k', 'y', '1', 'n', '2']) {
    const view = await setupWindowAt(model);
    try {
      await view.press('/'); await view.press(key);
      expect(view.sent).toEqual([]);
      await view.press('\r');
      if (key !== '\u001b[B') { expect(view.sent).toEqual([]); await view.press('\r'); }
      expect(view.sent).toEqual([key === '\u001b[B' ? 'later' : 'yes']);
    } finally { await view.close(); }
  }
  for (const [key, answer] of [['y', 'yes'], ['n', 'later'], ['1', 'yes']] as const) {
    const view = await setupWindowAt(model);
    try { await view.press(key); expect(view.sent).toEqual([answer]); } finally { await view.close(); }
  }
  // Owner 111 (2026-11-15): j and k are ordinary letters on a card. As a first key they move nothing and start typed text, so the Enter
  // after them chooses nothing (before, j + Enter answered "Not now" and k + Enter the row above); the next Enter takes the highlighted row.
  for (const key of ['j', 'k']) {
    const view = await setupWindowAt(model);
    try {
      await view.press(key); expect(view.sent).toEqual([]); expect(view.text()).toContain(model.decisionArm.typedText);
      await view.press('\r'); expect(view.sent).toEqual([]);
      await view.press('\r'); expect(view.sent).toEqual(['yes']);
    } finally { await view.close(); }
  }
  const early = await setupWindowAt(model, { early: true });
  try {
    expect(early.text()).not.toContain(model.hints);
    await early.press('\r'); expect(early.sent).toEqual([]);
    await early.armed(); await early.press('\r'); expect(early.sent).toEqual(['yes']);
  } finally { await early.close(); }
}, 15_000);

it('B27a: the foreground final check passes the invocation language explicitly to doctor', async () => {
  const doctor = vi.spyOn(observe, 'runKernelCommand').mockResolvedValue(undefined);
  try {
    const stage = { id: 'core:final-check', operation: { id: 'doctor.inspect', input: {} } } as SetupStage;
    expect(await runForegroundStage(harness().context, '/x', stage, null, 'en')).toMatchObject({ status: 'applied' });
    expect(doctor).toHaveBeenCalledWith(['doctor', '--lang', 'en'], expect.objectContaining({ locale: 'en' }));
  } finally { doctor.mockRestore(); }
});

it('119-F1b: one fresh execution preview feeds the witnessed apply and safe history defaults; cancellation and refusals never apply', async () => {
  const saved: SetupObservation = { ...base, language: { configured: 'en', requested: null, system: null },
    folder: { ...base.folder, installation: 'present', configuredScope: 'my-erp' }, policy: { state: 'current' } };
  const run = harness({ stdin: tty, stdout: tty, env: { TERM: 'xterm-256color', ...personMarkersUnset() }, observation: () => saved });
  const requests: unknown[] = [];
  let history: 'never' | 'withdrawn' | 'unknown' = 'never', status = 'preview', conflicts: string[] = [], missing: string[] = [], applyStatus = 'upgraded';
  const preview = () => ({ status, revision: 'a-preview', summary: '+ run/reserve,cancel; attempt/execute,evaluate,read-output,recover-output', missing, reason: null, conflicts,
    executionHistory: history, executionScopes: ['my-erp', 'other'], rules: [{ id: 'first-run-mcp-progress-reserve', principals: [{ issuer: 'os-user/mcp', subject: 'person' }] }] });
  run.context.upgradePolicyTemplate = async (_root, _scope, input) => { requests.push(input);
    return input.mode === 'apply' ? { ...preview(), status: applyStatus } : requests.some(value => (value as { mode: string }).mode === 'apply') && applyStatus === 'upgraded' ? { ...preview(), status: 'current' } : preview(); };
  const controller = () => createSetupController({ context: run.context, root: '/x', locale: 'en', observed: { observation: saved, registry }, flags: { json: false, yes: false } });
  const card = vi.spyOn(cards, 'askCliCard');
  try {
    card.mockResolvedValue('grant');
    const first = controller(); await first.offerExecution(); await first.offerExecution();
    expect(card).toHaveBeenCalledTimes(1);
    expect(card.mock.calls[0]![0]).toMatchObject({ initial: 'grant', options: [{ id: 'grant', label: 'Grant permission and continue', role: 'yes' }, { id: 'not-now', label: 'Not now', role: 'no' }] });
    expect(card.mock.calls[0]![0].body!.join('\n')).toContain('Chat and every MCP client');
    expect(card.mock.calls[0]![0].body!.join('\n')).toContain('my-erp, other');
    expect(requests).toEqual([{ mode: 'preview', only: 'ai-execution', reason: expect.any(String) }, { mode: 'apply', expect: 'a-preview', only: 'ai-execution', reason: expect.any(String) }, { mode: 'preview', only: 'ai-execution', reason: expect.any(String) }]);
    for (const prior of ['withdrawn', 'unknown'] as const) {
      history = prior; requests.length = 0; card.mockClear().mockResolvedValue('not-now');
      await controller().offerExecution();
      expect(card.mock.calls[0]![0].initial).toBe('not-now');
      expect(card.mock.calls[0]![0].body!.join('\n')).toContain(prior === 'withdrawn' ? 'withdrawn on this installation earlier' : 'could not be verified');
      expect(requests).toHaveLength(1);
    }
    requests.length = 0; card.mockClear().mockResolvedValue(null); await controller().offerExecution(); expect(requests).toHaveLength(1);
    conflicts = ['custom-deny']; requests.length = 0; card.mockClear(); await controller().offerExecution(); expect(card).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
    conflicts = []; missing = ['delegation']; await controller().offerExecution(); expect(card).not.toHaveBeenCalled();
    missing = []; status = 'current'; await controller().offerExecution(); expect(card).not.toHaveBeenCalled();
    const sources = ['mcp-cap-ab053653ee0e8f24a74b-run', 'mcp-cap-ab053653ee0e8f24a74b-attempt'];
    run.context.previewSetupExecutionPermission = async () => ({ ...preview(), covered: [sources[0]!, ...sources].map((heldBy, i) => ({ ruleId: String(i), heldBy })) });
    const covered = controller(); await covered.offerExecution();
    const frame = await setupWindowAt(covered.model(), { columns: 60, rows: 24 });
    try {
      expect(frame.text()).toContain('PageUp/PageDown scroll');
      await frame.press('\u001b[F');
      const transcripts = process.env['DECKENT_I_S3_TRANSCRIPTS'];
      if (transcripts) await writeFile(join(transcripts, '119-coverage-frame.txt'), frame.screen());
      for (const id of sources) expect(frame.text().split(id)).toHaveLength(2);
      await frame.close(); expect(frame.text()).not.toMatch(/[›>] [12]\./u);
    } finally { await frame.close(); }
    const outcome = covered.outcome();
    for (const [locale, prefix] of [['en', 'Execution permissions are already covered:'], ['tr', 'Yürütme izinleri zaten karşılanıyor:']] as const) {
      const summary = renderSetupLines(outcome.plan, locale, { requested: false, results: outcome.results }, outcome);
      expect(summary).toContain(`${prefix} ${sources.join(', ')}.`);
      for (const id of sources) expect(summary.split(id)).toHaveLength(2);
    }
    const tall = await setupWindowAt(covered.model(), { columns: 100, rows: 40 });
    try { expect(tall.text()).not.toContain('PageUp/PageDown'); } finally { await tall.close(); }
    delete run.context.previewSetupExecutionPermission;
    status = 'preview'; history = 'never'; requests.length = 0; applyStatus = 'conflict'; card.mockResolvedValue('grant'); await controller().offerExecution(); expect(run.out()).toContain('Policy changed; preview again'); expect(requests).toHaveLength(2);
    requests.length = 0; applyStatus = 'unavailable'; await controller().offerExecution(); expect(run.out()).toContain('Outcome could not be verified'); expect(requests).toHaveLength(2);
    requests.length = 0; run.context.env = { TERM: 'xterm', CODEX_THREAD_ID: 'synthetic-marker' }; card.mockClear(); await controller().offerExecution(); expect(card).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  } finally { card.mockRestore(); }
});

it('D1 init warns with the shared Git refusal, while --json and --yes never ask a permission card', async () => {
  for (const command of ["chmod go-w -- '/project/.git'", '']) for (const flags of [['--json'], ['--yes', '--scope', 'my-erp', '--json']]) {
    const run = harness(), calls: boolean[] = [];
    await setupInitCommand(['init', ...flags], { ...run.context, gitDeliveryPermission: async (_root, _options, confirm) => {
      calls.push(Boolean(confirm)); return { path: '/project/.git', command, before: '0775', after: '0755' };
    }, applySetupStage: async (_root, stage) => ({ stage: stage.id, operation: stage.operation!.id, status: 'declined' }) });
    expect(run.err()).toContain('Other accounts can write to Git folder /project/.git');
    expect(run.err()).toContain(command || 'no command is offered'); if (!command) expect(run.err()).not.toContain('chmod');
    expect(calls).toEqual([false]); expect(JSON.parse(run.out())).toHaveProperty('schemaVersion');
  }
});

it('D1 human init offers the same pinned-folder card; decline stays a localized warning before setup continues', async () => {
  const card = vi.spyOn(cards, 'askCliCard').mockResolvedValue('no');
  try {
    for (const command of ["chmod go-w -- '/project/.git'", '']) for (const lang of ['en', 'tr'] as const) {
      const run = harness({ stdin: tty, stdout: tty }), stop = new Error('observation reached'); let calls = 0;
      const warning = { path: '/project/.git', command, before: '0775', after: '0755' };
      await expect(setupInitCommand(['init', '--lang', lang], { ...run.context, observeSetup: async () => { throw stop; },
        gitDeliveryPermission: async (_root, _options, confirm) => {
          calls++; if (!confirm) return warning;
          expect(await confirm(warning.path, warning.before, warning.after, warning.command)).toBe(false);
          throw ErrorRegistry.createError('PATCH_UNSAFE', { params: { ...warning, reason: 'git-directory-declined' } });
        } })).rejects.toBe(stop);
      expect(calls).toBe(2); expect(card.mock.calls.at(-1)![0]).toMatchObject({ initial: 'no', title: lang === 'en' ? 'Others can write to this folder; narrow the permission?' : 'Başkaları bu klasöre yazabiliyor; izni daraltalım mı?' });
      expect(card.mock.calls.at(-1)![0].body!.join('\n')).toContain(command || (lang === 'en' ? 'no command is offered' : 'komut sunulmuyor'));
      if (!command) expect(run.err()).not.toContain('chmod');
      expect(run.err()).toContain(lang === 'en' ? "This is the person's decision." : 'Bu karar kişiye aittir.');
    }
  } finally { card.mockRestore(); }
});
