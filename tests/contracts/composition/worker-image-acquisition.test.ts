import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireConfiguredWorkerImage, inspectConfiguredWorkerImage, startWorkerImageAcquisition } from '#composition/core/toolchains/index.js';
import { workerConsentBinding, matchingWorkerConsent, workerImageBudget, workerSetupStages, type WorkerImageState } from '#engine/index.js';
import { readWorkerImageSources, withWorkerBuilder, type WorkerImageBuildRunner } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const evidence = (requestId: string, value: unknown) => ({ schemaVersion: 1 as const, requestId, started: true, reason: 'exit' as const, exitCode: 0, signal: null,
  stdoutBase64: Buffer.from(JSON.stringify(value) + '\n').toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });

it('S3 consent/marker/crash/ready facts and daemon-global reservation/takeover survive restart without model or proposal effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-acquisition-')); roots.push(root);
  const options = { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env.PATH ?? '/usr/bin' } };
  const configDir = join(root, '.deckent'); await mkdir(configDir);
  const configFile = join(configDir, 'config.json'), home = join(configDir, 'workspaces/toolchains'); await mkdir(home, { recursive: true });
  const source = await readWorkerImageSources(process.cwd());
  const binding = workerConsentBinding({ recipe: source.recipe, providers: ['codex'], npmRegistry: 'https://mirror.invalid:8443/npm/prefix', sources: {} });
  const consent = { operation: 'worker-image.consent@1' as const, id: 'consent-1', person: { id: 'person', issuer: 'local-os', subject: 'person' }, scopeId: 'scope', ...binding, createdAt: new Date().toISOString() };
  const writeConfig = async (records: unknown[]) => { await writeFile(configFile, JSON.stringify({ schema_version: 4, toolchains: { currency: { registryEndpoint: binding.sources[0] }, image: { consents: records }, update: { buildTimeoutMs: 20000 } } })); clearConfigCache(); };
  let calls = 0;
  const runner: WorkerImageBuildRunner = async command => {
    calls++;
    if (command.args[0]!.endsWith('/recover.mjs')) { expect(command.args[2]).toBe('daemon'); return evidence(command.requestId, {}); }
    if (command.args[1] === '--daemon-identity') return evidence(command.requestId, { daemonId: 'daemon', endpoint: 'unix:///fixture' });
    if (command.args[1] === '--held-version') return evidence(command.requestId, { heldVersion: 'r31-20261024' });
    const plan = JSON.parse(await readFile(join(command.cwd, 'plan.json'), 'utf8')) as { imageVersion: string; totalBudgetMs: number; reservation: { daemonId: string } };
    expect(plan.totalBudgetMs).toBe(100000); // 20s base + 20s provider + 60s cleanup/marker grace
    expect(plan.reservation.daemonId).toBe('daemon');
    const receipt = { schemaVersion: 3, daemonId: 'daemon', imageVersion: plan.imageVersion, imageId: `sha256:${'a'.repeat(64)}`, recipeSha256: binding.recipeDigest,
      measuredAt: new Date().toISOString(), images: [{ providers: ['codex'], imageId: `sha256:${'a'.repeat(64)}`, tag: `deckent/worker:${plan.imageVersion.split('-')[0]}-codex` }] };
    await writeFile(command.args[1]!, JSON.stringify(receipt)); return evidence(command.requestId, {});
  };
  const dependencies = { runner, instanceId: 'instance-1', fetcher: async () => ({ version: '0.156.0', source: 'fixture', observedAt: new Date().toISOString() }) };
  await writeConfig([]);
  expect(await acquireConfiguredWorkerImage(root, options, dependencies)).toBeNull(); expect(calls).toBe(0);
  const marker: WorkerImageState = { schemaVersion: 1, revision: 1, instanceId: 'instance-1', consentId: 'forged', phase: 'requested', step: null,
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 100000).toISOString(), lastProgressAt: new Date().toISOString(), daemonId: null, images: [], code: null, context: null };
  await writeFile(join(home, 'worker-image-state.json'), JSON.stringify(marker));
  await expect(acquireConfiguredWorkerImage(root, options, dependencies)).rejects.toMatchObject({ code: 'WORKER_IMAGE_CONSENT_MISSING' }); expect(calls).toBe(0);
  await rm(join(home, 'worker-image-state.json')); await writeConfig([consent]);
  expect(() => matchingWorkerConsent([consent], { ...binding, sources: ['https://mirror.invalid:8443/another'] })).toThrow(expect.objectContaining({ code: 'WORKER_IMAGE_CONSENT_MISSING' }));
  const ready = await acquireConfiguredWorkerImage(root, options, dependencies);
  expect(ready?.code).toBeNull();
  expect(ready).toMatchObject({ phase: 'ready', daemonId: 'daemon', images: [{ provider: 'codex', tagVersion: expect.stringMatching(/^r\d+-codex$/u) }] });
  const before = calls; expect(await acquireConfiguredWorkerImage(root, options, { ...dependencies, instanceId: 'instance-2' })).toEqual(ready); expect(calls).toBe(before);
  expect(await inspectConfiguredWorkerImage(root, options)).toEqual(ready);
  await writeFile(join(ready!.context!, 'probe-0.cid'), 'a'.repeat(64));
  const stale = { ...ready!, phase: 'acquiring' };
  await writeFile(join(home, 'worker-image-state.json'), JSON.stringify(stale));
  expect(await acquireConfiguredWorkerImage(root, options, { ...dependencies, instanceId: 'instance-2' })).toMatchObject({ phase: 'failed', code: 'WORKER_IMAGE_BUILD_INTERRUPTED' }); expect(calls).toBe(before + 1);
  expect((await readdir(join(home, 'builds'))).some(name => name.includes('.failed-'))).toBe(true);
  const controller = new AbortController();
  const handle = startWorkerImageAcquisition(root, options, controller.signal, { ...dependencies, instanceId: 'instance-3' });
  try {
    await writeConfig([consent, { ...consent, id: 'consent-2' }]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await inspectConfiguredWorkerImage(root, options))?.consentId === 'consent-2' && (await inspectConfiguredWorkerImage(root, options))?.phase === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await inspectConfiguredWorkerImage(root, options)).toMatchObject({ phase: 'ready', consentId: 'consent-2' });
  } finally { controller.abort(); await handle.done; }
  expect(workerImageBudget(20000, 2)).toBe(120000);
  const stages = workerSetupStages({ person: true, sizeGigabytes: 1 });
  const context = { facts: { runtimes: [], worker: { configured: null, receipt: null, image: 'not-run', git: null } }, answer: undefined, scopeId: 'scope', states: new Map() };
  expect(stages[0]!.evaluate(context)).toMatchObject({ state: 'skipped', reason: { code: 'setup.execution.noWorkKind' } });
  expect(stages[0]!.evaluate({ ...context, states: new Map([['work:kind', 'done']]) }).state).toBe('blocked'); // upgraded registry still requires repair
  const repair = { ...context, facts: { runtimes: [], worker: { configured: `sha256:${'b'.repeat(64)}`, receipt: null, image: 'missing', git: null, provider: 'codex', acquisition: ready } },
    states: new Map([['work:kind', 'done'], ['execution:runtime', 'done'], ['execution:worker', 'done'], ['core:policy', 'done']] as const) };
  expect(stages[1]!.evaluate(repair)).toMatchObject({ state: 'ready', operation: { input: { keyPath: 'execution.docker.imageId', value: `sha256:${'a'.repeat(64)}` } } });
  expect(stages[1]!.evaluate({ ...repair, facts: { ...repair.facts, worker: { ...repair.facts.worker, image: 'unknown' } } })).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerUnknown' } });
  const custodyRoot = join(root, 'shared-builders'), audit: unknown[] = [], reservations: string[] = []; let active = 0, peak = 0;
  const use = (instanceId: string) => withWorkerBuilder({ root: custodyRoot, packageRoot: process.cwd(), daemonId: 'shared', instanceId, budgetMs: 5000, audit: async event => { audit.push(event); } }, async custody => {
    active++; peak = Math.max(peak, active); reservations.push((await custody.reserve(40, '2026-10-26T00:00:00.000Z')).version);
    await new Promise(resolve => setTimeout(resolve, 30)); active--;
  });
  await Promise.all([use('installation-a'), use('installation-b')]); expect(peak).toBe(1); expect(reservations).toEqual(['r41-20261026', 'r42-20261026']);
  const directory = join(custodyRoot, createHash('sha256').update('shared').digest('hex'));
  await writeFile(join(directory, 'builder-owner.json'), JSON.stringify({ instanceId: 'dead-instance', pid: process.pid, expiresAt: '2000-01-01T00:00:00.000Z' }));
  await use('installation-c'); expect(reservations.at(-1)).toBe('r43-20261026'); expect(audit).toContainEqual(expect.objectContaining({ event: 'lockTakenOver', from: 'dead-instance' }));
  expect((await readdir(home)).some(name => /proposal|registry|pool/u.test(name))).toBe(false);
});

