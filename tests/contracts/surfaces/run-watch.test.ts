import { describe, expect, it } from 'vitest';
import { freshRunCards } from '#surfaces/core/terminal-ledger/index.js';
import { newRunLedgerEntries, runWatchFingerprint } from '#surfaces/core/terminal/index.js';
import type { RunView } from '#engine/index.js';

const baseRun = (revision: number, phase: RunView['tasks'][number]['phase']): RunView => ({
  schemaVersion: 3, state: { kind: 'running' },
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
    const diagnostic = { schemaVersion: 1 as const, scopeId: 'scope-1', runId: 'run-1', revision: 1, actorClass: 'ai' as const,
      observedAtMs: 1, validUntilMs: 5, state: 'blocked' as const, reason: 'POLICY_DENIED', policyRevision: 'p1', session: 'eligible' as const,
      suspended: true, parkUnavailable: true, missing: [] };
    const blocked = { ...baseRun(1, 'pending'), progression: diagnostic };
    const first = newRunLedgerEntries(new Map(), [blocked], 'first');
    expect(first.fresh[0]!.progression).toEqual(diagnostic);
    expect(newRunLedgerEntries(first.seen, [{ ...blocked, progression: { ...diagnostic, observedAtMs: 2, validUntilMs: 6 } }], 'refresh').fresh).toHaveLength(0);
    const changed = newRunLedgerEntries(first.seen, [{ ...blocked, progression: { ...diagnostic, state: 'eligible', reason: 'RUN_PROGRESSION_ELIGIBLE', suspended: false, parkUnavailable: false, policyRevision: 'p2' } }], 'changed');
    expect(changed.fresh).toHaveLength(1); expect(changed.fresh[0]!.revision).toBe(1);
    const pushed = freshRunCards(new Map(), first.fresh);
    expect(freshRunCards(pushed.seen, changed.fresh).fresh).toHaveLength(1);

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
