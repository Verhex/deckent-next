import { expect, it } from 'vitest';
import { createInstallationEvidencePreview, InstallationPreviewApplication, InstallationPublicationApplication, installationPublishTargets,
  type InstallationEvidencePreview, type PreparedInstallation } from '#engine/core/installation/index.js';
import { encodeBootstrapJournal, type BootstrapJournalPayload, type BootstrapObservation } from '#platform/core/bootstrap-state/index.js';
import { installationProfile } from '../support/installation-profile.js';

const image = `sha256:${'a'.repeat(64)}`;
async function prepared(): Promise<PreparedInstallation> {
  return new InstallationPreviewApplication({
    async resolvePaths(_root, config) { return { config: { ...config, normalized: 'private' }, layout: { schemaVersion: 2, revision: 'layout-1',
      root: '/project/.deckent', bootstrapConfigPath: '/project/.deckent/config.json' },
    paths: { config: '/project/.deckent/config.json', policy: '/project/.deckent/policy.json', ledger: '/project/.deckent/state/ledger.db' } }; },
    validateProfile(profile) { return { imageId: String(profile.parameters.imageId) }; }, validateEvaluator() { return undefined; },
  }).prepare('/project', installationProfile({ images: [image] }), { principal: { issuer: 'fixture-issuer', subject: 'fixture-subject' }, allowShutdown: false });
}
function evidence(source: PreparedInstallation, measurementDigest = 'c'.repeat(64)): InstallationEvidencePreview {
  return createInstallationEvidencePreview(source.preview, { name: 'deckent', version: '1', measurementDigest, fileCount: 1,
    totalBytes: 1, missingDeclarations: [], source: 'installed-bytes', dependencyCoverage: 'excluded' }, source.preview.images.map(value => ({
    imageId: value.imageId, endpoint: 'unix:///run/user/1000/docker.sock', daemonId: 'daemon-a', status: 'locally-available' })));
}
function consent(source: PreparedInstallation, observed: InstallationEvidencePreview, id = 'operator-choice') {
  return { schemaVersion: 1 as const, mode: 'operator-custom' as const, id, atMs: 1, proposalDigest: observed.proposalDigest, principal: source.preview.principal };
}

function memoryPorts(source: PreparedInstallation, observed: InstallationEvidencePreview) {
  let serial = 0; let state: BootstrapObservation = Object.freeze({ generation: 'absent', record: null });
  const effects = new Map<string, { digest: string; transactionId: string }>(), writes: BootstrapJournalPayload[] = [];
  let publishes = 0, verifies = 0, crashAfterEffect = false, evidenceChecks = 0, changeAfterEvidenceChecks: number | null = null,
    mutateOnVerify: number | null = null, clock: () => number = () => 2;
  const journal = {
    async observe() { return state; },
    async write(expected: BootstrapObservation, next: BootstrapJournalPayload) {
      if (expected.generation !== state.generation) throw new Error('STALE_JOURNAL');
      const record = JSON.parse(encodeBootstrapJournal(next)); writes.push(next);
      state = Object.freeze({ generation: `journal-${++serial}`, record }); return state;
    },
  };
  const ports = {
    journal,
    async inspectPreimage(target: { path: string }) { return effects.get(target.path)?.digest ?? null; },
    async publish(target: { path: string; digest: string }, transactionId: string) {
      publishes++; const prior = effects.get(target.path);
      if (prior && prior.digest !== target.digest) throw new Error('DIFFERENT_EFFECT');
      effects.set(target.path, { digest: target.digest, transactionId });
      if (crashAfterEffect) { crashAfterEffect = false; throw new Error('CRASH_AFTER_EFFECT'); }
    },
    async verify(target: { path: string; digest: string }, transactionId: string) {
      verifies++; expect(effects.get(target.path)).toEqual({ digest: target.digest, transactionId });
      if (mutateOnVerify === verifies) changeAfterEvidenceChecks = evidenceChecks;
    },
    async revalidateEvidence() {
      evidenceChecks++;
      return changeAfterEvidenceChecks !== null && evidenceChecks > changeAfterEvidenceChecks
        ? evidence(source, 'd'.repeat(64)) : observed;
    },
    now() { return clock(); },
  };
  return { ports, effects, writes, setClock(next: () => number) { clock = next; }, get state() { return state; }, get publishes() { return publishes; }, get verifies() { return verifies; },
    crash() { crashAfterEffect = true; }, changeEvidence(afterChecks = 0) { changeAfterEvidenceChecks = afterChecks; },
    mutateDuringFinalVerify(atVerify: number) { mutateOnVerify = atVerify; }, resetCalls() { publishes = 0; verifies = 0; },
    replace(payload: BootstrapJournalPayload) { const record = JSON.parse(encodeBootstrapJournal(payload)); state = Object.freeze({ generation: `journal-${++serial}`, record }); } };
}

