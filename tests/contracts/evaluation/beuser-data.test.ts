import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import personas from '../../../assets/beuser/personas.json' with { type: 'json' };
import uninstall from '../../../assets/beuser/journeys/uninstall-v2.json' with { type: 'json' };
import onboarding from '../../../assets/beuser/journeys/onboarding.json' with { type: 'json' };
import self from '../../../assets/beuser/journeys/beuser-self.json' with { type: 'json' };
import manifest from '../../../assets/beuser/calibration/manifest.json' with { type: 'json' };
import good from '../../../assets/beuser/calibration/known-good.json' with { type: 'json' };
import bad from '../../../assets/beuser/calibration/known-bad.json' with { type: 'json' };
import { beuserBindingSchema, beuserSealedRubricSchema } from '#domain/core/beuser/index.js';
import { pinBeuserWalkerSummary, BEUSER_LIMITS_REGISTRY, BEUSER_ARRANGE_REGISTRY, beuserArrangeRegistrySchema, beuserArrangePlan } from '#engine/core/beuser-contract/index.js';
import { beuserJourneyProfileSchema } from '#composition/core/supervisors/index.js';
import { BEUSER_REALM_RECIPE } from '#adapters/core/beuser-realm/index.js';
import arrange from '../../../assets/beuser/arrange.json' with { type: 'json' };
import { beuserReliabilityPolicySchema } from '#engine/core/beuser/index.js';
import { beuserCalibrationSchema, beuserDigest, beuserReadbackSchema, beuserParametersSchema,
  beuserEvidenceSchema, evaluateBeuserEvidence } from '#capabilities/core/evaluation-evidence/index.js';

