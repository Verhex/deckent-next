import { describe, expect, it } from 'vitest';
import { runViewToLedgerEntry, workerReportToLedgerEntries } from '#surfaces/core/terminal/index.js';
import type { RunView } from '#engine/index.js';

describe('work ledger', () => {
  it('maps run view to run card entry', () => {
    const run: RunView = {
      schemaVersion: 2,
      runId: 'run-a',
      scopeId: 'scope-1',
      layoutRevision: 'lay-1',
      registryRevision: 'reg-1',
      revision: 3,
      cancellationRequested: false,
      criteria: [],
      tasks: [
        { id: 't1', kind: 'code', dependencies: [], acceptanceCriteria: [], profile: { id: 'p', version: 1 }, phase: 'active', unresolvedEffects: false },
        { id: 't2', kind: 'code', dependencies: [], acceptanceCriteria: [], profile: { id: 'p', version: 1 }, phase: 'pending', unresolvedEffects: false },
      ],
    };
    const entry = runViewToLedgerEntry(run, 'e1');
    expect(entry.kind).toBe('run');
    expect(entry.runId).toBe('run-a');
    expect(entry.taskPhases).toContain('active:1');
    expect(entry.taskPhases).toContain('pending:1');
  });

  it('maps worker report to worker cards', () => {
    const entries = workerReportToLedgerEntries({
      schemaVersion: 1,
      observedAt: 1,
      scopeId: 'scope-1',
      control: 'observe-only',
      sources: [{
        id: 'src',
        path: '/tmp',
        kind: 'local',
        status: 'available',
        truncated: false,
        nextAfter: null,
        workers: [{
          taskId: 'task-1',
          identity: null,
          authority: 'next-ledger',
          provider: 'docker',
          workspace: null,
          process: 'running',
          handle: null,
          terminal: null,
          outputRecorded: false,
          patchRecorded: false,
          files: null,
          diagnostics: [],
        }],
      }],
    }, 'pfx');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('worker');
    expect(entries[0]!.taskId).toBe('task-1');
  });
});