it('writes recoverable pending state before effects and resumes an exact prior effect after a crash', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  memory.crash(); const application = new InstallationPublicationApplication(memory.ports);
  await expect(application.apply(source, observed, agreed)).rejects.toThrow('CRASH_AFTER_EFFECT');
  expect(memory.writes[0]!.phase).toBe('pending'); expect(memory.writes[0]!.recovery).toMatchObject({ consent: agreed, material: { configuration: { normalized: 'private' } } });
  expect(memory.writes[0]!.resources.every(resource => resource.state === 'pending')).toBe(true);
  expect(memory.effects.size).toBe(1);
  await expect(application.apply(source, observed, agreed)).resolves.toMatchObject({ status: 'installed', proposalDigest: observed.proposalDigest });
  expect(memory.state.record).toMatchObject({ phase: 'committed', blockers: [], resources: [{ state: 'published' }, { state: 'published' }, { state: 'published' }] });
});

it('accepts exact pre-existing config and policy bytes but refuses foreign or occupied ledger targets before a first journal', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed);
  const exact = memoryPorts(source, observed), targets = new InstallationPublicationApplication(exact.ports);
  const expected = installationPublishTargets(source, observed, agreed.id);
  for (const target of expected.filter(target => target.resource !== 'ledger')) exact.effects.set(target.path, { digest: target.digest, transactionId: 'prior-owner' });
  await expect(targets.apply(source, observed, agreed)).resolves.toMatchObject({ status: 'installed' });
  expect(exact.writes[0]!.resources).toEqual(expect.arrayContaining(expected.filter(target => target.resource !== 'ledger')
    .map(target => expect.objectContaining({ resource: target.resource, preimageDigest: target.digest }))));
  expect(exact.writes[0]!.resources).toEqual(expect.arrayContaining([expect.objectContaining({ resource: 'ledger', preimageDigest: null })]));

  const foreignSource = await prepared(), foreignObserved = evidence(foreignSource), memory = memoryPorts(foreignSource, foreignObserved);
  memory.effects.set(foreignSource.material.paths.policy!, { digest: 'foreign', transactionId: 'foreign' });
  await expect(new InstallationPublicationApplication(memory.ports).apply(foreignSource, foreignObserved, consent(foreignSource, foreignObserved)))
    .rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(memory.writes).toEqual([]);

  const occupiedLedger = memoryPorts(foreignSource, foreignObserved);
  occupiedLedger.effects.set(foreignSource.material.paths.ledger!, { digest: expected.find(target => target.resource === 'ledger')!.digest, transactionId: 'prior-owner' });
  await expect(new InstallationPublicationApplication(occupiedLedger.ports).apply(foreignSource, foreignObserved, consent(foreignSource, foreignObserved)))
    .rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(occupiedLedger.writes).toEqual([]);
});

it('does not commit when live evidence changes and committed replay verifies without publishing', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  const application = new InstallationPublicationApplication(memory.ports); memory.changeEvidence(2);
  await expect(application.apply(source, observed, agreed)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  expect(memory.state.record).toMatchObject({ phase: 'pending' });

  const stable = memoryPorts(source, observed), stableApplication = new InstallationPublicationApplication(stable.ports);
  await stableApplication.apply(source, observed, agreed); stable.resetCalls();
  await expect(stableApplication.apply(source, observed, agreed)).resolves.toMatchObject({ status: 'replayed' });
  expect(stable.publishes).toBe(0); expect(stable.verifies).toBe(3);
});

