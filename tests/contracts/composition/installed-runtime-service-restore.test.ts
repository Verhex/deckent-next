import { expect, it } from 'vitest';
import { DockerSupervisor } from '#adapters/index.js';
import {
  cleanupBoundary, dockerCommand, fixtureContainers, installedScenario, stopWorker,
  type CleanupBoundary, type ContentionIdentity, type ContentionRecord,
} from '../support/installed-runtime-harness.js';

it.skipIf(process.platform !== 'linux').each(['restore'] as const)('known-identity cleanup keeps the primary, reports a %s fault and still releases the workspace', async stage => {
  const observed: { root?: string; identity?: ContentionIdentity } = {};
  const known = (identity: ContentionIdentity) => identity.attemptId === observed.identity?.attemptId;
  const withheld: NonNullable<ContentionRecord>[] = [], released: string[] = [];
  // The fault replaces the known attempt's real operation; its real record is kept only to compensate after the assertions.
  const boundary: CleanupBoundary = {
    loadBoundDispatch: async (runtime, identity) => {
      const record = await cleanupBoundary.loadBoundDispatch(runtime, identity);
      if (stage === 'custody-read' && known(identity)) { if (record) withheld.push(record); throw new Error('INJECTED_CLEANUP_FAULT_CUSTODY_READ'); }
      return record;
    },
    restoreProfile: (record, identity) => {
      if (stage === 'restore' && known(identity)) { withheld.push(record); return Promise.reject(new Error('INJECTED_CLEANUP_FAULT_RESTORE')); }
      return cleanupBoundary.restoreProfile(record, identity);
    },
    releaseWorkspace: async (runtime, lease) => { released.push(lease.identity.attemptId); await cleanupBoundary.releaseWorkspace(runtime, lease); },
  };
  const failure = await installedScenario('contention', observed, 'after-found', boundary).then(() => undefined, (error: unknown) => error);
  try {
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('SCENARIO_AND_CLEANUP_FAILED');
    expect((failure as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['INJECTED_WITNESS_FAULT_AFTER_FOUND', `INJECTED_CLEANUP_FAULT_${stage.toUpperCase().replace('-', '_')}`]);
    expect(observed.identity).toBeDefined(); expect(released).toEqual([observed.identity!.attemptId]); expect(withheld).toHaveLength(1);
  } finally {
    for (const record of withheld) await stopWorker(await DockerSupervisor.restoreProfile(record.profile), record.request);
  }
  expect(await fixtureContainers(observed.root!, dockerCommand, true)).toEqual([]);
}, 60_000);