const journeys = [uninstall, onboarding, self];
// Test-only binding. No candidate, realm, Run, receipt or model invocation is created.
const binding = beuserBindingSchema.parse({ schemaVersion: 1,
  identity: { scopeId: 'fixture-scope', runId: 'fixture-run', taskId: 'fixture-task', attemptId: 'fixture-attempt', layoutRevision: 'fixture', generation: 1 },
  candidate: { adapter: 'fixture', version: 'fixture', evidenceRef: 'fixture', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
  candidateDigest: 'a'.repeat(64), personaDigest: 'b'.repeat(64), journeyDigest: 'c'.repeat(64), rubricDigest: 'd'.repeat(64),
  realmId: 'fixture-realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'fixture-transcript' });

function parameters(probes: unknown, calibration: unknown = manifest.calibration) {
  return beuserParametersSchema.parse({ binding, producer: { owner: 'fixture-harness', profileDigest: 'e'.repeat(64) },
    fileName: 'fixture-evidence', dimension: 'outcome', probes, calibration });
}

it('loads all seven assets through frozen C1/C5 parsers and resolves every persona, profile, branch and probe set', () => {
  const profile = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === personas.limitsProfile);
  expect(profile).toBeDefined();
  expect(new Set(personas.personas.map(row => row.personaId)).size).toBe(personas.personas.length);
  expect(personas.personas.find(row => row.personaId === 'ayse')?.patience.maxWaitMs).toBe(45000);
  expect(personas.personas.find(row => row.personaId === 'mert')?.patience.maxWaitMs).toBe(30000);
  for (const input of personas.personas) {
    const summary = pinBeuserWalkerSummary(input);
    // Walk20: each decision may cost a guard read plus its action; the first look and a stop's read come on top.
    expect(2 * summary.patience.maxSteps + 2).toBeLessThanOrEqual(profile!.maxSteps);
    expect(summary.patience.maxWaitMs).toBeLessThanOrEqual(profile!.maxWaitMs);
    expect(summary.organizationContext).toMatchObject({ installationRole: 'synthetic-person', scope: 'own-disposable-installation' });
  }
  for (const journey of journeys) {
    expect(journey.schemaVersion).toBe(1);
    expect(journey.limitsProfile).toBe(profile!.revision);
    const rubric = beuserSealedRubricSchema.parse(journey.rubric);
    expect(rubric.journeyId).toBe(journey.journeyId);
    expect(rubric.digest).toBe(beuserDigest(rubric.parameters));
    const control = journey.rubric.parameters;
    expect(control.ownerSteps).toBe(0);
    expect(control.personDecisions).toBe('synthetic-person-decision');
    expect(new Set(journey.branches.map(row => row.id)).size).toBe(journey.branches.length);
    expect(control.branches.map(row => row.id)).toEqual(journey.branches.map(row => row.id));
    expect(new Set(control.probeSets.map(row => row.id)).size).toBe(control.probeSets.length);
    for (const row of control.probeSets) parameters(row.probes);
    for (const row of control.branches) {
      expect(control.probeSets.some(set => set.id === row.probeSet)).toBe(true);
      expect(row.walkStatus).toBe('not-walked');
      for (const missing of row.unavailable) {
        expect(missing.status).toBe('unknown');
        expect(missing.variants.length).toBeGreaterThan(0);
        expect(missing.variants.every(variant => row.variants.includes(variant))).toBe(true);
      }
    }
    for (const branch of journey.branches) {
      expect(Object.keys(branch.goal).sort()).toEqual(['en', 'tr']);
      expect(branch.personaIds.length).toBeGreaterThan(0);
      for (const id of branch.personaIds) {
        const person = personas.personas.find(row => row.personaId === id);
        expect(person, `${branch.id}:${id}`).toBeDefined();
        for (const language of ['tr', 'en'] as const) {
          pinBeuserWalkerSummary({ ...person, journeyId: journey.journeyId, language, goal: branch.goal[language] });
        }
      }
    }
  }
  beuserCalibrationSchema.parse(manifest.calibration);
  beuserReliabilityPolicySchema.parse(manifest.reliabilityPolicy);
});

it('retains the entire uninstall and onboarding catalogs, explicit unknown variants, bounded self journey and catalogued v3 start states', () => {
  expect(uninstall.branches.map(row => row.id)).toEqual(Array.from({ length: 23 }, (_, index) => `U-B${index + 1}`));
  expect(uninstall.rubric.parameters.requiredBranches).toEqual(uninstall.branches.slice(0, 13).map(row => row.id));
  expect(uninstall.rubric.parameters.initialStateCatalog.map(row => row.id)).toEqual([
    'S1', 'S2', 'S3', 'S4', 'S4b', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10a', 'S10b', 'S11', 'S12', 'S13', 'S14', 'S14b',
    'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25',
  ]);
  const controls = uninstall.rubric.parameters.branches;
  expect(controls.filter(row => row.unavailable.some(item => item.reason === 'O-1-sealed-backup-restore-forbidden')).map(row => row.id))
    .toEqual(['U-B5', 'U-B6', 'U-B8', 'U-B11', 'U-B12', 'U-B13', 'U-B15']);
  for (const id of ['U-B2', 'U-B9', 'U-B10']) {
    expect(controls.find(row => row.id === id)?.unavailable).toContainEqual(expect.objectContaining({
      reason: 'systemd-realm-not-proven', status: 'unknown', releaseBlocking: false,
    }));
  }
  expect(controls.find(row => row.id === 'U-B23')?.initialStates).toContain('sealed-owner-like-fixture');
  expect(uninstall.rubric.parameters.blindBaseline).toMatchObject({ sourceSha: '4d84151c5', stageId: '4d84151c5e3b-1586e6b549a3', patchOldPackage: false });
  expect(uninstall.rubric.parameters.blindBaseline.defects.map(row => row.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
  expect(onboarding.rubric.parameters.branches.flatMap(row => row.initialStates)).toEqual(expect.arrayContaining([
    'model-unavailable', 'local-only', 'external-model-denied', 'price-pending', 'role-pending', 'budget-missing', 'budget-exhausted',
    'image-preparing', 'docker-unavailable', 'realm-unavailable', 'cancel', 'network-interrupted', 'worker-question', 'existing-folder',
    'other-company-scope', 'tr', 'en', 'narrow-terminal', 'line-mode', 'screen-reader',
  ]));
  expect(onboarding.rubric.parameters.branches[0]!.variants).toContain('reopen');
  expect(onboarding.rubric.parameters.workerBoundary).toBe('actual-worker-execution-and-durable-target-readback-not-terminal-fallback');
  expect(self.rubric.parameters.recursion).toMatchObject({ maxDepth: 1, selfInChildCohort: false });
  expect(self.rubric.parameters.recursion.childJourneyIds).toEqual(['uninstall-v2', 'onboarding']);
  {
    const person = personas.personas[0]!, branch = onboarding.branches[0]!;
    const v2 = { schemaVersion: 2, binding, summary: { ...person, journeyId: onboarding.journeyId, goal: branch.goal.tr }, limitsRevision: BEUSER_LIMITS_REGISTRY.profiles[0]!.revision,
      candidateRoot: '/fixture/candidate', packageDigest: 'a'.repeat(64), candidateManifest: { sha256: 'a'.repeat(64), fileCount: 3, sourceCommit: '1'.repeat(40), sourceTreeSha256: 'b'.repeat(64), version: 'fixture' },
      size: { columns: 80, rows: 24, scrollback: 100 }, bounds: { quietMs: 10, inactivityMs: 100, maxInputBytes: 1024 }, completionTokens: 1024, rubric: onboarding.rubric,
      choices: { 'beuser-walker': { channelId: 'c', modelId: 'w' }, 'beuser-evaluator': { channelId: 'c', modelId: 'e' } }, contributorModels: [{ vendorId: 'maker' }],
      entry: { mode: 'pty', nodeExecutable: BEUSER_REALM_RECIPE.nodeExecutable, args: [] },
      probes: [{ id: 'installation', dimension: 'outcome', readbackRef: 'terminal-state', key: 'installation', expected: 'installed' }], calibration: manifest.calibration };
    const startState = { schemaVersion: 2, catalogRevision: BEUSER_ARRANGE_REGISTRY.revision, states: ['T1'] };
    const ok = (value: object) => beuserJourneyProfileSchema.safeParse(value).success;
    expect(ok(v2)).toBe(true);
    expect(ok({ ...v2, schemaVersion: 3, startState })).toBe(true);
    expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, states: [] } })).toBe(true);
    expect(ok({ ...v2, startState })).toBe(false);
    expect(ok({ ...v2, schemaVersion: 3 })).toBe(false);
    for (const states of [['missing'], ['T1', 'T1'], [{ id: 'installed', version: 1 }]])
      expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, states } })).toBe(false);
    expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, catalogRevision: 'other' } })).toBe(false);
    expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, steps: [{ id: 'installed', version: 1 }] } })).toBe(false);
    // Profile-fact states hold only for the matching persona (person: tr, no accessibility needs); a mismatch is an invalid profile.
    expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, states: ['fresh-home', 'tr'] } })).toBe(true);
    for (const fact of ['en', 'screen-reader', 'narrow-terminal'])
      expect(ok({ ...v2, schemaVersion: 3, startState: { ...startState, states: ['fresh-home', fact] } })).toBe(false);
    // Every start state every installed journey names is catalogued: arranged steps, typed unknown, a profile fact or the persona's own act.
    for (const journey of journeys) for (const id of [...journey.rubric.parameters.branches.flatMap(row => row.initialStates),
      ...('initialStateCatalog' in journey.rubric.parameters ? journey.rubric.parameters.initialStateCatalog.map(row => row.id) : [])])
      expect(BEUSER_ARRANGE_REGISTRY.states.some(row => row.id === id), id).toBe(true);
    const plan = (states: string[]) => { const value = beuserArrangePlan({ schemaVersion: 2, catalogRevision: BEUSER_ARRANGE_REGISTRY.revision, states });
      return { steps: value.steps.map(step => `${step.kind}:${step.id}`), unarranged: value.unarranged }; };
    expect(plan(['T1', 'S1', 'S10a'])).toEqual({ steps: ['cli:installed', 'check:runtime-stopped', 'file:project-data'], unarranged: [] });
    expect(plan(['T3', 'S10a']).steps).toEqual(['git:git-repository', 'cli:installed', 'file:team-notes', 'git:team-notes-tracked', 'git:team-notes-committed', 'file:project-data']);
    expect(plan(['sealed-owner-like-fixture', 'S2', 'S4']).unarranged).toEqual([{ state: 'S2', reason: 'realm-external' }, { state: 'S4', reason: 'realm-external' }]);
    expect(plan(['fresh-home', 'cancel'])).toEqual({ steps: ['check:installation-absent', 'check:global-home-absent'], unarranged: [{ state: 'cancel', reason: 'persona' }] });
    expect(plan(['T1', 'S17']).unarranged).toEqual([{ state: 'S17', reason: 'driver-limit' }]);
    // Catalog invariants live in code: exact structured CLI tuples, realm-confined fixture paths, a fixed Git subcommand set and resolvable states.
    expect(beuserArrangeRegistrySchema.safeParse(arrange).success).toBe(true);
    const step = arrange.steps[0]!, file = arrange.steps.find(row => row.kind === 'file')!, git = arrange.steps.find(row => row.kind === 'git')!;
    // Each refusal changes one catalogued step in place, so every state still resolves and only the changed field can refuse it.
    const swap = (row: object, change: object) => arrange.steps.map(other => other === row ? { ...row, ...change } : other);
    expect(beuserArrangeRegistrySchema.safeParse({ ...arrange, steps: swap(git, { args: ['commit', '--quiet', '-m', 'note'] }) }).success).toBe(true);
    for (const steps of [swap(step, { args: ['init', '--yes'] }), swap(step, { args: ['init', '--json', 'a\nb'] }), swap(step, { kind: 'shell' }), [...arrange.steps, step],
      swap(file, { path: '/etc/passwd' }), swap(file, { path: '../outside' }), swap(file, { path: 'a/../../b' }), swap(file, { mode: '0o644' }),
      swap(git, { args: ['push', 'origin'] }), swap(git, { args: ['commit', '-c', 'core.hooksPath=/tmp'] }), swap(git, { args: ['add', '--git-dir=/tmp/x'] }),
      swap(step, { cwd: '/tmp' }), swap(step, { readback: { kind: 'path', path: 'relative', expected: { state: 'file' } } })])
      expect(beuserArrangeRegistrySchema.safeParse({ ...arrange, steps }).success).toBe(false);
    expect(beuserArrangeRegistrySchema.safeParse({ ...arrange, states: [{ id: 'T1', steps: [{ id: 'missing', version: 1 }] }] }).success).toBe(false);
  }
});

