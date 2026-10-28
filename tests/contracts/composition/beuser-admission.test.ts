import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { admitConfiguredBeuserWalk, readConfiguredBeuserReport } from '#composition/core/beuser/index.js';
import { reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { measureInstalledPackage, beuserPrivateRecord } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY, beuserEvaluatorFor, createBeuserReport } from '#engine/index.js';
import { sha256, clearConfigCache } from '#platform/index.js';

it.skipIf(process.platform !== 'linux')('dry admission seals real Run criteria and reserves the exact Task-bound Attempt without a realm or model call', async () => {
  const base = await mkdtemp(join(tmpdir(), 'beuser-admission-')), root = join(base, 'project'), candidate = join(base, 'candidate');
  try {
    await mkdir(root); await mkdir(candidate); await mkdir(join(candidate, 'dist'));
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'test-candidate', version: '1.0.0', files: ['dist'] }));
    await writeFile(join(candidate, 'dist', 'entry.js'), 'export {};\n');
    const options = { env: { HOME: join(base, 'home'), USERPROFILE: join(base, 'home') } };
    await applyPolicyTemplateInstallation(root, 'scope', options);
    const storage = await openConfiguredAttemptStore(root, options);
    const max = { maxFiles: 100, maxFileBytes: 100000, maxTotalBytes: 1000000, maxDepth: 10 };
    const measured = await measureInstalledPackage(candidate, max), files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    const summary = { schemaVersion: 1, personaId: 'person', journeyId: 'journey', language: 'tr', role: 'buyer', goals: ['purchase'],
      knowledgeBoundary: [], accessibility: [], initialKnowledge: [], goal: 'request goods', competency: { computer: 1, domain: 4, product: 0 },
      preferences: [], riskAttitude: 'cautious', surface: 'terminal', organizationContext: {}, patience: { maxSteps: 4, maxWaitMs: 100 }, attentionMs: 1000 };
    const calibration = { revision: 'r', cohort: 'cohort', trapHits: 0, trapTotal: 0, falseRed: 0, goodTotal: 0, minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 };
    const binding = { schemaVersion: 1, identity: { scopeId: 'untrusted', runId: 'untrusted', taskId: 'untrusted', attemptId: 'untrusted', layoutRevision: 'untrusted', generation: 1 },
      candidate: { adapter: 'installed-package', version: '1.0.0', evidenceRef: 'package', stateDigest: sha256(JSON.stringify(files)), environmentDigest: 'b'.repeat(64) },
      candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64), realmId: 'untrusted', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'untrusted' };
    const parameters = { schemaVersion: 1, binding, summary, limitsRevision: BEUSER_LIMITS_REGISTRY.profiles[0]!.revision, candidateRoot: candidate, packageDigest: measured.measurementDigest,
      files, size: { columns: 80, rows: 24, scrollback: 100 }, bounds: { quietMs: 10, inactivityMs: 100, maxInputBytes: 1024 }, completionTokens: 1024,
      rubric: { schemaVersion: 1, journeyId: 'journey', version: 1, digest: 'f'.repeat(64), parameters: {} },
      choices: { 'beuser-walker': { channelId: 'configured', modelId: 'walker' }, 'beuser-evaluator': { channelId: 'configured', modelId: 'evaluator' } },
      contributorModels: [{ vendorId: 'source-maker' }], entry: { mode: 'pty', nodeExecutable: '/usr/bin/node', args: ['--help'] },
      probes: [{ id: 'installation', dimension: 'outcome', readbackRef: 'readback', key: 'installation', expected: 'installed' }], calibration };
    const configPath = join(root, '.deckent', 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.admission = { poolId: 'pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'beuser-fixture',
      profiles: [{ id: 'persona', version: 1, adapter: { id: 'beuser', version: 1 }, parameters }], kinds: [{ kind: 'journey', profile: { id: 'persona', version: 1 }, workspaceDelivery: 'none' }],
      evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } };
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    try { await storage.store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { storage.store.close(); }
    const admitted = await admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'journey', candidate }, options);
    expect(admitted.principal).toEqual(beuserEvaluatorFor(admitted.c.principal, 'scope'));
    const definition = admitted.definitions[0]!;
    expect(definition.binding.identity).toMatchObject({ scopeId: 'scope', runId: admitted.runId, taskId: 'persona', generation: 1 });
    expect(definition.binding.identity.attemptId).not.toBe('untrusted');
    const reservation = await reserveConfiguredRunTasks(root, { schemaVersion: 1, commandId: 'reserve', scopeId: 'scope', runId: admitted.runId, expectedRevision: 0 }, options,
      taskId => admitted.definitions.find(row => row.binding.identity.taskId === taskId)!.binding.identity.attemptId);
    expect(reservation.reservation.identities).toEqual([definition.binding.identity]);
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
    await writeFile(join(candidate, 'dist', 'entry.js'), 'changed;\n');
    await expect(admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'journey', candidate }, options)).rejects.toMatchObject({ code: 'BEUSER_INPUT_INVALID' });
    // A foreign candidate is refused before creating another Run, without a verify=true test adapter.
    await expect(admitConfiguredBeuserWalk(root, { scopeId: 'scope', journey: 'journey', candidate: root }, options)).rejects.toMatchObject({ code: 'BEUSER_INPUT_INVALID' });
  } finally { clearConfigCache(); await rm(base, { recursive: true, force: true }); }
});
