import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import { createRecordedCancellationDelivery } from '#composition/core/runs/index.js';
import { recordedExecutionSupervisor } from '#composition/core/supervisors/index.js';
import { BeuserRealmApplication } from '#engine/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { admitConfiguredBeuserWalk, readConfiguredBeuserReport, validateBeuserSupervisorProfile } from '#composition/core/beuser/index.js';
import { reserveConfiguredRunTasks, inspectConfiguredPoolCapacity } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { measureInstalledPackage, beuserPrivateRecord } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY, beuserEvaluatorFor, createBeuserReport } from '#engine/index.js';
import { sha256, clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { ModelActivationApplication, ModelBindingApplication } from '#engine/index.js';
import { encodeModelBindingDefinition, executionProfileDefinitionSchema } from '#domain/index.js';
import { setupConfiguredBeuser } from '#composition/core/beuser/index.js';
import { responsesFixture } from '../support/openai-responses.js';
import { runInTerminal, lastJson } from '../support/terminal-cli.js';

it.skipIf(process.platform !== 'linux')('witnessed CLI setup admits the exact Attempt and persistent cancellation reopens only its BeUser realm owner', async () => {
  // Owner S9: the installation lives where the one-command walk keeps its private controller, `<global state root>/beuser-controller`.
  const base = await mkdtemp(join(tmpdir(), 'beuser-admission-')), root = join(base, 'global', 'beuser-controller'), candidate = join(base, 'candidate');
  try {
    await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(candidate); await mkdir(join(candidate, 'dist'));
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'test-candidate', version: '1.0.0', files: ['dist'] }));
    await writeFile(join(candidate, 'dist', 'entry.js'), 'export {};\n');
    const options = { env: { HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global') } };
    await applyPolicyTemplateInstallation(root, 'scope', options);
    await expect(admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'journey', candidate }, options)).rejects.toMatchObject({ code: 'BEUSER_PROFILE_REQUIRED' });
    await expect(readConfiguredBeuserReport(root, 'scope', undefined, options)).rejects.toMatchObject({ code: 'BEUSER_REPORT_NOT_FOUND' });
    const storage = await openConfiguredAttemptStore(root, options);
    const max = { maxFiles: 100, maxFileBytes: 100000, maxTotalBytes: 1000000, maxDepth: 10 };
    const source = { sourceCommit: '1'.repeat(40), sourceTreeSha256: '2'.repeat(64) };
    await writeFile(join(candidate, 'dist/build-identity.json'), JSON.stringify(source));
    const inventory = await measureInstalledPackage(candidate, max);
    const manifest = JSON.stringify(Object.fromEntries(inventory.files.map(file => [file.path, `${file.sha256}:${file.mode.toString(8)}`])));
    await writeFile(join(candidate, 'manifest.json'), manifest);
    await writeFile(join(candidate, 'release.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '1.0.0', ...source, manifestSha256: sha256(manifest) }));
    const measured = await measureInstalledPackage(candidate, max), files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    const summary = { schemaVersion: 1, personaId: 'person', journeyId: 'journey', language: 'tr', role: 'buyer', goals: ['purchase'],
      knowledgeBoundary: [], accessibility: [], initialKnowledge: [], goal: 'request goods', competency: { computer: 1, domain: 4, product: 0 },
      preferences: [], riskAttitude: 'cautious', surface: 'terminal', organizationContext: {}, patience: { maxSteps: 4, maxWaitMs: 100 }, attentionMs: 1000 };
    const calibration = { revision: 'r', cohort: 'cohort', trapHits: 0, trapTotal: 0, falseRed: 0, goodTotal: 0, minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 };
    const binding = { schemaVersion: 1, identity: { scopeId: 'untrusted', runId: 'untrusted', taskId: 'untrusted', attemptId: 'untrusted', layoutRevision: 'untrusted', generation: 1 },
      candidate: { adapter: 'installed-package', version: '1.0.0', evidenceRef: 'package', stateDigest: sha256(JSON.stringify(files)), environmentDigest: 'b'.repeat(64) },
      candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64), realmId: 'untrusted', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'untrusted' };
    const parameters = { schemaVersion: 2, binding, summary, limitsRevision: BEUSER_LIMITS_REGISTRY.profiles[0]!.revision, candidateRoot: candidate, packageDigest: measured.measurementDigest,
      candidateManifest: { sha256: sha256(manifest), fileCount: files.length, ...source, version: '1.0.0' }, size: { columns: 80, rows: 24, scrollback: 100 }, bounds: { quietMs: 10, inactivityMs: 100, maxInputBytes: 1024 }, completionTokens: 1024,
      rubric: { schemaVersion: 1, journeyId: 'journey', version: 1, digest: 'f'.repeat(64), parameters: {} },
      choices: { 'beuser-walker': { channelId: 'configured', modelId: 'walker' }, 'beuser-evaluator': { channelId: 'configured', modelId: 'evaluator' } },
      contributorModels: [{ vendorId: 'source-maker' }], entry: { mode: 'pty', nodeExecutable: adapters.BEUSER_REALM_RECIPE.nodeExecutable, args: ['--help'] },
      probes: [{ id: 'installation', dimension: 'outcome', readbackRef: 'readback', key: 'installation', expected: 'installed' }], calibration };
    const inline = { ...parameters, schemaVersion: 1, files: Array.from({ length: 4114 }, () => files[0]!) };
    const definitionInput = { id: 'persona', version: 1, adapter: { id: 'beuser', version: 1 }, parameters };
    expect(executionProfileDefinitionSchema.safeParse(definitionInput).success).toBe(true);
    const oversized = executionProfileDefinitionSchema.safeParse({ ...definitionInput, parameters: inline });
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.issues).toContainEqual(expect.objectContaining({ message: 'JSON_VALUE_INVALID', path: ['parameters'] }));
    expect(() => validateBeuserSupervisorProfile({ schemaVersion: 1, adapterId: 'beuser', adapterVersion: 1, parameters: inline })).toThrow('BEUSER_INPUT_INVALID');
    expect(() => validateBeuserSupervisorProfile({ schemaVersion: 1, adapterId: 'beuser', adapterVersion: 1,
      parameters: { ...parameters, entry: { ...parameters.entry, mode: 'argv', args: [] } } })).toThrow('BEUSER_INPUT_INVALID');
    const configPath = join(root, '.deckent', 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    const admission = { poolId: 'pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'beuser-fixture',
      profiles: [{ id: 'persona', version: 1, adapter: { id: 'beuser', version: 1 }, parameters }], kinds: [{ kind: 'journey', profile: { id: 'persona', version: 1 }, workspaceDelivery: 'none' }],
      evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } };
    storage.store.close();
    const profilePath = join(base, 'profile.json');
    await writeFile(profilePath, JSON.stringify(admission));
    const cli = join(process.cwd(), 'dist/composition/core/cli/internal/entry.js');
    const argv = [process.execPath, cli, 'beuser', 'setup', '--profile', profilePath, '--scope', 'scope', '--lang', 'en', '--json', '--apply'];
    const env = { ...options.env, DECKENT_GLOBAL_HOME: join(base, 'global'), TERM: 'xterm-256color', PATH: process.env.PATH };
    const missingProfile = await runInTerminal([process.execPath, cli, 'beuser', 'walk', '--journey', 'journey', '--candidate', candidate, '--scope', 'scope', '--json', '--lang', 'tr'], root, env);
    expect(missingProfile.code).toBe(1); expect(missingProfile.output).toContain('BEUSER_PROFILE_REQUIRED'); expect(missingProfile.output).toContain('deckent beuser setup');
    const refused = await runInTerminal(argv, root, env);
    expect(refused.code).toBe(1); expect(refused.output).toContain('BEUSER_MODEL_UNAVAILABLE'); expect(refused.output).toContain('models roles');
    await expect(adapters.withMcpPrincipal(() => setupConfiguredBeuser(root, { scopeId: 'scope', profile: profilePath, apply: false }, options)))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const ai = await runInTerminal(argv, root, { ...env, CLAUDECODE: '1' });
    expect(ai.code).toBe(1); expect(ai.output).toContain('AUTHORITY_WITNESS_REQUIRED');
    expect(JSON.parse(await readFile(configPath, 'utf8')).admission).toBeUndefined();
    // One command from an unrelated folder: without a connected model it names the controller's next step and stages nothing; a bad journey id is typed.
    const elsewhere = join(base, 'elsewhere'), card = '↑↓ choose · Enter confirm · Esc cancel';
    await mkdir(elsewhere); config.terminal = { scopeId: 'scope' }; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const oneCommand = (journey: string, extra: readonly string[], answers: { when: string; send: string }[] = []) =>
      runInTerminal([process.execPath, cli, 'beuser', 'walk', '--journey', journey, ...extra, '--lang', 'en'], elsewhere, env, answers);
    const noModel = await oneCommand('onboarding', ['--candidate', candidate]), badJourney = await oneCommand('no-such-journey', ['--candidate', candidate]);
    expect(noModel.code).toBe(1); expect(noModel.output).toContain('BEUSER_MODEL_UNAVAILABLE'); expect(noModel.output).toContain(`cd ${root} && deckent, then /provider`);
    expect(badJourney.code).toBe(1); expect(badJourney.output).toContain('BEUSER_INPUT_INVALID');
    expect(JSON.parse(await readFile(configPath, 'utf8')).admission).toBeUndefined(); expect(await readdir(elsewhere)).toEqual([]);
    const freshGlobal = join(base, 'fresh-global'), freshRoot = join(freshGlobal, 'beuser-controller'), freshEnv = { ...env, DECKENT_GLOBAL_HOME: freshGlobal };
    const freshBefore = await stat(freshRoot).then(() => true, () => false); expect(freshBefore).toBe(false);
    const freshController = await runInTerminal([process.execPath, cli, 'beuser', 'walk', '--journey', 'onboarding', '--lang', 'en'], elsewhere, freshEnv);
    expect(freshController.code).toBe(1); expect(freshController.output).toContain(`cd ${freshRoot} && deckent`);
    expect((await stat(freshRoot)).mode & 0o777).toBe(0o700); expect(await readdir(freshRoot)).toEqual([]);
    const f = responsesFixture('http://127.0.0.1:1/v1/responses'), reference = { ...f.profile.reference, providerId: 'fixture-channel', modelId: 'fixture-model' };
    const modelDefinition = { ...f.definition, provider: { id: reference.providerId, version: 1 }, model: { ...f.definition.model, id: reference.modelId, nativeId: reference.modelId } };
    const catalog = { schemaVersion: 1, revision: 'fixture', providers: [{ ...modelDefinition.provider, models: [modelDefinition.model] }] };
    const bindingPin = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: sha256(encodeModelBindingDefinition(modelDefinition as never)) };
    config.provider_catalog = catalog;
    config.provider_invocation_profiles = { schemaVersion: 1, profiles: [{ ...f.profile, reference, bindingDigest: bindingPin.digest }] };
    const model_roles = { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture', roles: [], exceptions: [], models: [
      { channelId: reference.providerId, modelId: reference.modelId, version: 1, tier: 'frontier', roles: ['beuser-walker', 'beuser-evaluator'] }] }] };
    await mkdir(options.env.DECKENT_GLOBAL_HOME, { recursive: true, mode: 0o700 });
    await writeFile(join(options.env.DECKENT_GLOBAL_HOME, 'config.json'), JSON.stringify({ model_roles }), { mode: 0o600 });
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const principalForSeed = { ...adapters.readLocalOsIdentity(), scopeIds: ['scope'] };
    const activation = new ModelActivationApplication({ verify: async () => principalForSeed }, { authorize: async () => ({ revision: 'fixture', ruleId: 'fixture' }) },
      new ModelBindingApplication({ read: async () => catalog as never }), async () => adapters.openSqliteModelActivationStore(storage.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }), () => 1);
    await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'fixture', expectedBinding: bindingPin });
    parameters.choices = { 'beuser-walker': { channelId: reference.providerId, modelId: reference.modelId }, 'beuser-evaluator': { channelId: reference.providerId, modelId: reference.modelId } };
    await writeFile(profilePath, JSON.stringify(admission));
    // R1: untrusted release metadata is refused before the setup card, without config or Run writes.
    const releasePath = join(candidate, 'release.json'), releaseBytes = await readFile(releasePath), beforeBad = await readFile(configPath, 'utf8');
    const ledgerBefore = await readFile(storage.path), badCandidates: Record<string, unknown> = {};
    for (const kind of ['oversized', 'symlink', 'fifo']) {
      await rm(releasePath);
      if (kind === 'oversized') await writeFile(releasePath, Buffer.alloc(20 * 1024 * 1024, 32));
      else if (kind === 'symlink') await symlink(join(candidate, 'dist', 'build-identity.json'), releasePath);
      else await promisify(execFile)('mkfifo', [releasePath]);
      const started = performance.now(), result = await oneCommand('onboarding', ['--candidate', candidate], [{ when: card, send: '\r' }, { when: card, send: '\r' }]);
      expect(result.code, result.output).toBe(1); expect(result.output).toContain('BEUSER_CANDIDATE_MISMATCH');
      expect(result.output).not.toContain('Start BeUser walk'); expect(performance.now() - started).toBeLessThan(10000);
      expect(await readFile(configPath, 'utf8')).toBe(beforeBad); expect(await readFile(storage.path)).toEqual(ledgerBefore);
      badCandidates[kind] = result;
      await rm(releasePath); await writeFile(releasePath, releaseBytes);
    }
    // A separate process pins measurement first, then changes that file: bounded allocation, nofollow/nonblock and a finite process deadline.
    const readerUrl = new URL('../../../dist/adapters/core/beuser-realm/index.js', import.meta.url).href;
    const readerScript = `import { readMeasuredBeuserRecord } from ${JSON.stringify(readerUrl)};
      try { await readMeasuredBeuserRecord(process.argv[1], JSON.parse(process.argv[2])); process.exitCode = 2; }
      catch (error) { if (error.code !== 'BEUSER_CANDIDATE_MISMATCH') throw error; console.log(error.code); }`;
    const releasePin = measured.files.find(file => file.path === 'release.json')!;
    for (const kind of ['changed', 'grown', 'symlink', 'fifo']) {
      await rm(releasePath);
      if (kind === 'changed') await writeFile(releasePath, Buffer.alloc(releasePin.size, 32));
      else if (kind === 'grown') await writeFile(releasePath, Buffer.concat([releaseBytes, Buffer.from('extra')]));
      else if (kind === 'symlink') await symlink(join(candidate, 'dist', 'build-identity.json'), releasePath);
      else await promisify(execFile)('mkfifo', [releasePath]);
      const started = performance.now(), result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', readerScript, candidate, JSON.stringify(releasePin)], { timeout: 5000 });
      expect(result.stdout.trim()).toBe('BEUSER_CANDIDATE_MISMATCH'); expect(performance.now() - started).toBeLessThan(5000);
      expect(await readFile(configPath, 'utf8')).toBe(beforeBad); expect(await readFile(storage.path)).toEqual(ledgerBefore);
      badCandidates[`after-measurement-${kind}`] = result;
      await rm(releasePath); await writeFile(releasePath, releaseBytes);
    }
    const installed = await runInTerminal(argv, root, env, [{ when: '↑↓ choose · Enter confirm · Esc cancel', send: 'y' }]);
    expect(installed.output).toContain('Install BeUser profile'); expect(installed.output).toContain('Apply (y)');
    expect(installed.code, installed.output).toBe(0); expect(lastJson(installed.output)).toMatchObject({ status: 'applied', pool: { status: 'created' } });
    const beforeReplay = await readFile(configPath, 'utf8');
    const replayed = await runInTerminal(argv, root, env, [{ when: '↑↓ choose · Enter confirm · Esc cancel', send: 'y' }]);
    expect(replayed.code, replayed.output).toBe(0); expect(lastJson(replayed.output)).toMatchObject({ status: 'current', pool: { status: 'current' } });
    expect(await readFile(configPath, 'utf8')).toBe(beforeReplay);
    await writeFile(profilePath, JSON.stringify({ ...admission, executionSlots: 2 }));
    const conflict = await runInTerminal(argv, root, env, [{ when: '↑↓ choose · Enter confirm · Esc cancel', send: 'y' }]);
    expect(conflict.code).toBe(1); expect(conflict.output).toContain('BEUSER_SETUP_CONFLICT');
    expect(await readFile(configPath, 'utf8')).toBe(beforeReplay);
    await writeFile(profilePath, JSON.stringify(admission));
    const emptyReport = await runInTerminal([process.execPath, cli, 'beuser', 'report', '--scope', 'scope', '--json', '--lang', 'en'], root, env);
    expect(emptyReport.code).toBe(1); expect(emptyReport.output).toContain('BEUSER_REPORT_NOT_FOUND'); expect(emptyReport.output).toContain('deckent beuser walk');
    clearConfigCache();
    const admitted = await admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'journey', candidate }, options);
    expect(admitted.principal).toEqual(beuserEvaluatorFor(admitted.c.principal, 'scope'));
    const definition = admitted.definitions[0]!;
    expect(definition.binding.identity).toMatchObject({ scopeId: 'scope', runId: admitted.runId, taskId: 'persona', generation: 1 });
    expect(definition.binding.identity.attemptId).not.toBe('untrusted');
    const reservation = await reserveConfiguredRunTasks(root, { schemaVersion: 1, commandId: 'reserve', scopeId: 'scope', runId: admitted.runId, expectedRevision: 0 }, options,
      taskId => admitted.definitions.find(row => row.binding.identity.taskId === taskId)!.binding.identity.attemptId);
    expect(reservation.reservation.identities).toEqual([definition.binding.identity]);
    // Durable dispatch and custody survive closing the SQLite connection. Only external realm I/O is a fallible fixture.
    const management = await adapters.openSqliteAttemptStore(await admitted.c.path(), admitted.c.config.storage.sqlite,
      { now: Date.now, timeoutMs: admitted.c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateBeuserSupervisorProfile }), request = { protocolVersion: 1 as const,
      identity: definition.binding.identity, workspace: candidate, argv: ['--help'] };
    const profile = { schemaVersion: 1 as const, adapterId: 'beuser', adapterVersion: 1,
      parameters: admitted.profiles.get('persona')!.parameters };
    const owner = definition.producer.owner, claim = { request, owner };
    try { await management.claimDispatch({ ...claim, profile });
      await management.grantLaunch({ claim, principal: admitted.c.principal, now: 1 }); }
    finally { management.close(); }
    const reopened = await openConfiguredAttemptStore(root, options), ctx = { binding: definition.binding, principal: admitted.principal,
      limits: BEUSER_LIMITS_REGISTRY.profiles[0]!, signal: new AbortController().signal };
    const directory = join(await prepareProductDirectory(admitted.c.layout, 'crashes'), 'beuser-custody');
    const custody = await adapters.createBeuserRealmCustody({ context: ctx, request, store: reopened.store, owner, directory,
      timeoutMs: admitted.c.config.configFile.writeLockTimeoutMs });
    const handle = { binding: ctx.binding, incarnation: '12345678-1234-4234-8234-123456789abc', containerId: 'a'.repeat(64),
      controlDirectory: directory, controlIdentity: 'fixture-owned-directory' };
    await custody.reserve(ctx); await custody.publish(ctx, handle);
    const policyPathForCancel = join(admitted.c.layout.root, 'policy.json'), policyForCancel = JSON.parse(await readFile(policyPathForCancel, 'utf8'));
    policyForCancel.grants.push({ id: 'explicit-cancel-card', effect: 'allow', actions: ['cancel'], scopes: ['scope'],
      principals: [{ issuer: admitted.c.principal.issuer, subject: admitted.c.principal.subject }], resource: { kind: 'attempt', ids: [request.identity.attemptId] } });
    await writeFile(policyPathForCancel, JSON.stringify(policyForCancel), { mode: 0o600 });
    const artifacts = new adapters.FileArtifactStore({ root: await prepareProductDirectory(admitted.c.layout, 'artifacts'), maxBytes: admitted.c.config.artifacts.maxBytes });
    const remove = vi.fn(async () => ({ processesAbsent: true, cgroupAbsent: false, filesystemAbsent: true, evidenceRefs: ['fixture-cgroup-unknown'] }));
    const realm = vi.spyOn(adapters, 'createBeuserRealm').mockImplementation(input => new BeuserRealmApplication({
      async create() { throw new Error('NO_RECOVERY_LAUNCH'); }, async inspect() { throw new Error('NO_RECOVERY_ADMISSION'); }, remove }, input.custody));
    const docker = vi.spyOn(adapters, 'recordedDockerSupervisor');
    // Management access comes from current config; the realm/profile/custody come from the recorded dispatch.
    const managementConfig = { ...admitted.c.config, execution: { ...admitted.c.config.execution, docker: { executable: '/usr/bin/docker',
      imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216,
      logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 } } };
    const delivery = () => createRecordedCancellationDelivery(reopened.store, managementConfig, admitted.c.layout, admitted.c.principal,
      { verify: async () => admitted.c.principal });
    try {
      await reopened.store.cancelRun({ commandId: 'cancel', actor: { id: admitted.c.principal.id, issuer: admitted.c.principal.issuer, subject: admitted.c.principal.subject }, scopeId: 'scope', runId: admitted.runId,
        expectedRevision: (await reopened.store.loadRun('scope', admitted.runId))!.revision });
      await delivery().authorizeCancellation(request);
      expect(remove).not.toHaveBeenCalled();
      expect(await delivery().cancel(request)).toMatchObject({ kind: 'unresolved' });
      expect((await custody.load(ctx))?.observation.state).toBe('quarantined');
      const recorded = (await reopened.store.readDispatch(request))!;
      expect(() => recordedExecutionSupervisor({ ...recorded, profile: { ...profile, adapterId: 'unknown' } },
        { config: managementConfig, layout: admitted.c.layout, store: reopened.store, artifacts })).toThrow('SUPERVISOR_PROFILE_INVALID');
      expect(() => recordedExecutionSupervisor({ ...recorded, profile: { ...profile, adapterVersion: 2 } },
        { config: managementConfig, layout: admitted.c.layout, store: reopened.store, artifacts })).toThrow('SUPERVISOR_PROFILE_INVALID');
      const manager = recordedExecutionSupervisor(recorded, { config: managementConfig, layout: admitted.c.layout, store: reopened.store, artifacts });
      await expect(manager.cancel({ ...request, identity: { ...request.identity, generation: 2 } })).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
      expect(remove).toHaveBeenCalledOnce();
      // New absence evidence, never a retry that converts the same unknown proof to success.
      remove.mockResolvedValue({ processesAbsent: true, cgroupAbsent: true, filesystemAbsent: true, evidenceRefs: ['fixture-three-absences'] });
      expect(await delivery().cancel(request)).toMatchObject({ kind: 'unresolved' });
      expect((await custody.load(ctx))?.observation).toMatchObject({ state: 'destroyed', evidenceRefs: ['fixture-three-absences'] });
      const final = recordedExecutionSupervisor((await reopened.store.readDispatch(request))!, { config: managementConfig, layout: admitted.c.layout, store: reopened.store, artifacts });
      expect(await final.observe(request)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'BEUSER_EXECUTION_UNRESOLVED' } });
      expect(await final.observeCreatedAbsence?.(request, handle.containerId)).toEqual({ kind: 'created-container-absent', containerId: handle.containerId });
      await expect(final.observeCreatedAbsence?.(request, 'b'.repeat(64))).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
      // A separate retained harness terminal fixture supplies an actual recorded result; absence alone never invents an exit code.
      await beuserPrivateRecord(directory, `terminal-${sha256(JSON.stringify(request.identity))}`, ctx.limits.maxArtifactBytes).write({ binding: ctx.binding,
        result: { handle: `beuser-${handle.incarnation}`, result: { kind: 'exited', exitCode: 1 }, outputCompleteness: 'partial', stdout: '', stderr: '', interrupted: true },
        reason: 'BEUSER_CANDIDATE_MISMATCH', cleanup: 'destroyed', evidence: null });
      expect(await delivery().cancel(request)).toMatchObject({ kind: 'terminal', record: { terminal: { exitCode: 1 } } });
      expect(await final.observe(request)).toMatchObject({ result: { kind: 'exited', exitCode: 1 } });
      expect(await final.release(request)).toBe('absent');
      expect(docker).not.toHaveBeenCalled();
    } finally { realm.mockRestore(); docker.mockRestore(); reopened.store.close(); }
    // An explicit unknown report fixture checks persistence/query custody only, never journey acceptance.
    const report = createBeuserReport({ schemaVersion: 1, simulated: true, calibrationClaim: 'uncalibrated', cohort: 'cohort', calibration,
      counts: { defined: 1, selected: 1, walked: 0, concurrent: 0 }, segments: [], unwalked: [{ branch: 'persona', reason: 'dry-admission' }],
      unknown: [], criticalCoverage: [], reliability: { completed: 0, attempted: 0 }, cost: null, currency: 'USD', elapsedMs: null });
    const reports = join(admitted.c.layout.root, 'crashes', 'beuser-reports');
    await mkdir(join(admitted.c.layout.root, 'crashes'), { recursive: true, mode: 0o700 });
    await beuserPrivateRecord(reports, sha256(JSON.stringify(['scope', admitted.runId])), 100000).write({ schemaVersion: 1, scopeId: 'scope', runId: admitted.runId, report });
    await beuserPrivateRecord(reports, sha256(JSON.stringify(['scope', admitted.c.principal.issuer, admitted.c.principal.subject])), 100000).write({ schemaVersion: 1, scopeId: 'scope', runId: admitted.runId });
    expect(await readConfiguredBeuserReport(root, 'scope', undefined, options)).toEqual(report);
    const policyPath = join(admitted.c.layout.root, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants.push({ id: 'deny-report', effect: 'deny', principals: 'all', scopes: ['scope'], actions: ['inspect'], resource: { kind: 'run', ids: [admitted.runId] } });
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    await expect(readConfiguredBeuserReport(root, 'scope', undefined, options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // The assembled CLI passes the installed-profile/Run/pool checks. This fixture has no execution Docker config,
    // so it stops before any realm, model or external effect and reports that separate prerequisite truthfully.
    const walked = await runInTerminal([process.execPath, cli, 'beuser', 'walk', '--scope', 'scope', '--journey', 'journey', '--candidate', candidate, '--json'], root, env);
    expect(walked.code, walked.output).toBe(0);
    expect(lastJson(walked.output)).toMatchObject({ counts: { selected: 1, walked: 0 }, unknown: [{ branch: 'persona', reason: 'EXECUTION_NOT_CONFIGURED' }] });
    // The model card (Enter = the recommended connected model), then the setup card: Esc applies nothing; this source checkout is no staged build;
    // 'y' swaps the controller's BeUser registry (its pool kept) and walks to a retained report.
    const before = await readFile(configPath, 'utf8');
    const refusedCard = await oneCommand('onboarding', ['--candidate', candidate], [{ when: card, send: '\r' }, { when: card, send: '\r' }, { when: card, send: '\u001b' }]);
    expect(refusedCard.code, refusedCard.output).toBe(0); expect(refusedCard.output).toContain('fixture-channel / fixture-model (recommended)');
    expect(refusedCard.output).toContain('Start BeUser walk'); expect(refusedCard.output).toContain('nothing was applied'); expect(await readFile(configPath, 'utf8')).toBe(before);
    const fromPackage = await oneCommand('onboarding', [], [{ when: card, send: '\r' }, { when: card, send: '\r' }]);
    expect(fromPackage.code).toBe(1); expect(fromPackage.output).toContain('BEUSER_CANDIDATE_MISMATCH'); expect(await readFile(configPath, 'utf8')).toBe(before);
    const one = await oneCommand('onboarding', ['--candidate', candidate, '--json'], [{ when: card, send: '\r' }, { when: card, send: '\r' }, { when: card, send: 'y' }]);
    expect(one.code, one.output).toBe(0); expect(one.output).toContain(source.sourceCommit); expect(one.output).toContain('Walker 1: fixture-channel');
    const oneReport = lastJson(one.output);
    // The earlier walk's unresolved Attempt still holds the pool's one slot: a typed unknown in a retained report, never a second walk.
    expect(oneReport).toMatchObject({ counts: { selected: 1, walked: 0 }, unknown: [{ branch: 'onboarding', reason: 'RUN_POOL_FULL' }] });
    const swapped = JSON.parse(await readFile(configPath, 'utf8')).admission;
    expect(swapped).toMatchObject({ poolId: 'pool', executionSlots: 1, registry: { revision: 'beuser-controller-onboarding', profiles: [{ parameters: { candidateRoot: candidate,
      choices: { 'beuser-walker': { channelId: 'fixture-channel', modelId: 'fixture-model' } } } }] } });
    clearConfigCache(); expect(await readConfiguredBeuserReport(root, 'scope', undefined, options)).toEqual(oneReport);
    // Five active fixture providers: no transport is called (execution has no Docker configuration).
    const references = [reference], definitions = [modelDefinition], invocationProfiles = [{ ...f.profile, reference, bindingDigest: bindingPin.digest }];
    for (let index = 1; index <= 4; index++) {
      const ref = { ...reference, providerId: `fixture-extra-${index}`, modelId: `fixture-model-${index}` };
      const definition = { ...modelDefinition, provider: { id: ref.providerId, version: 1 }, model: { ...modelDefinition.model, id: ref.modelId, nativeId: ref.modelId } };
      const pin = { ...bindingPin, digest: sha256(encodeModelBindingDefinition(definition as never)) };
      catalog.providers.push({ ...definition.provider, models: [definition.model] });
      invocationProfiles.push({ ...f.profile, id: `fixture-profile-${index}`, allocation: { ...f.profile.allocation, id: `fixture-allocation-${index}` }, ...(index === 1 ? { schemaVersion: 2, billingAxis: 'subscription' } : {}), reference: ref, bindingDigest: pin.digest } as never);
      references.push(ref); definitions.push(definition);
      await activation.admit({ schemaVersion: 1, action: 'activate', commandId: `activate-${index}`, scopeId: 'scope', reference: ref, expectedRevision: 0, catalogRevision: 'fixture', expectedBinding: pin });
    }
    const multiConfig = JSON.parse(await readFile(configPath, 'utf8'));
    multiConfig.provider_catalog = catalog; multiConfig.provider_invocation_profiles = { schemaVersion: 1, profiles: invocationProfiles };
    await writeFile(configPath, JSON.stringify(multiConfig)); clearConfigCache();
    const multiBefore = await readFile(configPath, 'utf8'), answer = (send: string) => ({ when: card, send });
    const over = await oneCommand('onboarding', ['--candidate', candidate], [answer('\r'), answer('\u001b')]);
    expect(over.code, over.output).toBe(0); expect(over.output).toContain('Selected 5; choose 1–4'); expect(over.output).not.toContain('Judge for this journey');
    const empty = await oneCommand('onboarding', ['--candidate', candidate], ['1', '2', '3', '4', '5', '\r', '\u001b'].map(answer));
    expect(empty.code, empty.output).toBe(0); expect(empty.output).toContain('Selected 0; choose 1–4'); expect(empty.output).not.toContain('Judge for this journey');
    // Keep first two walkers; choose third model as a distinct judge; Esc applies nothing, including pool capacity.
    const chooseTwo = ['3', '4', '5', '\r'].map(answer);
    const twoCancelled = await oneCommand('onboarding', ['--candidate', candidate], [...chooseTwo, answer('3'), answer('\u001b[6~'), answer('\u001b')]);
    expect(twoCancelled.code, twoCancelled.output).toBe(0); expect(twoCancelled.output).toContain('Walker 2: fixture-extra-1');
    expect(twoCancelled.output).toContain('Judge: fixture-extra-2'); expect(twoCancelled.output).toContain('independence: unknown');
    expect(twoCancelled.output).toContain('1/1 → 2/2'); expect(twoCancelled.output).toContain('at most 6 USD'); expect(await readFile(configPath, 'utf8')).toBe(multiBefore);
    const runCount = () => { const db = new DatabaseSync(storage.path, { readOnly: true });
      try { return db.prepare('SELECT COUNT(*) AS count FROM runs').get()!.count; } finally { db.close(); } };
    const runsBeforeDenied = runCount();
    const deniedCapacity = await oneCommand('onboarding', ['--candidate', candidate, '--json'], [...chooseTwo, answer('3'), answer('\u001b[6~'), answer('y')]);
    expect(deniedCapacity.code, deniedCapacity.output).toBe(1); expect(deniedCapacity.output).toContain('POLICY_DENIED'); expect(runCount()).toBe(runsBeforeDenied);
    expect((await inspectConfiguredPoolCapacity(root, { schemaVersion: 1, scopeId: 'scope' }, options)).capacity).toEqual({ executionSlots: 1, inFlightSlots: 1 });
    // Config publication and pool authority are separate: denial is retained, never silently promoted to installation authority.
    expect(JSON.parse(await readFile(configPath, 'utf8')).admission).toMatchObject({ executionSlots: 2, inFlightSlots: 2 });
    const capacityPolicyPath = policyPath, capacityPolicy = JSON.parse(await readFile(capacityPolicyPath, 'utf8'));
    capacityPolicy.grants.push({ id: 'synthetic-owner-pool-card', effect: 'allow', actions: ['set-capacity'], scopes: 'all',
      principals: [{ issuer: admitted.c.principal.issuer, subject: admitted.c.principal.subject }], resource: { kind: 'pool', ids: ['pool'] } });
    await writeFile(capacityPolicyPath, JSON.stringify(capacityPolicy), { mode: 0o600 }); clearConfigCache();
    const two = await oneCommand('onboarding', ['--candidate', candidate, '--json'], [...chooseTwo, answer('3'), answer('\u001b[6~'), answer('y')]);
    expect(two.code, two.output).toBe(0); expect(lastJson(two.output)).toMatchObject({ counts: { selected: 2 } });
    const twoAdmission = JSON.parse(await readFile(configPath, 'utf8')).admission;
    expect(twoAdmission).toMatchObject({ executionSlots: 2, inFlightSlots: 2 });
    expect(twoAdmission.registry.profiles).toHaveLength(2);
    expect((await inspectConfiguredPoolCapacity(root, { schemaVersion: 1, scopeId: 'scope' }, options)).capacity).toEqual({ executionSlots: 2, inFlightSlots: 2 });
    expect(twoAdmission.registry.profiles.map((p: { parameters: { choices: unknown } }) => p.parameters.choices)).toEqual([
      { 'beuser-walker': { channelId: 'fixture-channel', modelId: 'fixture-model' }, 'beuser-evaluator': { channelId: 'fixture-extra-2', modelId: 'fixture-model-2' } },
      { 'beuser-walker': { channelId: 'fixture-extra-1', modelId: 'fixture-model-1' }, 'beuser-evaluator': { channelId: 'fixture-extra-2', modelId: 'fixture-model-2' } }]);
    // Fresh pool uses controllerData.pool rather than an existing admission. Default judge is first subscription (second row), also a walker.
    const freshOptions = { env: { ...options.env, DECKENT_GLOBAL_HOME: freshGlobal } };
    await applyPolicyTemplateInstallation(freshRoot, 'scope', freshOptions);
    const freshConfigPath = join(freshRoot, '.deckent', 'config.json'), freshConfig = JSON.parse(await readFile(freshConfigPath, 'utf8'));
    freshConfig.terminal = { scopeId: 'scope' }; freshConfig.provider_catalog = { ...catalog, providers: catalog.providers.slice(0, 2) };
    freshConfig.provider_invocation_profiles = { schemaVersion: 1, profiles: invocationProfiles.slice(0, 2) };
    await writeFile(freshConfigPath, JSON.stringify(freshConfig));
    const freshStorage = await openConfiguredAttemptStore(freshRoot, freshOptions); freshStorage.store.close();
    const freshActivation = new ModelActivationApplication({ verify: async () => principalForSeed }, { authorize: async () => ({ revision: 'fixture', ruleId: 'fixture' }) },
      new ModelBindingApplication({ read: async () => freshConfig.provider_catalog }), async () => adapters.openSqliteModelActivationStore(freshStorage.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }), () => 1);
    for (let index = 0; index < 2; index++) await freshActivation.admit({ schemaVersion: 1, action: 'activate', commandId: `fresh-${index}`, scopeId: 'scope', reference: references[index],
      expectedRevision: 0, catalogRevision: 'fixture', expectedBinding: { ...bindingPin, digest: sha256(encodeModelBindingDefinition(definitions[index] as never)) } });
    clearConfigCache();
    const freshWalk = await runInTerminal([process.execPath, cli, 'beuser', 'walk', '--journey', 'onboarding', '--candidate', candidate, '--lang', 'en'], elsewhere, freshEnv,
      [answer('\r'), answer('\r'), answer('\u001b[6~'), answer('y')]);
    expect(freshWalk.code, freshWalk.output).toBe(0); expect(freshWalk.output).toContain('Judge: fixture-extra-1'); expect(freshWalk.output).toContain('independence: reduced');
    expect(freshWalk.output).toContain('new pool → 2/2'); expect(freshWalk.output).toContain('Walker ayse-onboarding-walker-1');
    expect(freshWalk.output).toContain('Judge for ayse-onboarding-walker-2'); expect(freshWalk.output).toContain(`Walked revision ${source.sourceCommit}`);
    expect(freshWalk.output).toContain(`cd ${freshRoot} && deckent beuser report`);
    expect(JSON.parse(await readFile(freshConfigPath, 'utf8')).admission).toMatchObject({ poolId: 'beuser-controller', executionSlots: 2, inFlightSlots: 2 });
    if (process.env.BEUSER_SETUP_PROOF) await writeFile(join(process.env.BEUSER_SETUP_PROOF, 'cli-pty.json'), JSON.stringify({ sourceHead: '7c5e5671fabc16a6b848dc4e05955275523920bb', evidenceClass: 'author-compiled-cli-fixture', badCandidates, freshController, over, empty, twoCancelled, deniedCapacity, two, freshWalk, missingProfile, refused, ai, installed, replayed, conflict, emptyReport, walked,
      noModel, badJourney, refusedCard, fromPackage, one }, null, 2));
    await writeFile(join(candidate, 'dist', 'entry.js'), 'changed;\n');
    await expect(admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'onboarding', candidate }, options)).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
    // A foreign candidate is refused before creating another Run, without a verify=true test adapter.
    await expect(admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'onboarding', candidate: root }, options)).rejects.toMatchObject({ code: 'BEUSER_INPUT_INVALID' });
  } finally { clearConfigCache(); await rm(base, { recursive: true, force: true }); }
  // Twelve compiled-CLI PTY runs (one-command branches, bad candidates, fresh controller, two walkers): ~67 s on the dev host, above the 30 s default.
}, 180_000);
