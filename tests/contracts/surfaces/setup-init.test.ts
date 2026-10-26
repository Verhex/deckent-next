import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cards from '#surfaces/core/cli-human/index.js';
import { SetupStageRegistry, type SetupObservation, type SetupStage } from '#engine/index.js';
import { MESSAGE_REGISTRY, clearConfigCache } from '#platform/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY } from '#surfaces/core/project-instructions/index.js';
import { createSetupController, renderSetupLines, setupInitCommand, parseSetupFlags, stageChoices, type SetupApplyResult, type SetupCommandContext } from '#surfaces/core/setup/index.js';
import { offerTarget } from '#surfaces/core/cli-kit/index.js';

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

  it('U3-2: language switches immediately, declined foreground stays unapplied, warnings do not enter a repeated --yes loop', async () => {
    const fresh = harness(), first = createSetupController({ context: fresh.context, root: '/x', locale: 'en', observed: { observation: base, registry }, flags: { json: false, yes: false } });
    const turkish = (await first.step('tr'))!;
    expect(turkish.title).toBe(MESSAGE_REGISTRY.catalogs.tr['setup.window.title']);
    expect(first.locale()).toBe('tr');
    const saved: SetupObservation = { ...base, language: { configured: 'en', requested: null, system: null },
      profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } }, folder: { ...base.folder, installation: 'present', configuredScope: 'my-erp' },
      policy: { state: 'upgradable' }, check: { state: 'warnings' } };
    const run = harness({ observation: () => saved }), controller = createSetupController({ context: run.context, root: '/x', locale: 'en',
      observed: { observation: saved, registry }, flags: { json: false, yes: false } });
    run.context.upgradePolicyTemplateInstallation = async () => ({ status: 'preview', expect: 'preview-digest', rules: [] });
    const stub = vi.spyOn(cards, 'askCliCard').mockResolvedValueOnce('no');
    try {
      await controller.step('yes');
      expect(await controller.step('apply')).toBeNull();
      expect(await controller.runPending()).toBe(true);
      expect(controller.model().rows.join('\n')).toContain('not applied');
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
    expect(run.applied.find(stage => stage.id === 'core:language')!.operation!.input).toEqual({ keyPath: 'language', value: 'tr', layer: 'project' });
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
    await chosen.step('yes'); await chosen.step('apply');
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
    // The single "Close" answer is highlighted too, so Enter closes the finished window (REALSURF: Enter was ignored there).
    for (let turn = 0; turn < 20 && model.options[0]?.id !== 'close'; turn++) model = (await controller.step(model.options.at(-1)!.id))!;
    expect(model.options.map(option => option.id)).toEqual(['close']); expect(model.initial).toBe(0);
  });
});

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('N3: a long reason wraps whole at 72 columns (no "…" cut); a one-row stage line still fits its row', async () => {
  const { PassThrough, Writable } = await import('node:stream'), { mountSetupWindow } = await import('#surfaces/core/project-instructions/index.js');
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 72, rows: 36 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const reason = 'my-project scope for HOST/1000 starts with the Solo profile in full-auto. Usual work follows the company policy; protected settings, secrets and destructive operations keep their own approval rules. Switch the mode with Shift+Tab or /mode at any time; nothing else changes.';
  const closed = mountSetupWindow({ title: 'Deckent setup', rows: ['> 7. Start permissions · ready to apply', '', reason, '', ''], heights: [1, 1, 3, 2, 1], options: [{ id: 'later', label: 'Not now' }],
    optionRows: 2, initial: 0, hints: 'Esc close', position: '{from}-{to}/{total}', reveal: 0 }, async () => null, { stdin: stdin as never, stdout: stdout as never, env: { NO_COLOR: '1' } });
  await new Promise(resolve => setTimeout(resolve, 150));
  const text = frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' '); // eslint-disable-line no-control-regex
  expect(text).toContain(reason);
  // A decision window counts keys only after its quiet arming period; then "Not now" closes it.
  const { DECISION_ARM_DEFAULT } = await import('#surfaces/core/terminal-window/index.js');
  await new Promise(resolve => setTimeout(resolve, DECISION_ARM_DEFAULT + 200)); stdin.write('\r');
  await closed;
});