it('revalidates evidence after final verification before committing or replaying', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  const application = new InstallationPublicationApplication(memory.ports);
  memory.mutateDuringFinalVerify(6);
  await expect(application.apply(source, observed, agreed)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  expect(memory.state.record).toMatchObject({ phase: 'pending' });

  const committed = memoryPorts(source, observed), replay = new InstallationPublicationApplication(committed.ports);
  await replay.apply(source, observed, agreed); committed.resetCalls(); committed.mutateDuringFinalVerify(3);
  await expect(replay.apply(source, observed, agreed)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  expect(committed.state.record).toMatchObject({ phase: 'committed' });
});

it('rejects changed proposal, consent, and stored resource target recovery conflicts', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  const application = new InstallationPublicationApplication(memory.ports); await application.apply(source, observed, agreed);
  const changed = evidence(source, 'd'.repeat(64));
  await expect(application.apply(source, changed, consent(source, changed))).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  await expect(application.apply(source, observed, consent(source, observed, 'another-choice'))).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  const { checksum: ignored, ...payload } = memory.state.record!; void ignored;
  memory.replace({ ...payload, resources: payload.resources.map(resource => resource.resource === 'policy' ? { ...resource, path: '/other/policy.json' } : resource) });
  await expect(application.apply(source, observed, agreed)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
});

// SECRET-WRITE-CLOCK (proof/SECRET-WRITE-FLAKE-2026-10-01): same writer-side ordering as the policy-template path; TIME_ORDER stays exact.
const sequence = (...values: number[]) => () => values.length > 1 ? values.shift()! : values[0]!;
const T = 1_790_000_000_000;

it('a wall clock stepping back after the pending entry still installs; every journal write keeps updatedAtMs >= createdAtMs', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  memory.setClock(sequence(T, T - 1)); // pending at T, then three published updates and the commit read T - 1
  await expect(new InstallationPublicationApplication(memory.ports).apply(source, observed, agreed)).resolves.toMatchObject({ status: 'installed' });
  expect(memory.writes).toHaveLength(5);
  expect(memory.writes.every(write => write.createdAtMs === T && write.updatedAtMs >= write.createdAtMs)).toBe(true);
  expect(memory.state.record).toMatchObject({ phase: 'committed', createdAtMs: T, updatedAtMs: T, blockers: [] });
});

it('a recovery in another process whose clock is behind the persisted createdAtMs completes the pending installation', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  memory.setClock(() => T); memory.crash();
  await expect(new InstallationPublicationApplication(memory.ports).apply(source, observed, agreed)).rejects.toThrow('CRASH_AFTER_EFFECT');
  expect(memory.state.record).toMatchObject({ phase: 'pending', createdAtMs: T, updatedAtMs: T });
  memory.setClock(() => T - 1000);
  await expect(new InstallationPublicationApplication(memory.ports).apply(source, observed, agreed)).resolves.toMatchObject({ status: 'installed' });
  expect(memory.state.record).toMatchObject({ phase: 'committed', createdAtMs: T, updatedAtMs: T });
});

it('control: a forward-moving clock is recorded as observed, and an invalid clock sample is still refused', async () => {
  const source = await prepared(), observed = evidence(source), agreed = consent(source, observed), memory = memoryPorts(source, observed);
  memory.setClock(sequence(T, T + 10, T + 20, T + 30, T + 40));
  await new InstallationPublicationApplication(memory.ports).apply(source, observed, agreed);
  expect(memory.writes.map(write => write.updatedAtMs)).toEqual([T, T + 10, T + 20, T + 30, T + 40]);

  const invalid = memoryPorts(source, observed);
  invalid.setClock(sequence(T, Number.NaN));
  await expect(new InstallationPublicationApplication(invalid.ports).apply(source, observed, agreed)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_INVALID' });
  expect(invalid.state.record).toMatchObject({ phase: 'pending', updatedAtMs: T });
});
