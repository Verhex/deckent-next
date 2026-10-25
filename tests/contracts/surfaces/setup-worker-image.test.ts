import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planSetup, planFirstWorkerImage, SetupStageRegistry, WORK_SETUP_FAMILY, WorkerImageSetupApplication, type SetupObservation, type WorkerImageCard, type WorkerImagePorts } from '#engine/index.js';
import { nativeCliIds } from '#domain/index.js';
import { executionSetupFamily, type ExecutionFacts } from '#adapters/core/setup-detect-execution/index.js';
import { buildWorkerImageInHome, observeWorkerImage, readNewestWorkerReceipt, readWorkerImageSources, workerImagePresence, workerImageSetupPorts, type WorkerImageBuildRunner } from '#adapters/index.js';
import { doctorChecks, firstJobCommand, firstJobSteps, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';
import { isForegroundStage, parseSetupFlags, runForegroundStage, stageChoices, unattendedAnswers, type SetupCommandContext } from '#surfaces/core/setup/index.js';
import { configuredSetup } from '#composition/core/setup/index.js';
import { parseVersionHistory, validateRecipe } from '../../../assets/worker-image/history.mjs';

/**
 * BR1 (owner Q2 2026-10-23): the first durable job without hand JSON. `deckent init` asks a person whether to build the worker image (a card
 * with size and time first), or adopts one named with `--image-id`; the next observation composes the execution settings from the detected
 * Docker and Git paths and the receipt's image, written through the existing `config.set`. Doctor and the first-job list check the configured
 * image read-only (`image inspect`). Negatives first: no person, no Docker, missing image, declined, half-done, second init.
 */
const IMAGE = `sha256:${'a'.repeat(64)}`, OTHER = `sha256:${'b'.repeat(64)}`;
const roots: string[] = [];
const temp = async (name: string) => { const path = await mkdtemp(join(tmpdir(), `deckent-br1-${name}-`)); roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const docker = { id: 'docker', label: 'Docker', support: 'supported', cli: 'found', path: '/usr/bin/docker', version: '29.1.3', daemon: 'reachable', serverVersion: '29.1.3',
  kind: 'engine', endpoint: 'system', group: null } as const;
type Worker = NonNullable<ExecutionFacts['worker']>;
const worker = (extra: Partial<Worker> = {}): Worker => ({ provider: nativeCliIds[0], configured: null, receipt: null, image: 'not-run', git: '/usr/bin/git', ...extra });
const observation = (execution: Partial<ExecutionFacts> | null, scope: string | null = 'erp-demo'): SetupObservation => ({ schemaVersion: 1,
  environment: { platform: 'linux', node: 'supported' }, language: { configured: 'en', requested: null, system: 'en' },
  folder: { installation: 'present', homeRoot: false, configuredScope: scope, suggestedScope: 'erp-demo' }, profile: { available: [{ id: 'core:solo', version: 1 }], selected: { id: 'core:solo', version: 1 } },
  policy: { state: scope ? 'current' : 'absent' }, sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 1 }, check: { state: 'ok' },
  families: execution ? { execution: { schemaVersion: 1, runtimes: [docker], ...execution } } : {} });
const stages = (facts: Partial<ExecutionFacts> | null, values: Record<string, unknown> = {}, person = true, scope: string | null = 'erp-demo') => {
  const plan = planSetup(observation(facts, scope), { schemaVersion: 1, values }, new SetupStageRegistry([executionSetupFamily({ person })]));
  const find = (id: string) => plan.stages.find(stage => stage.id === id)!;
  return { plan, image: find('execution:worker'), settings: find('execution:worker-settings') };
};

describe('BR1 setup stages: worker image, then the execution settings (pure plan)', () => {
  it('order: the runtime, the worker image, the execution settings, then the model; family stages are never --yes-eligible', () => {
    const { plan } = stages({ worker: worker() });
    const ids = plan.stages.map(stage => stage.id);
    expect(ids.slice(ids.indexOf('core:sandbox'), ids.indexOf('core:model') + 1)).toEqual(['core:sandbox', 'execution:runtime', 'execution:worker', 'execution:worker-settings', 'core:model']);
    expect(plan.stages.filter(stage => stage.namespace === 'execution').every(stage => !stage.autoEligible)).toBe(true);
  });

  it('negative: no worker facts (no installation to read) or Docker not ready → both blocked, no operation', () => {
    for (const { image, settings } of [stages({ runtimes: [{ ...docker, daemon: 'unreachable', serverVersion: null }], worker: worker() })]) {
      expect(image.operation).toBeNull(); expect(settings.operation).toBeNull();
      expect([image.state, settings.state]).toEqual(['blocked', 'blocked']);
    }
    expect(stages({ runtimes: [{ ...docker, daemon: 'unreachable', serverVersion: null }], worker: worker() }).image.reason).toEqual({ code: 'setup.execution.workerWaits', params: { stage: 'execution:runtime' } });
    expect(stages({ worker: worker() }, {}, true, null).image.reason).toEqual({ code: 'setup.execution.workerWaits', params: { stage: 'core:policy' } });
  });

  it('initial image selection is a consent-backed onboarding job; init answers cannot start a build or adoption', () => {
    for (const answer of [undefined, true, false, { imageId: OTHER }]) {
      const image = stages({ worker: worker() }, { 'execution:worker': answer }).image;
      expect(image).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerConsentRequired' }, operation: null, question: null });
    }
    expect(stages({ worker: worker({ provider: undefined }) }).image).toMatchObject({ state: 'skipped', reason: { code: 'setup.execution.noWorkKind' } });
    expect(stages({ worker: worker() }, {}, false).image.state).toBe('blocked');
  });

  it('a receipt whose image is present: image done; the settings are composed from the detected paths and written through config.set', () => {
    const { image, settings } = stages({ worker: worker({ receipt: { imageId: IMAGE, imageVersion: 'r4-20260930' }, image: 'present' }) });
    expect(image).toMatchObject({ state: 'done', reason: { code: 'setup.execution.workerBuilt', params: { version: 'r4-20260930', image: 'a'.repeat(12) } } });
    const value = { docker: { executable: '/usr/bin/docker', imageId: IMAGE }, git: { gitExecutable: '/usr/bin/git' } };
    expect(settings).toMatchObject({ state: 'ready', operation: { id: 'config.set', version: 1, input: { scopeId: 'erp-demo', keyPath: 'execution', value, layer: 'project' } },
      cli: ['deckent', 'config', 'set', 'execution', JSON.stringify(value)] });
    expect(isForegroundStage(settings)).toBe(false);
    // A path with a space has no single-token command: the window still applies it, the command line is withheld rather than wrong.
    expect(stages({ runtimes: [{ ...docker, path: '/opt/my docker/docker' }], worker: worker({ receipt: { imageId: IMAGE, imageVersion: 'r4-20260930' }, image: 'present' }) }).settings.cli).toBeNull();
  });

  it('negative: a receipt whose image is gone is asked again; no Git → the settings wait, nothing composed', () => {
    expect(stages({ worker: worker({ receipt: { imageId: IMAGE, imageVersion: 'r4-20260930' }, image: 'missing' }) }).image.state).toBe('blocked');
    expect(stages({ worker: worker({ receipt: { imageId: IMAGE, imageVersion: 'r4-20260930' }, image: 'present', git: null }) }).settings)
      .toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerGitMissing' }, operation: null });
  });

  it('second init: configured and present → both done with no operation; configured but missing → blocked naming the image, never rewritten', () => {
    const ready = stages({ worker: worker({ configured: IMAGE, image: 'present', receipt: { imageId: OTHER, imageVersion: 'r5-20261023' } }) });
    expect([ready.image.state, ready.settings.state, ready.image.operation, ready.settings.operation]).toEqual(['done', 'done', null, null]);
    const missing = stages({ worker: worker({ configured: IMAGE, image: 'missing' }) });
    expect(missing.image).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerMissing', params: { image: 'a'.repeat(12) } }, operation: null });
    expect(missing.settings).toMatchObject({ state: 'blocked', operation: null });
    expect(stages({ worker: worker({ configured: IMAGE, image: 'unknown' }) }).image.reason.code).toBe('setup.execution.workerUnknown');
  });

  it('--image-id: parsed only as an exact image id; answered only where the execution family is observed', () => {
    expect(parseSetupFlags(['init', '--image-id', IMAGE])).toMatchObject({ imageId: IMAGE });
    for (const bad of [['init', '--image-id'], ['init', '--image-id', 'deckent/worker:r4'], ['init', '--image-id', IMAGE, '--image-id', IMAGE]])
      expect(() => parseSetupFlags(bad)).toThrow(expect.objectContaining({ code: 'CLI_USAGE' }));
    expect(unattendedAnswers(observation({ worker: worker() }), { json: false, yes: false, imageId: IMAGE }, false)['execution:worker']).toEqual({ imageId: IMAGE });
    expect(unattendedAnswers(observation(null), { json: false, yes: false, imageId: IMAGE }, false)).not.toHaveProperty('execution:worker');
  });
});

describe('BR1 engine owner: the first image version and the card before anything runs', () => {
  const sources = async () => { const read = await readWorkerImageSources(process.cwd()); return { recipe: read.recipe, dockerfile: read.dockerfile }; };
  it('the packaged recipe as shipped while the daemon holds nothing at or past it; else the next counter past the daemon with a valid history line', async () => {
    const { recipe, dockerfile } = await sources(), packaged = (recipe as { imageVersion: string }).imageVersion, counter = Number(/^r(\d+)-/u.exec(packaged)![1]);
    for (const held of [null, `r${counter - 1}-20200101`]) expect(planFirstWorkerImage({ recipe, dockerfile, held, plannedAt: '2026-10-23T05:00:00.000Z' }))
      .toEqual({ imageVersion: packaged, recipe, dockerfile });
    for (const held of [packaged, 'r27-20261023']) {
      const plan = planFirstWorkerImage({ recipe, dockerfile, held, plannedAt: '2026-10-23T05:00:00.000Z' });
      expect(plan.imageVersion).toBe(`r${Math.max(counter, Number(/^r(\d+)-/u.exec(held)![1])) + 1}-20261023`);
      // The installed builder's own history owner accepts the edited lineage (the same check it runs before a build).
      expect(() => parseVersionHistory(plan.dockerfile, { ...validateRecipe(plan.recipe), imageVersion: plan.imageVersion, previousVersion: packaged })).not.toThrow();
      expect(plan.dockerfile).toContain(`supersedes ${packaged} | first image of this installation (deckent init); counter past daemon-held ${held}`);
    }
    expect(() => planFirstWorkerImage({ recipe: { schemaVersion: 1 }, dockerfile, held: null, plannedAt: '2026-10-23T05:00:00.000Z' })).toThrow(expect.objectContaining({ code: 'WORKER_IMAGE_SOURCE_INVALID' }));
  });

  const ports = (extra: Partial<WorkerImagePorts> = {}) => {
    const calls: string[] = [], cards: WorkerImageCard[] = [], builds: unknown[] = [];
    const value: WorkerImagePorts = { receipt: async () => { calls.push('receipt'); return null; }, sources: async () => { calls.push('sources'); return sources(); },
      held: async () => { calls.push('held'); return 'r27-20261023'; }, confirm: async card => { calls.push('confirm'); cards.push(card); return true; },
      build: async input => { calls.push('build'); builds.push(input); return {}; }, ...extra };
    return { value, calls, cards, builds };
  };
  it('present receipt: nothing asked or built; declined: nothing built; yes: one build of the planned version', async () => {
    const present = ports({ receipt: async () => ({ imageId: IMAGE, imageVersion: 'r4-20260930' }) });
    expect(await new WorkerImageSetupApplication(present.value).prepare()).toBe('present');
    expect(present.calls).toEqual([]);
    const declined = ports({ confirm: async () => false });
    expect(await new WorkerImageSetupApplication(declined.value).prepare()).toBe('declined');
    expect(declined.calls).not.toContain('build');
    const yes = ports();
    expect(await new WorkerImageSetupApplication(yes.value, () => '2026-10-23T05:00:00.000Z').prepare()).toBe('built');
    expect(yes.calls).toEqual(['receipt', 'sources', 'held', 'confirm', 'build']);
    expect(yes.cards).toEqual([{ mode: 'build', imageVersion: 'r28-20261023', held: 'r27-20261023' }]);
    expect(yes.builds).toMatchObject([{ imageVersion: 'r28-20261023' }]);
  });
  it('adopt: the card names the image; the build port gets the builder re-probe (imageId), never a build; no held-version read', async () => {
    const adopt = ports();
    expect(await new WorkerImageSetupApplication(adopt.value).prepare({ imageId: OTHER })).toBe('adopted');
    expect(adopt.calls).toEqual(['sources', 'confirm', 'build']);
    expect(adopt.cards[0]).toMatchObject({ mode: 'adopt', imageId: OTHER });
    expect(adopt.builds[0]).toMatchObject({ imageId: OTHER });
  });
});

describe.skipIf(process.platform !== 'linux')('BR1 adapters: receipts, read-only image presence, the build in the installation home', () => {
  const receipt = (imageId: string, imageVersion: string, measuredAt: string) => JSON.stringify({ schemaVersion: 2, imageId, imageVersion, measuredAt, activation: 'not-activated' });
  it('the newest valid receipt by its own measuredAt; symlinks, oversized, malformed and foreign names are never read as one', async () => {
    const home = await temp('home'), receipts = join(home, 'receipts');
    expect(await readNewestWorkerReceipt(home)).toBeNull();
    await mkdir(receipts, { recursive: true });
    await writeFile(join(receipts, 'r4-20260930.json'), receipt(IMAGE, 'r4-20260930', '2026-10-01T00:00:00.000Z'));
    await writeFile(join(receipts, 'adopted-1761100000000.json'), receipt(OTHER, 'r4-20260930', '2026-10-22T00:00:00.000Z'));
    await writeFile(join(receipts, 'r5-20261001.json'), '{ not json');
    await writeFile(join(receipts, 'notes.json'), receipt(IMAGE, 'r9-20261023', '2026-10-23T00:00:00.000Z'));
    await writeFile(join(receipts, 'r6-20261002.json'), JSON.stringify({ schemaVersion: 2, imageId: IMAGE, imageVersion: 'r6-20261002', measuredAt: '2026-10-23T00:00:00.000Z', pad: 'x'.repeat(1_100_000) }));
    const outside = join(home, 'outside.json');
    await writeFile(outside, receipt(IMAGE, 'r7-20261003', '2026-10-24T00:00:00.000Z')); await symlink(outside, join(receipts, 'r7-20261003.json'));
    expect(await readNewestWorkerReceipt(home)).toEqual({ imageId: OTHER, imageVersion: 'r4-20260930' });
    await writeFile(join(receipts, 'r8-20261024.json'), receipt(IMAGE, 'r8-20261024', '2026-01-01T00:00:00.000Z'));
    const heldRunner: WorkerImageBuildRunner = async command => ({ schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
      stdoutBase64: Buffer.from('{"heldVersion":"r8-20261024"}\n').toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
    expect(await workerImageSetupPorts({ home, executable: 'docker', env: {}, timeoutMs: 1000, outputBytes: 4096, failedContextsKept: 3 }, heldRunner).held()).toBe('r8-20261024');
    // No Docker → the image is not checked; a configured image is the one checked when present.
    expect(await observeWorkerImage({ home, docker: null, configured: null, git: '/usr/bin/git' })).toEqual({ configured: null, receipt: { imageId: OTHER, imageVersion: 'r4-20260930' }, image: 'not-run', git: '/usr/bin/git' });
  });

  /** A fake docker: `image inspect` knows only IMAGE; FAKE_DAEMON=down makes every call fail (exit 1). Logs every argv line. */
  const fakeDocker = async () => {
    const bin = await temp('bin'), log = join(bin, 'argv.log');
    await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> '${log}'
[ "$FAKE_DAEMON" = down ] && exit 1
case "$*" in
  'context inspect --format {{json .Endpoints.docker}}') echo '{"Host":"unix:///fixture.sock"}';;
  *'info --format {{.ID}}') echo 'FIXTURE:DAEMON';;
  *'image inspect ${IMAGE} --format {{.Id}}') echo '${IMAGE}';;
  *'image inspect '*) echo 'Error: No such image' >&2; exit 1;;
  *) exit 64;;
esac
`); await chmod(join(bin, 'docker'), 0o755);
    return { path: join(bin, 'docker'), log };
  };
  it('presence: present, missing (the daemon answers), unknown (it does not); only read verbs ever run', async () => {
    const fake = await fakeDocker();
    expect(await workerImagePresence({ executable: fake.path, imageId: IMAGE })).toBe('present');
    expect(await workerImagePresence({ executable: fake.path, imageId: OTHER })).toBe('missing');
    process.env['FAKE_DAEMON'] = 'down';
    try { expect(await workerImagePresence({ executable: fake.path, imageId: IMAGE })).toBe('unknown'); } finally { delete process.env['FAKE_DAEMON']; }
    const verbs = (await readFile(fake.log, 'utf8')).trim().split('\n').map(line => line.replace(/^--host \S+ /u, '').split(' ')[0]);
    expect([...new Set(verbs)].sort()).toEqual(['context', 'image', 'info']);
    expect(await readFile(fake.log, 'utf8')).not.toMatch(/\b(run|create|start|pull|build|rm)\b/u);
  });

  const evidence = (command: { requestId: string }, code = 0) => ({ schemaVersion: 1 as const, requestId: command.requestId, started: true, reason: 'exit' as const, exitCode: code, signal: null,
    stdoutBase64: '', stderrBase64: code ? Buffer.from('Error: WORKER_IMAGE_COMMAND_FAILED:build\n').toString('base64') : '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });
  it('build in the home: a half-done context is kept as .failed- and the build runs; a failed build keeps its context; adopt passes --image-id', async () => {
    const home = await temp('toolchains'); await chmod(home, 0o700);
    const { recipe, dockerfile } = await readWorkerImageSources(process.cwd()), version = (recipe as { imageVersion: string }).imageVersion;
    const seen: string[][] = [];
    const ok: WorkerImageBuildRunner = async command => { seen.push([...command.args]); await writeFile(command.args[1]!, receipt(IMAGE, version, '2026-10-23T05:00:00.000Z')); return evidence(command) as never; };
    const base = { packageRoot: process.cwd(), home, imageVersion: version, recipe, dockerfile, timeoutMs: 1000, outputBytes: 4096, failedContextsKept: 3, replace: true, resolution: { selected: ['codex'], resolved: { codex: { kind: 'npm' as const, package: '@openai/codex', version: '0.156.0' } } } };
    await mkdir(join(home, 'builds', version), { recursive: true, mode: 0o700 }); // a half-done earlier attempt, no receipt
    const built = await buildWorkerImageInHome(base, ok);
    expect(built.receiptPath).toBe(join(home, 'receipts', `${version}.json`));
    expect((await readdir(join(home, 'builds'))).filter(name => name.startsWith(`${version}.failed-`))).toHaveLength(1);
    expect(seen[0]).toEqual([join(home, 'builds', version, 'build.mjs'), built.receiptPath]);
    expect(await readNewestWorkerReceipt(home)).toEqual({ imageId: IMAGE, imageVersion: version });
    await utimes(built.receiptPath, new Date('2026-10-20'), new Date('2026-10-20'));
    const failing: WorkerImageBuildRunner = async command => evidence(command, 1) as never;
    await expect(buildWorkerImageInHome({ ...base, imageVersion: 'r99-20261023' }, failing)).rejects.toMatchObject({ code: 'WORKER_IMAGE_COMMAND_FAILED' });
    expect((await readdir(join(home, 'builds'))).some(name => name.startsWith('r99-20261023.failed-'))).toBe(true);
    const adopted = await buildWorkerImageInHome({ ...base, imageId: OTHER }, ok);
    expect(adopted.receiptPath).toMatch(/receipts\/adopted-\d+\.json$/u);
    expect(seen.at(-1)).toEqual([join(home, 'adopted', version, 'build.mjs'), adopted.receiptPath, '--image-id', OTHER]);
  });
});

describe('BR1 doctor and the first-job list: one step, deckent init; the configured image checked read-only', () => {
  it('first-job: no hand JSON and no source-checkout command; execution → registry → pool', () => {
    const steps = firstJobSteps({ execution: false, registry: false, pool: false }, 'erp-demo');
    expect(steps.map(step => step.id)).toEqual(['execution', 'registry', 'pool']);
    expect(firstJobCommand(steps[0]!)).toBe('deckent init');
    expect(steps.map(firstJobCommand).join('\n')).not.toMatch(/npm run|worker:image|config set execution/u);
  });
  const report = { platform: 'linux', host: { cpuCores: 4, totalMemMB: 8192, recommendedMaxWorkers: 3 }, company: { companyId: 'default' }, principal: { id: 'me' },
    secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null };
  const row = (extra: Partial<DoctorCheckFacts>, id = 'work.workerImage') => doctorChecks(report, { scopeId: 'erp-demo', toolchainsRequested: false, identityProfile: null,
    backupPassphraseStored: null, retiringModels: [], poolStatus: 'unconfigured', toolchainUpdateEnabled: false, imageId: IMAGE, ...extra }, 'en').find(check => check.id === id);
  it('present ok · missing error with next deckent init · unknown not tested · not checked no row; the pool row names deckent init first', () => {
    expect(row({ workerImage: 'present' })).toMatchObject({ state: 'ok', text: `Worker image sha256:${'a'.repeat(12)} is on this Docker` });
    expect(row({ workerImage: 'missing' })).toMatchObject({ state: 'error', next: 'deckent init' });
    expect(row({ workerImage: 'unknown' })?.state).toBe('untested');
    expect(row({ workerImage: null })).toBeUndefined();
    expect(row({ firstJob: { execution: false, registry: false } }, 'work.pool')?.next).toMatch(/: deckent init$/u);
  });
});

describe('BR1 foreground: the window closes for the worker image; the composed owner refuses off a terminal before anything', () => {
  const stage = (input: Record<string, string>) => ({ id: 'execution:worker', namespace: 'execution', title: 'setup.execution.workerTitle', state: 'ready' as const,
    reason: { code: 'setup.execution.workerBuildChosen', params: {} }, operation: { id: 'execution.worker-image', version: 1, input }, question: null, default: null, cli: null, autoEligible: false });
  it('the stage reaches the composed owner with the adopt image; a declined card is a refusal, never applied', async () => {
    const calls: unknown[] = [];
    const context = (status: string) => ({ env: {}, prepareWorkerImage: async (_root: string, _io: unknown, request: unknown) => { calls.push(request); return status; } }) as unknown as SetupCommandContext;
    expect(await runForegroundStage(context('adopted'), '/x', stage({ scopeId: 'erp-demo', imageId: OTHER }), 'erp-demo', 'en')).toMatchObject({ status: 'applied' });
    expect(await runForegroundStage(context('declined'), '/x', stage({ scopeId: 'erp-demo' }), 'erp-demo', 'en')).toMatchObject({ status: 'refused', code: 'SETUP_STAGE_DECLINED' });
    expect(calls).toEqual([{ imageId: OTHER }, {}]);
  });
  it('negative: no terminal (a pipe, an agent) → TERMINAL_TTY_REQUIRED; nothing is read, built or written in the folder', async () => {
    const root = await temp('root'), setup = configuredSetup({});
    await expect(setup.prepareWorkerImage(root, { locale: 'en', env: { PATH: '/nonexistent' }, stdin: { isTTY: false } as never, stdout: { isTTY: false, write: () => true } }))
      .rejects.toMatchObject({ code: 'TERMINAL_TTY_REQUIRED' });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('BR1 1b: the first work kind and the pool as setup stages (no all-flags command for a person)', () => {
  const plan = (work: Record<string, unknown> | null, values: Record<string, unknown> = {}, execution: Partial<ExecutionFacts> | null = null) => {
    const observed = observation(execution), families = { ...observed.families, ...(work ? { work } : {}) };
    const packages = [WORK_SETUP_FAMILY, ...(execution ? [executionSetupFamily({ person: true })] : [])];
    const result = planSetup({ ...observed, families }, { schemaVersion: 1, values }, new SetupStageRegistry(packages));
    return { result, kind: result.stages.find(stage => stage.id === 'work:kind')!, pool: result.stages.find(stage => stage.id === 'work:pool')! };
  };
  it('waits for the execution settings (the family stage when observed, else configuration); then asks which CLI, choices from the native CLI registry', () => {
    expect(plan(null).kind).toMatchObject({ state: 'blocked', reason: { code: 'setup.work.unavailable' } });
    expect(plan({ execution: false, registry: false, pool: false }).kind).toMatchObject({ state: 'needs-answer', operation: null });
    expect(plan({ execution: true, registry: false, pool: false }, {}, { worker: worker() }).kind).toMatchObject({ state: 'needs-answer', operation: null }); // image not built yet
    const asked = plan({ execution: true, registry: false, pool: false }).kind;
    expect(asked).toMatchObject({ state: 'needs-answer', question: { key: 'setup.work.kindQuestion' }, operation: null });
    expect(asked.cli?.join(' ')).toBe(`deckent init registry --scope erp-demo --provider <${nativeCliIds.join('|')}> --kind coding --pool workers --execution-slots 1 --in-flight-slots 1 --preview`);
    expect(stageChoices(asked, observation(null), 'en').map(choice => choice.id)).toEqual([...nativeCliIds, 'later']);
  });
  it('a chosen CLI → the registry owner as a foreground stage with the registry defaults; then the pool; both never --yes-eligible', () => {
    const chosen = plan({ execution: true, registry: false, pool: false, images: { [nativeCliIds[0]!]: IMAGE } }, { 'work:kind': nativeCliIds[0] }).kind;
    expect(chosen).toMatchObject({ state: 'ready', autoEligible: false, operation: { id: 'work.registry', input: { scopeId: 'erp-demo', provider: nativeCliIds[0], image: IMAGE, kind: 'coding', poolId: 'workers',
      executionSlots: 1, inFlightSlots: 1 } } });
    expect(isForegroundStage(chosen)).toBe(true);
    expect(() => plan({ execution: true, registry: false, pool: false }, { 'work:kind': 'not-a-cli' })).not.toThrow();
    expect(plan({ execution: true, registry: false, pool: false }, { 'work:kind': 'not-a-cli' }).kind.state).toBe('needs-answer');
    const pool = plan({ execution: true, registry: true, pool: false });
    expect(pool.kind.state).toBe('done');
    expect(pool.pool).toMatchObject({ state: 'ready', autoEligible: false, operation: { id: 'work.pool', input: { scopeId: 'erp-demo' } }, cli: ['deckent', 'init', 'pool', '--scope', 'erp-demo', '--preview'] });
    expect(isForegroundStage(pool.pool)).toBe(true);
    expect(plan({ execution: true, registry: true, pool: true }).pool).toMatchObject({ state: 'done', operation: null });
  });
  const stage = (operation: string, input: Record<string, unknown>) => ({ id: operation === 'work.pool' ? 'work:pool' : 'work:kind', namespace: 'work', title: 'setup.work.kindTitle',
    state: 'ready' as const, reason: { code: 'setup.work.kindChosen', params: {} }, operation: { id: operation, version: 1, input: input as never }, question: null, default: null, cli: null, autoEligible: false });
  it('foreground: an equal registry or pool already there is applied without a card; a refusal keeps the owner\'s typed code; nothing is retried', async () => {
    const calls: unknown[] = [];
    const context = { env: {}, initializeNativeCodingRegistry: async (_root: string, input: unknown) => { calls.push(input); return { status: 'current' }; },
      installConfiguredExecutionPool: async (_root: string, _scope: string, apply: boolean) => { calls.push(apply); return { status: 'conflict', configured: null }; } } as unknown as SetupCommandContext;
    const input = { scopeId: 'erp-demo', provider: nativeCliIds[0], kind: 'coding', poolId: 'workers', executionSlots: 1, inFlightSlots: 1 };
    expect(await runForegroundStage(context, '/x', stage('work.registry', input), 'erp-demo', 'en')).toMatchObject({ status: 'applied' });
    expect(calls[0]).toEqual({ schemaVersion: 1, scopeId: 'erp-demo', provider: nativeCliIds[0], kind: 'coding', poolId: 'workers', executionSlots: 1, inFlightSlots: 1, apply: false });
    expect(await runForegroundStage(context, '/x', stage('work.pool', { scopeId: 'erp-demo' }), 'erp-demo', 'en')).toMatchObject({ status: 'refused', code: 'POOL_CONFLICT' });
    const failing = { env: {}, initializeNativeCodingRegistry: async () => { throw Object.assign(new Error('x'), { code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' }); } } as unknown as SetupCommandContext;
    expect(await runForegroundStage(failing, '/x', stage('work.registry', input), 'erp-demo', 'en')).toMatchObject({ status: 'refused', code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
    expect(calls).toHaveLength(2);
  });
  it('negative: the composed apply port (pipe, --yes, the window itself) refuses every terminal-taking BR1 stage before anything runs', async () => {
    const root = await temp('apply'), setup = configuredSetup({});
    for (const [operation, input] of [['work.registry', { scopeId: 'erp-demo' }], ['work.pool', { scopeId: 'erp-demo' }], ['execution.worker-image', { scopeId: 'erp-demo' }]] as const)
      expect(await setup.applySetupStage(root, stage(operation, input), { env: {} })).toMatchObject({ status: 'refused', code: 'TERMINAL_TTY_REQUIRED' });
    expect(await readdir(root)).toEqual([]);
  });
});