it('U6-S5: Docker appears without a config change: the service resumes the same consent once, while failed/adoption consent cannot authorize a build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-docker-wait-')); roots.push(root);
  const options = { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env.PATH ?? '/usr/bin' } };
  const configDir = join(root, '.deckent'), home = join(configDir, 'workspaces/toolchains'); await mkdir(home, { recursive: true });
  const source = await readWorkerImageSources(process.cwd());
  const binding = workerConsentBinding({ recipe: source.recipe, providers: ['codex'], npmRegistry: 'https://mirror.invalid/npm', sources: {} });
  const consent = { operation: 'worker-image.consent@1' as const, id: 'wait-consent', person: { id: 'person', issuer: 'local-os', subject: 'person' }, scopeId: 'scope', ...binding, createdAt: new Date().toISOString() };
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ schema_version: 4, toolchains: { currency: { registryEndpoint: binding.sources[0] }, image: { consents: [consent] }, update: { buildTimeoutMs: 20000 } } }));
  const bytes = await readFile(join(configDir, 'config.json'), 'utf8'); let reachable = false, builds = 0, probes = 0;
  const runner: WorkerImageBuildRunner = async command => {
    if (command.args[1] === '--daemon-identity') { probes++; return reachable ? evidence(command.requestId, { daemonId: 'daemon', endpoint: 'unix:///fixture' }) : { ...evidence(command.requestId, {}), exitCode: 1 }; }
    if (command.args[1] === '--held-version') return evidence(command.requestId, { heldVersion: null });
    builds++;
    const plan = JSON.parse(await readFile(join(command.cwd, 'plan.json'), 'utf8'));
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 3, daemonId: 'daemon', imageVersion: plan.imageVersion, imageId: `sha256:${'a'.repeat(64)}`, recipeSha256: binding.recipeDigest,
      measuredAt: new Date().toISOString(), images: [{ providers: ['codex'], imageId: `sha256:${'a'.repeat(64)}`, tag: 'deckent/worker:r32-codex' }] }));
    return evidence(command.requestId, {});
  };
  const dependencies = { runner, instanceId: 'instance', fetcher: async () => ({ version: '0.156.0', source: 'fixture', observedAt: new Date().toISOString() }) };
  const waiting = await acquireConfiguredWorkerImage(root, options, dependencies);
  expect(waiting).toMatchObject({ phase: 'waiting-docker', code: 'WORKER_IMAGE_DOCKER_WAITING', consentId: 'wait-consent' }); expect(builds).toBe(0);
  const controller = new AbortController(), handle = startWorkerImageAcquisition(root, options, controller.signal, dependencies);
  try {
    const deadline = Date.now() + 8000;
    while (probes < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(probes).toBe(2); reachable = true; // No config event: only the service tick can observe this change.
    while ((await inspectConfiguredWorkerImage(root, options))?.phase !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await inspectConfiguredWorkerImage(root, options)).toMatchObject({ phase: 'ready', consentId: 'wait-consent' });
    await Promise.all([acquireConfiguredWorkerImage(root, options, dependencies), acquireConfiguredWorkerImage(root, options, dependencies)]);
    expect(builds).toBe(1); expect(await readFile(join(configDir, 'config.json'), 'utf8')).toBe(bytes);
    expect(() => matchingWorkerConsent([{ ...consent, imageId: `sha256:${'b'.repeat(64)}` }], binding)).toThrow(expect.objectContaining({ code: 'WORKER_IMAGE_CONSENT_MISSING' }));
    expect(matchingWorkerConsent([{ ...consent, imageId: `sha256:${'b'.repeat(64)}` }], binding, `sha256:${'b'.repeat(64)}`)).toMatchObject({ id: consent.id });
  } finally { controller.abort(); await handle.done; }
}, 15000);