it('keeps rubric and oracle fields outside strict walker summaries and neutral calibration presentations', () => {
  const hidden = /rubric|oracle|known-good|known-bad|mutant|blindBaseline|D[1-5]|4d84151c5/iu;
  for (const journey of journeys) {
    for (const branch of journey.branches) {
      const person = personas.personas.find(row => row.personaId === branch.personaIds[0])!;
      const input = { ...person, journeyId: journey.journeyId, goal: branch.goal[person.language as 'tr' | 'en'] };
      const visible = pinBeuserWalkerSummary(input);
      expect(JSON.stringify(visible)).not.toMatch(hidden);
      expect(() => pinBeuserWalkerSummary({ ...input, rubric: journey.rubric })).toThrow();
    }
  }
  const cases = [...good.cases, ...bad.cases];
  expect(new Set(cases.map(row => row.id)).size).toBe(cases.length);
  for (const row of cases) {
    expect(Object.keys(row.presentation).sort()).toEqual(['goal', 'screen']);
    expect(Object.keys(row.presentation.goal).sort()).toEqual(['en', 'tr']);
    expect(Object.keys(row.presentation.screen).sort()).toEqual(['en', 'tr']);
    expect(JSON.stringify(row.presentation)).not.toMatch(hidden);
    expect(() => pinBeuserWalkerSummary({ ...personas.personas[0], oracle: row.oracle })).toThrow();
  }
  expect(manifest.access).toMatchObject({ filesAndOracle: 'deterministic-scorer-only', modelInput: 'presentation-only',
    caseIdsVisible: false, fileNamesVisible: false, oracleVisible: false });
});

