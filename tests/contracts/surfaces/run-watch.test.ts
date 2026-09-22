import { describe, expect, it } from 'vitest';
import { newRunLedgerEntries, runWatchFingerprint } from '#surfaces/core/terminal/index.js';
import type { RunView } from '#engine/index.js';

const baseRun = (revision: number, phase: RunView['tasks'][number]['phase']): RunView => ({
  schemaVersion: 2,
  runId: 'run-1',
  scopeId: 'scope-1',
  layoutRevision: 'lay',
  registryRevision: 'reg',
  revision,
  cancellationRequested: false,
  criteria: [],
  tasks: [{
    id: 't1', kind: 'code', dependencies: [], acceptanceCriteria: [], profile: { id: 'p', version: 1 }, phase, unresolvedEffects: false,
  }],
});

describe('run watch', () => {
  it('fingerprints revision and phase', () => {
    expect(runWatchFingerprint(baseRun(1, 'pending'))).not.toBe(runWatchFingerprint(baseRun(2, 'pending')));
    expect(runWatchFingerprint(baseRun(1, 'pending'))).not.toBe(runWatchFingerprint(baseRun(1, 'active')));
  });

  it('emits on first sight and on fingerprint change only', () => {
    const first = newRunLedgerEntries(new Map(), [baseRun(1, 'pending')], 'pfx');
    expect(first.fresh).toHaveLength(1);
    const same = newRunLedgerEntries(first.seen, [baseRun(1, 'pending')], 'pfx');
    expect(same.fresh).toHaveLength(0);
    const changed = newRunLedgerEntries(same.seen, [baseRun(2, 'active')], 'pfx');
    expect(changed.fresh).toHaveLength(1);
    expect(changed.fresh[0]!.revision).toBe(2);
  });
});