it('U6-S4 adoption is consent-bound, rechecks lineage and publishes only the selected provider without applying runtime settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-adoption-')); roots.push(root);
  const options = { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env.PATH ?? '/usr/bin' } };
  const configDir = join(root, '.deckent'); await mkdir(configDir);
  const source = await readWorkerImageSources(process.cwd()), imageId = `sha256:${'a'.repeat(64)}`;
  const binding = workerConsentBinding({ recipe: source.recipe, providers: ['codex'], npmRegistry: 'https://mirror.invalid/npm', sources: {} });
  const consent = { operation: 'worker-image.consent@1', id: 'adopt-1', imageId, person: { id: 'person', issuer: 'local-os', subject: 'person' }, scopeId: 'scope', ...binding, createdAt: new Date().toISOString() };
  const configFile = join(configDir, 'config.json');
  const configure = async (id: string) => { await writeFile(configFile, JSON.stringify({ schema_version: 4, toolchains: { currency: { registryEndpoint: binding.sources[0] }, image: { consents: [{ ...consent, id }] } } })); clearConfigCache(); };
  let provenance = 'adopted-lineage-unknown', adopted = 0;
  const runner: WorkerImageBuildRunner = async command => {
    if (command.args[1] === '--daemon-identity') return evidence(command.requestId, { daemonId: 'daemon', endpoint: 'unix:///fixture' });
    if (command.args[1] === '--held-version') return evidence(command.requestId, { heldVersion: null });
    adopted++; expect(command.args).toContain('--image-id'); expect(command.args.at(-1)).toBe(imageId);
    expect(JSON.parse(await readFile(join(command.cwd, 'plan.json'), 'utf8'))).toMatchObject({ adopt: true });
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 3, daemonId: 'daemon', imageVersion: 'r31-20261024', imageId, recipeSha256: binding.recipeDigest, provenance,
      measuredAt: new Date().toISOString(), images: [{ providers: ['codex', 'claude'], imageId, tag: null }] }));
    return evidence(command.requestId, {});
  };
  const dependencies = { runner, instanceId: 'instance', fetcher: async () => { throw new Error('Adoption cannot resolve or download a version'); } };
  await configure('adopt-1');
  expect(await acquireConfiguredWorkerImage(root, options, dependencies)).toMatchObject({ phase: 'failed', code: 'WORKER_LABEL_MISMATCH', images: [] });
  await acquireConfiguredWorkerImage(root, options, dependencies); expect(adopted).toBe(1); // No blind retry of rejected lineage.
  provenance = 'adopted-label-matched'; await configure('adopt-2'); const bytes = await readFile(configFile, 'utf8');
  expect(await acquireConfiguredWorkerImage(root, options, dependencies)).toMatchObject({ phase: 'ready', images: [{ provider: 'codex', imageId, tagVersion: 'r31-codex' }] });
  expect((await inspectConfiguredWorkerImage(root, options))?.images).toHaveLength(1); expect(adopted).toBe(2);
  expect(await readFile(configFile, 'utf8')).toBe(bytes);
});