it('pins calibration bytes and verifies synthetic oracle outcomes without claiming measured calibration', () => {
  expect(manifest.files.map(row => row.fileName)).toEqual(['known-good.json', 'known-bad.json']);
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(`../../../assets/beuser/calibration/${file.fileName}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  expect(manifest.blindSetDigest).toBe(beuserDigest(manifest.files.map(row => ({ fileName: row.fileName, sha256: row.sha256 }))));
  expect(manifest).toMatchObject({ phase: 'preparation-only', calibrationClaim: 'uncalibrated',
    calibration: { trapHits: 0, trapTotal: 0, falseRed: 0, goodTotal: 0, retries: 0 },
    measurement: { hitRate: null, falseRedRate: null, cost: null, elapsedMs: null }, provenance: { independence: 'unknown' } });
  expect(good.synthetic && bad.synthetic).toBe(true);
  expect(good.cases).toHaveLength(3); expect(bad.cases).toHaveLength(5);
  // A calibrated reference fixture exercises the stored answer key; these are not observed model hit counts.
  const fixtureCalibration = { ...manifest.calibration, trapHits: 5, trapTotal: 5, goodTotal: 3 };
  for (const row of [...good.cases, ...bad.cases]) {
    const readback = beuserReadbackSchema.parse({ schemaVersion: 1, binding, evidenceRef: 'terminal-state', atMs: 2, summary: row.oracle.summary });
    const text = JSON.stringify(readback.summary);
    const evidence = beuserEvidenceSchema.parse({ schemaVersion: 1, binding, validity: 'valid', readbacks: [readback],
      transcript: [{ entry: { schemaVersion: 1, binding, sequence: 1, atMs: 2, kind: 'readback', evidenceRef: 'terminal-state', digest: beuserDigest(text) }, text }],
      cleanup: { state: 'destroyed', atMs: 3, evidenceRef: 'fixture-absence' },
      experience: { verdict: 'pass', maker: null, sourceMakers: [null], evidenceRefs: ['terminal-state'] } });
    const result = evaluateBeuserEvidence(parameters(row.oracle.probes, fixtureCalibration), evidence);
    expect(result.dimensions, row.id).toEqual(row.oracle.dimensions);
    expect(result.result?.outcome, row.id).toBe(row.oracle.outcome);
    expect(result.result?.independence).toBe('unknown');
    const uncalibrated = evaluateBeuserEvidence(parameters(row.oracle.probes), evidence);
    expect(uncalibrated.result?.outcome).toBe(row.oracle.outcome === 'RED' ? 'RED' : 'unknown');
  }
});
