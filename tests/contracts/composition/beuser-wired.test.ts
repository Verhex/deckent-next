import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation, installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { evaluatorEvidence } from '#capabilities/index.js';
import { BEUSER_LIMITS_REGISTRY, BeuserRealmApplication, deliveryEvidenceKindSchema } from '#engine/index.js';
import { expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import * as engine from '#engine/index.js';
import * as platform from '#platform/index.js';
import { walkConfiguredBeuser, readConfiguredBeuserReport, admitConfiguredBeuserWalk, setupConfiguredBeuser } from '#composition/core/beuser/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { recordedExecutionSupervisor, validateBeuserSupervisorProfile } from '#composition/core/supervisors/index.js';
import { formatBeuserReport } from '#surfaces/core/cli-beuser/index.js';
import { sha256, clearConfigCache, ErrorRegistry, inspectProductFile } from '#platform/index.js';
import { BeuserContractError, BeuserTransferError } from '#engine/index.js';
import { BeuserSurfaceError } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

it('keeps BeUser target, surface and sealed-backup refusals typed and localized without exposing internal detail', () => {
  const errors = [new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'), new BeuserSurfaceError('BEUSER_SURFACE_INVALID'), new BeuserTransferError(),
    new BeuserContractError('BEUSER_PROFILE_REQUIRED'), new BeuserContractError('BEUSER_REPORT_NOT_FOUND'), new BeuserContractError('BEUSER_CANDIDATE_MISMATCH'), new BeuserContractError('BEUSER_START_STATE_UNREACHABLE')];
  const codes = ['BEUSER_TARGET_NOT_SANDBOX', 'BEUSER_SURFACE_INVALID', 'BACKUP_REALM_SEALED', 'BEUSER_PROFILE_REQUIRED', 'BEUSER_REPORT_NOT_FOUND', 'BEUSER_CANDIDATE_MISMATCH', 'BEUSER_START_STATE_UNREACHABLE'];
  errors.forEach((error, index) => {
    error.message += ' /private/target/raw-screen credential=hidden';
    const mapped = queryFailure(error);
    expect(mapped.code).toBe(codes[index]);
    expect(mapped.localize?.('tr').message).not.toBe(mapped.localize?.('en').message);
    expect(mapped.suggestion).toBeTruthy();
    expect(JSON.stringify(mapped)).not.toContain('/private'); expect(JSON.stringify(mapped)).not.toContain('hidden');
  });
});

it('carries the installed harness-readback evidence label through delivery consumers', () => {
  expect(evaluatorEvidence({ id: 'beuser' })).toEqual({ kind: 'harness-readback', independent: true });
  expect(deliveryEvidenceKindSchema.parse('harness-readback')).toBe('harness-readback');
});
it('publishes rows inside the original digest, refuses changed bytes on replay and preserves revocation on same-data upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-c6-r3-'));
  try {
    expect(await applyPolicyTemplateInstallation(root, 'scope')).toMatchObject({ status: 'installed', systemRows: { status: 'applied' } });
    const config = await loadComposedConfig(root, { heal: false, force: true });
    const store = createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes);
    await expect(applyPolicyTemplateInstallation(root, 'scope')).resolves.toMatchObject({ status: 'replayed', systemRows: { status: 'replayed' } });
    const before = await store.updateAuthority(snapshot => ({ write: null, result: snapshot }));
    const policy = before.policy as { roles: { id: string; permissions: unknown[] }[] };
    const systemRole = policy.roles.find(role => role.id.startsWith('sr-'))!;
    expect(systemRole.permissions.length).toBeGreaterThan(1);
    await store.updateAuthority(snapshot => ({ write: { policy: { ...(snapshot.policy as object), revision: 'deleted-permission',
      roles: policy.roles.map(role => role.id === systemRole.id ? { ...role, permissions: role.permissions.slice(1) } : role) }, bindings: null, order: 'policy-first' }, result: null }), 'test-delete-permission');
    const path = join(root, '.deckent', 'policy.json'), deleted = await readFile(path, 'utf8');
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
    const preview = await upgradePolicyTemplateInstallation(root, 'scope', false);
    expect(await upgradePolicyTemplateInstallation(root, 'scope', true, preview.expect ?? undefined, {}, userInfo().uid, undefined, { attest: async () => true })).toMatchObject({ status: 'current' });
    expect(await readFile(path, 'utf8')).toBe(deleted);
    // A manual edit with the same revision has no archived edge and must never be adopted on replay.
    const foreign = JSON.parse(deleted); foreign.grants[0].resource.ids = ['foreign-target'];
    await writeFile(path, JSON.stringify(foreign));
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
    await writeFile(path, deleted + '\n');
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Real installation/admission/pool/dispatch/custody; only external realm/driver I/O is substituted below.
async function reportFixture(mode: 'pty' | 'argv' = 'pty', startState?: object) {
  const base = await mkdtemp(join(tmpdir(), 'beuser-report-refusal-')), root = join(base, 'project'), candidate = join(base, 'candidate');
  const options = { env: { HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global') } };
  try {
    await mkdir(root); await mkdir(join(candidate, 'dist'), { recursive: true });
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'test-candidate', version: '1.0.0', files: ['dist'] }));
    await writeFile(join(candidate, 'dist', 'entry.js'), 'export {};\n');
    const source = { sourceCommit: '1'.repeat(40), sourceTreeSha256: '2'.repeat(64) };
    await writeFile(join(candidate, 'dist', 'build-identity.json'), JSON.stringify(source));
    const max = { maxFiles: 100, maxFileBytes: 100000, maxTotalBytes: 1000000, maxDepth: 10 };
    const inventory = await adapters.measureInstalledPackage(candidate, max);
    const manifest = JSON.stringify(Object.fromEntries(inventory.files.map(file => [file.path, `${file.sha256}:${file.mode.toString(8)}`])));
    await writeFile(join(candidate, 'manifest.json'), manifest);
    await writeFile(join(candidate, 'release.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '1.0.0', ...source, manifestSha256: sha256(manifest) }));
    const measured = await adapters.measureInstalledPackage(candidate, max), files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    await applyPolicyTemplateInstallation(root, 'scope', options);
    const binding = { schemaVersion: 1, identity: { scopeId: 'untrusted', runId: 'untrusted', taskId: 'untrusted', attemptId: 'untrusted', layoutRevision: 'untrusted', generation: 1 },
      candidate: { adapter: 'installed-package', version: '1.0.0', evidenceRef: 'package', stateDigest: sha256(JSON.stringify(files)), environmentDigest: 'b'.repeat(64) },
      candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64), realmId: 'untrusted', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'untrusted' };
    const parameters = { schemaVersion: startState ? 3 : 2, ...(startState ? { startState } : {}), binding, limitsRevision: BEUSER_LIMITS_REGISTRY.profiles[0]!.revision, candidateRoot: candidate, packageDigest: measured.measurementDigest,
      candidateManifest: { sha256: sha256(manifest), fileCount: files.length, ...source, version: '1.0.0' },
      summary: { schemaVersion: 1, personaId: 'person', journeyId: 'journey', language: 'tr', role: 'buyer', goals: ['purchase'],
        knowledgeBoundary: [], accessibility: [], initialKnowledge: [], goal: 'request goods', competency: { computer: 1, domain: 4, product: 0 },
        preferences: [], riskAttitude: 'cautious', surface: 'terminal', organizationContext: {}, patience: { maxSteps: 4, maxWaitMs: 100 }, attentionMs: 1000 },
      size: { columns: 80, rows: 24, scrollback: 100 }, bounds: { quietMs: 10, inactivityMs: 100, maxInputBytes: 1024 }, completionTokens: 1024,
      rubric: { schemaVersion: 1, journeyId: 'journey', version: 1, digest: 'f'.repeat(64), parameters: {} },
      choices: { 'beuser-walker': { channelId: 'configured', modelId: 'walker' }, 'beuser-evaluator': { channelId: 'configured', modelId: 'evaluator' } },
      contributorModels: [{ vendorId: 'source-maker' }], entry: { mode, nodeExecutable: adapters.BEUSER_REALM_RECIPE.nodeExecutable, args: ['--help'] },
      probes: [{ id: 'installation', dimension: 'outcome', readbackRef: 'readback', key: 'installation', expected: 'installed' }],
      calibration: { revision: 'r', cohort: 'cohort', trapHits: 0, trapTotal: 0, falseRed: 0, goodTotal: 0, minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 } };
    const configPath = join(root, '.deckent', 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.admission = { poolId: 'pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'beuser-fixture',
      profiles: [{ id: 'persona', version: 1, adapter: { id: 'beuser', version: 1 }, parameters }],
      kinds: [{ kind: 'journey', profile: { id: 'persona', version: 1 }, workspaceDelivery: 'none' }], evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } };
    config.execution = { git: { gitExecutable: 'git', timeoutMs: 10000 }, docker: { executable: join(base, 'must-not-execute'), imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
      pids: 64, cpus: 1, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 } };
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    const storage = await openConfiguredAttemptStore(root, options); storage.store.close();
    expect(await installConfiguredExecutionPool(root, 'scope', true, options)).toMatchObject({ status: 'created' });
    const records = async () => {
      const directory = join(root, '.deckent', 'crashes', 'beuser-custody'), names = await readdir(directory);
      const terminalName = names.find(name => /^terminal-.*\.json$/u.test(name))!;
      const terminal = JSON.parse(await readFile(join(directory, terminalName), 'utf8'));
      const custody = JSON.parse(await readFile(join(directory, terminalName.replace('terminal-', '')), 'utf8'));
      return { terminal, custody, directory };
    };
    return { root, candidate, options, records, dispose: async () => { vi.restoreAllMocks(); clearConfigCache(); await rm(base, { recursive: true, force: true }); } };
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

it.skipIf(process.platform !== 'linux')('retains a real verifyPackage refusal before handle publication through composition, private custody and reports', async () => {
  const f = await reportFixture();
  try {
    const createRealm = adapters.createBeuserRealm;
    vi.spyOn(adapters, 'createBeuserRealm').mockImplementation(input => {
      // Admission already pinned valid bytes; the real Docker runtime's verifyPackage now sees a changed candidate.
      writeFileSync(join(f.candidate, 'dist', 'entry.js'), 'changed;\n');
      return createRealm(input);
    });
    const surface = vi.spyOn(adapters, 'createBeuserSurface'), runtime = vi.spyOn(adapters.DockerBeuserRealmRuntime.prototype, 'create');
    const report = await walkConfiguredBeuser(f.root, { scopeId: 'scope', journey: 'journey', candidate: f.candidate }, f.options);
    expect(report).toMatchObject({ counts: { selected: 1, walked: 0 }, unknown: [{ branch: 'persona', reason: 'BEUSER_CANDIDATE_MISMATCH' },
      { branch: 'persona', reason: 'BEUSER_CLEANUP_UNPROVEN' }] });
    const { terminal, custody } = await f.records();
    expect(terminal).toMatchObject({ result: null, reason: 'BEUSER_CANDIDATE_MISMATCH', cleanup: 'unknown', evidence: null });
    expect(terminal.binding).toEqual(custody.binding);
    expect(custody.lease).toMatchObject({ handle: null, observation: { state: 'quarantined', evidenceRefs: [] } });
    expect(surface).not.toHaveBeenCalled();
    const config = await loadComposedConfig(f.root, { ...f.options, heal: false });
    const stored = { layout: config.productLayout, store: await adapters.openSqliteAttemptStore(await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite,
      { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateBeuserSupervisorProfile }) };
    try {
      const request = { protocolVersion: 1 as const, identity: terminal.binding.identity, workspace: f.candidate, argv: ['--help'] };
      const record = (await stored.store.readDispatch(request))!;
      expect(record).toMatchObject({ launch: 'granted', terminal: null }); expect(record.output).toBeUndefined();
      const manager = recordedExecutionSupervisor(record, { config, layout: stored.layout, store: stored.store,
        artifacts: new adapters.FileArtifactStore({ root: join(f.root, '.deckent', 'artifacts'), maxBytes: config.artifacts.maxBytes }) });
      await expect(manager.observe(request)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
      await expect(manager.release(request)).rejects.toThrow();
      expect(runtime).toHaveBeenCalledOnce();
      expect((await f.records()).custody).toEqual(custody);
    } finally { stored.store.close(); }
    expect(await readConfiguredBeuserReport(f.root, 'scope', undefined, f.options)).toEqual(report);
    for (const language of ['tr', 'en'] as const) {
      const text = formatBeuserReport(report, { locale: language, json: false });
      expect(text).toContain('BEUSER_CANDIDATE_MISMATCH'); expect(text).not.toContain(f.root); expect(text).not.toContain(f.candidate);
    }
  } finally { await f.dispose(); }
});

it.skipIf(process.platform !== 'linux')('carries real driver look/argv failures through the production harness and report while rejecting arbitrary error codes', async () => {
  for (const scenario of [{ mode: 'pty', state: 'unavailable', code: 'BEUSER_SURFACE_UNAVAILABLE' },
    { mode: 'argv', state: 'secret', code: 'BEUSER_CAPTURE_BLOCKED' }, { mode: 'pty', state: 'forged', code: 'unknown' }] as const) {
    const f = await reportFixture(scenario.mode), commands: string[] = [];
    try {
      vi.spyOn(adapters, 'createBeuserRealm').mockImplementation(input => new BeuserRealmApplication({
        async create(ctx, publish) { const handle = { binding: ctx.binding, incarnation: '12345678-1234-4234-8234-123456789abc', containerId: 'a'.repeat(64),
          controlDirectory: input.options.controllerRoot, controlIdentity: 'fixture-owned' }; await publish(handle); return handle; },
        async inspect() { return { valid: true, evidenceRefs: ['fixture-containment'] }; },
        async remove() { return { processesAbsent: false, cgroupAbsent: false, filesystemAbsent: false, evidenceRefs: [] }; },
      }, input.custody));
      vi.spyOn(adapters, 'createBeuserChannel').mockImplementation(input => ({ binding: input.context.binding,
        verify: async () => {}, cancel: async () => {}, async open() {
          if (scenario.state === 'forged') throw Object.assign(new Error('/private credential=hidden'), { code: 'BEUSER_CAPTURE_BLOCKED' });
          const output = new PassThrough(), sink = new Writable({ write(chunk, _encoding, done) {
            const command = JSON.parse(String(chunk)); commands.push(command.op);
            output.write(JSON.stringify({ id: command.id, data: Buffer.from('/private credential=hidden').toString('base64'),
              state: scenario.state, exitCode: null, columns: 80, rows: 24 }) + '\n'); done();
          } });
          return { input: sink, output, cancel: async () => {} };
        } }));
      const report = await walkConfiguredBeuser(f.root, { scopeId: 'scope', journey: 'journey', candidate: f.candidate }, f.options);
      expect(report).toMatchObject({ counts: { selected: 1, walked: 0 }, unknown: [{ branch: 'persona', reason: scenario.code },
        { branch: 'persona', reason: 'BEUSER_CLEANUP_UNPROVEN' }] });
      expect(commands).toEqual(scenario.state === 'forged' ? [] : [scenario.mode === 'argv' ? 'argv' : 'read']);
      const { terminal } = await f.records();
      expect(terminal).toMatchObject({ reason: scenario.code, cleanup: 'unknown', result: { result: { kind: 'unknown', reasonCode: scenario.code }, interrupted: false } });
      expect(await readConfiguredBeuserReport(f.root, 'scope', undefined, f.options)).toEqual(report);
      for (const language of ['tr', 'en'] as const) {
        const text = formatBeuserReport(report, { locale: language, json: false });
        if (scenario.state !== 'forged') expect(text).toContain(ErrorRegistry.get(scenario.code, language)!.message);
        expect(text).not.toContain('/private'); expect(text).not.toContain('hidden');
      }
      expect(JSON.stringify({ report, terminal })).not.toContain('/private'); expect(JSON.stringify({ report, terminal })).not.toContain('hidden');
    } finally { await f.dispose(); }
  }
});


it.skipIf(process.platform !== 'linux')('setup and admission refuse a controller executable before any realm can start or configuration can be installed', async () => {
  const f = await reportFixture();
  try {
    const configPath = join(f.root, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    const invalid = config.admission;
    invalid.registry.profiles[0].parameters.entry.nodeExecutable = '/controller/runtime/bin/node';
    const profilePath = join(f.root, 'host-runtime-profile.json');
    await writeFile(profilePath, JSON.stringify(invalid));
    const create = vi.spyOn(adapters.DockerBeuserRealmRuntime.prototype, 'create');
    // Host attestation is the only witness fixture; no approval is bypassed: invalid input must be refused before a write/card exists.
    vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    const before = await readFile(configPath, 'utf8');
    await expect(setupConfiguredBeuser(f.root, { scopeId: 'scope', profile: profilePath, apply: true }, f.options))
      .rejects.toMatchObject({ code: 'BEUSER_INPUT_INVALID' });
    expect(await readFile(configPath, 'utf8')).toBe(before);
    config.admission = invalid;
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    await expect(admitConfiguredBeuserWalk(f.root, { scopeId: 'scope', journey: 'journey', candidate: f.candidate }, f.options))
      .rejects.toMatchObject({ code: 'BEUSER_INPUT_INVALID' });
    expect(create).not.toHaveBeenCalled();
    expect(() => validateBeuserSupervisorProfile({ schemaVersion: 1, adapterId: 'beuser', adapterVersion: 1,
      parameters: invalid.registry.profiles[0].parameters })).toThrow('BEUSER_INPUT_INVALID');
  } finally { await f.dispose(); }
});

it.skipIf(process.platform !== 'linux')('walk14: a stuck persona keeps redacted action artifacts and a named RED finding with proven or unknown cleanup', async () => {
  for (const cleanupProven of [false, true]) {
    // Profile v3: the installed start state is arranged through the production arrange adapter (substituted Docker transport) before the first look.
    const f = await reportFixture('pty', { schemaVersion: 2, catalogRevision: engine.BEUSER_ARRANGE_REGISTRY.revision, states: ['T1', 'cancel'] });
    try {
      vi.spyOn(platform, 'getConfigKnownSecrets').mockReturnValue(platform.snapshotKnownSecrets([{ name: 'FIXTURE', value: 'fixture-private' }]));
      const arrangeCalls: string[][] = [], createArrange = adapters.createBeuserArrange;
      vi.spyOn(adapters, 'createBeuserArrange').mockImplementation(input => createArrange({ ...input, command: async args => { arrangeCalls.push([...args]);
        return JSON.stringify(args.includes('--workdir') ? { exitCode: 0, stdoutBytes: 0, stdoutDigest: sha256('') } : 'installed'); } }));
      const evidenceRows: string[] = [], createEvidence = engine.createBeuserEvidencePort;
      vi.spyOn(engine, 'createBeuserEvidencePort').mockImplementation((...args) => { const port = createEvidence(...args);
        return { ...port, async append(ctx, entry) { evidenceRows.push(`${entry.kind}:${entry.evidenceRef}`); return port.append(ctx, entry); } }; });
      vi.spyOn(adapters, 'createBeuserRealm').mockImplementation(input => new BeuserRealmApplication({
        async create(ctx, publish) { const handle = { binding: ctx.binding, incarnation: '12345678-1234-4234-8234-123456789abc', containerId: 'a'.repeat(64),
          controlDirectory: input.options.controllerRoot, controlIdentity: 'fixture-owned' }; await publish(handle); return handle; },
        async inspect() { return { valid: true, evidenceRefs: ['fixture-containment'] }; },
        async remove() { return { processesAbsent: cleanupProven, cgroupAbsent: cleanupProven, filesystemAbsent: cleanupProven, evidenceRefs: cleanupProven ? ['fixture-absence'] : [] }; },
      }, input.custody));
      const keys: string[] = [];
      vi.spyOn(adapters, 'createBeuserChannel').mockImplementation(input => ({ binding: input.context.binding,
        verify: async () => {}, cancel: async () => {}, async open() {
          const output = new PassThrough(), sink = new Writable({ write(chunk, _encoding, done) {
            const command = JSON.parse(String(chunk));
            if (command.op === 'input') keys.push(command.text);
            output.write(JSON.stringify({ id: command.id, data: Buffer.from('\x1b[2J\x1b[HPermissions card: credential=fixture-private').toString('base64'),
              state: 'ready', exitCode: null, columns: 80, rows: 24 }) + '\n'); done();
          } });
          return { input: sink, output, cancel: async () => {} };
        } }));
      // External model I/O only: real decode/controller/realm custody/dispatch/report below. Each walker decision takes `settleMs` (walk19R).
      const clock = performance.now.bind(performance); let skew = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock() + skew);
      const model = vi.spyOn(engine, 'createBeuserModelPort').mockReturnValue({
        walker: vi.fn(async () => { skew += engine.BEUSER_WALK_RULES.settleMs; return { state: 'invoked', receipt: { role: 'beuser-walker', maker: 'fixture-walker', invocation: {
          receipt: { outcome: { state: 'responded' } }, response: { native: { choices: [{ message: { content: '{"kind":"type","text":"fixture-private"}' } }] } },
        } } }; }), evaluate: vi.fn(), cancel: vi.fn(),
      } as unknown as ReturnType<typeof engine.createBeuserModelPort>);
      const report = await walkConfiguredBeuser(f.root, { scopeId: 'scope', journey: 'journey', candidate: f.candidate }, f.options);
      // Walk17 S2: the second identical repeat on an unchanged screen stops before a third effect, after (walk19R) one more read of that screen.
      expect(keys).toEqual(['fixture-private', 'fixture-private']);
      expect(model).toHaveBeenCalled();
      expect(report).toMatchObject({ counts: { walked: 1 }, findings: [{ branch: 'persona', persona: 'person', code: 'persona-stuck', outcome: 'RED', reason: 'loop' }],
        unknown: cleanupProven ? [] : [{ branch: 'persona', reason: 'BEUSER_CLEANUP_UNPROVEN' }], reliability: { completed: 0, attempted: 1 } });
      const { terminal } = await f.records();
      expect(terminal).toMatchObject({ reason: 'loop', cleanup: cleanupProven ? 'destroyed' : 'unknown', evidence: null });
      // First look, then per typed text its walk20 guard read and the input, then the stop's read.
      expect(terminal.diagnostic.trace.map((row: { kind: string }) => row.kind)).toEqual(['arrange', ...Array(6).fill(['action', 'screen']).flat(), 'friction']);
      expect(arrangeCalls.map(args => args.includes('--workdir'))).toEqual([true, false]);
      expect(report.unarranged).toEqual([{ branch: 'persona', state: 'cancel', reason: 'persona' }]);
      // Persona evidence is the surface's own screens, never the arrange row that shifted the recorder sequence.
      expect(evidenceRows.length).toBeGreaterThan(0);
      for (const row of evidenceRows) expect(row).toMatch(/^screen:[^:]+:\d+$/u);
      const config = await loadComposedConfig(f.root, { ...f.options, heal: false });
      const artifacts = new adapters.FileArtifactStore({ root: join(f.root, '.deckent', 'artifacts'), maxBytes: config.artifacts.maxBytes });
      for (const row of terminal.diagnostic.trace) {
        const digest = row.artifactRef.slice('sha256:'.length);
        const bytes = await readFile(join(f.root, '.deckent', 'artifacts', sha256('scope'), digest));
        const artifact = await artifacts.read('scope', { schemaVersion: 1, scopeId: 'scope', digest, byteLength: bytes.length });
        expect(sha256(artifact)).toBe(digest);
        expect(Buffer.from(artifact).toString()).not.toContain('fixture-private');
        if (row.kind === 'friction') expect(JSON.parse(JSON.parse(Buffer.from(artifact).toString()).text)).toEqual({
          reason: 'loop', screenRef: report.findings?.[0]?.screenRef, proposedAction: { kind: 'type' } });
      }
      expect(report.findings?.[0]?.screen).toContain('Permissions card');
      expect(report.findings?.[0]?.evidenceRefs).toEqual(terminal.diagnostic.trace.filter((row: { kind: string }) => row.kind !== 'arrange').map((row: { artifactRef: string }) => row.artifactRef));
      expect(await readConfiguredBeuserReport(f.root, 'scope', undefined, f.options)).toEqual(report);
      for (const locale of ['tr', 'en'] as const) {
        const text = formatBeuserReport(report, { locale, json: false });
        expect(text).toContain('RED'); expect(text).toContain('Permissions card'); expect(text).toContain('persona');
        expect(text).toContain(platform.t('beuser.report.unarranged', { branch: 'persona', state: 'cancel', reason: platform.t('beuser.report.unarranged.persona', {}, locale) }, locale));
        expect(text).toContain(terminal.diagnostic.trace.at(-1).artifactRef);
      }
      const storage = await openConfiguredAttemptStore(f.root, f.options);
      try {
        const request = { protocolVersion: 1 as const, identity: terminal.binding.identity, workspace: f.candidate, argv: ['--help'] };
        const record = (await storage.store.readDispatch(request))!;
        const manager = recordedExecutionSupervisor(record, { config, layout: config.productLayout, store: storage.store, artifacts });
        expect(await manager.observe(request)).toMatchObject({ result: cleanupProven ? { kind: 'exited', exitCode: 1 } : { kind: 'unknown' } });
        if (cleanupProven) expect(await manager.collectOutputFiles!(request)).toEqual([]);
        else await expect(manager.collectOutputFiles!(request)).rejects.toThrow('SUPERVISOR_NOT_TERMINAL');
        expect(keys).toEqual(['fixture-private', 'fixture-private']);
      } finally { storage.store.close(); }
      expect(JSON.stringify({ report, terminal })).not.toContain('fixture-private');
    } finally { await f.dispose(); }
  }
});
