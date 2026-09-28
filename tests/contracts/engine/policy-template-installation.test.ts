import { expect, it } from 'vitest';
import { InstallationPublicationError, PolicyTemplateInstallationApplication, preparePolicyTemplateInstallation,
  type PolicyTemplatePublishTarget, type PreparedPolicyTemplateInstallation } from '#engine/core/installation/index.js';
import { encodeBootstrapJournal, type BootstrapJournalPayload, type BootstrapObservation } from '#platform/core/bootstrap-state/index.js';

// SCR-B (owner 2026-09-28, checkpoint option B): a journaled, Docker/pool-free "policy only" installation. Same
// custody discipline as installation-publication.test.ts (fake in-memory journal + effects), narrower resources.
const toolNames = { readToolNames: ['read_file'], scratchToolNames: ['scratch_write'], scratchWriteOperationId: 'workspace.scratch.write',
  editShellToolNames: ['edit_file'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
function prepared(scopeId = 'installation'): PreparedPolicyTemplateInstallation {
  return preparePolicyTemplateInstallation({ scopeId, principal: { issuer: 'host', subject: '1000' },
    paths: { policy: '/project/.deckent/policy.json', bindings: '/project/.deckent/bindings.json' }, toolNames });
}

function memoryPorts() {
  let serial = 0; let state: BootstrapObservation = Object.freeze({ generation: 'absent', record: null });
  const effects = new Map<string, { digest: string; transactionId: string }>(), writes: BootstrapJournalPayload[] = [];
  let publishes = 0, verifies = 0, crashAfterEffect = false;
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
    async inspectPreimage(target: PolicyTemplatePublishTarget) { return effects.get(target.path)?.digest ?? null; },
    async publish(target: PolicyTemplatePublishTarget, transactionId: string) {
      publishes++; const prior = effects.get(target.path);
      if (prior && prior.digest !== target.digest) throw new Error('DIFFERENT_EFFECT');
      effects.set(target.path, { digest: target.digest, transactionId });
      if (crashAfterEffect) { crashAfterEffect = false; throw new Error('CRASH_AFTER_EFFECT'); }
    },
    async verify(target: PolicyTemplatePublishTarget, transactionId: string) {
      verifies++; expect(effects.get(target.path)).toEqual({ digest: target.digest, transactionId });
    },
    now: () => 2,
  };
  return { ports, effects, writes, get state() { return state; }, get publishes() { return publishes; }, get verifies() { return verifies; },
    crash() { crashAfterEffect = true; },
    seed(target: PolicyTemplatePublishTarget, digest: string, transactionId = 'prior-owner') { effects.set(target.path, { digest, transactionId }); } };
}

it('is deterministic: the same scope/principal always yields the same plan and transaction id; a different scope differs', () => {
  expect(prepared().preview.planDigest).toBe(prepared().preview.planDigest);
  expect(prepared().preview.transactionId).toBe(prepared().preview.transactionId);
  expect(prepared('other-scope').preview.planDigest).not.toBe(prepared().preview.planDigest);
});

it('writes a complete pending journal before any effect, then commits after both targets publish', async () => {
  const source = prepared(), memory = memoryPorts();
  const result = await new PolicyTemplateInstallationApplication(memory.ports).apply(source);
  expect(result).toMatchObject({ status: 'installed', template: { id: 'first-run-template', version: 1 }, scopeId: 'installation' });
  expect(memory.writes[0]).toMatchObject({ phase: 'pending', transactionId: source.preview.transactionId, planDigest: source.preview.planDigest,
    resources: [{ resource: 'policy', state: 'pending' }, { resource: 'bindings', state: 'pending' }] });
  expect(memory.state.record).toMatchObject({ phase: 'committed', blockers: [], resources: [{ state: 'published' }, { state: 'published' }] });
  expect(memory.publishes).toBe(2); expect(memory.verifies).toBe(4); // 2 during publish loop + 2 final
});

it('a repeated apply for the unchanged plan is a safe replay: no new effect, no new pending write', async () => {
  const source = prepared(), memory = memoryPorts();
  await new PolicyTemplateInstallationApplication(memory.ports).apply(source);
  const writesBefore = memory.writes.length, publishesBefore = memory.publishes;
  const again = await new PolicyTemplateInstallationApplication(memory.ports).apply(prepared());
  expect(again).toMatchObject({ status: 'replayed' });
  expect(memory.writes.length).toBe(writesBefore); expect(memory.publishes).toBe(publishesBefore);
});

it('resumes an exact prior effect after a crash between the two targets, without re-occupying a foreign one', async () => {
  const source = prepared(), memory = memoryPorts();
  memory.crash();
  const application = new PolicyTemplateInstallationApplication(memory.ports);
  await expect(application.apply(source)).rejects.toThrow('CRASH_AFTER_EFFECT');
  expect(memory.state.record).toMatchObject({ phase: 'pending', resources: [{ resource: 'policy', state: 'pending' }, { resource: 'bindings', state: 'pending' }] });
  expect(memory.effects.size).toBe(1);
  await expect(application.apply(source)).resolves.toMatchObject({ status: 'installed' });
  expect(memory.state.record).toMatchObject({ phase: 'committed', resources: [{ state: 'published' }, { state: 'published' }] });
});

it('never overwrites an existing policy or bindings file: a different pre-existing target refuses before any journal write, nothing published', async () => {
  const source = prepared(), memory = memoryPorts();
  memory.seed(source.targets[0]!, 'f'.repeat(64)); // some other, unrelated policy.json already sitting there
  const application = new PolicyTemplateInstallationApplication(memory.ports);
  await expect(application.apply(source)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(application).toBeInstanceOf(PolicyTemplateInstallationApplication);
  expect(memory.writes).toEqual([]); // no pending journal entry was ever written
  expect(memory.publishes).toBe(0); // the existing file was never touched
});

it('a pre-existing target with exactly the template\'s own bytes (e.g. restored from backup) is accepted, not treated as foreign', async () => {
  const source = prepared(), memory = memoryPorts();
  memory.seed(source.targets[0]!, source.targets[0]!.digest);
  await expect(new PolicyTemplateInstallationApplication(memory.ports).apply(source)).resolves.toMatchObject({ status: 'installed' });
});

it('refuses when the project\'s one installation journal already holds a different transaction (a different scope, or the heavy install)', async () => {
  const first = prepared('installation'), second = prepared('other-scope'), memory = memoryPorts();
  await new PolicyTemplateInstallationApplication(memory.ports).apply(first);
  await expect(new PolicyTemplateInstallationApplication(memory.ports).apply(second)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
});

it('a verify mismatch after publish surfaces as a typed, distinguishable failure', async () => {
  const source = prepared(), memory = memoryPorts();
  const application = new PolicyTemplateInstallationApplication({ ...memory.ports,
    async verify() { throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED'); } });
  await expect(application.apply(source)).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
});
