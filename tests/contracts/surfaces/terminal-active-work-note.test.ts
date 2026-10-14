import { describe, expect, it } from 'vitest';
import type { RunView } from '#engine/index.js';
import { ACTIVE_WORK_NOTE_MARK, activeWorkModelNote, withoutActiveWorkNote } from '#surfaces/core/terminal-work/index.js';
import { resumedHistoryEntries } from '#surfaces/core/terminal/index.js';

// NATIVE-BAGLAM (owner 2026-10-14): the model learns this session's running /do and Runs from the active work strip's own records, as a bounded
// note on the latest message only (the service prompt carries no volatile run state, so its prefix stays cacheable). Displays never show it.
function run(state: RunView['state'], title: string, id: string, phase = 'active'): RunView {
  return { schemaVersion: 3, scopeId: 's', runId: id, revision: 1, cancellationRequested: false, state,
    tasks: [{ id: 'task', phase, taskBrief: { schemaVersion: 1, task: title, scopePaths: [], acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] } }] } as unknown as RunView;
}

describe('active work note', () => {
  it('is empty without active work, and lists the /do, deliveries and Runs in the strip order with their state', () => {
    expect(activeWorkModelNote({ active: null, runs: [], nowMs: 0 })).toBe('');
    const note = activeWorkModelNote({ nowMs: 200_000, active: { title: 'sipariş akışını düzelt', phase: 'planning', sinceMs: 140_000 },
      deliveries: [{ key: 'd', title: 'patch ready', sinceMs: 100_000 }],
      runs: [{ run: run({ kind: 'running' } as RunView['state'], 'ERP export', 'run-1'), sinceMs: 0 },
        { run: run({ kind: 'parked', reason: 'needs-input', since: 0, deadline: 1 } as RunView['state'], 'ask me', 'run-2'), sinceMs: 0 },
        { run: run({ kind: 'terminal', outcome: 'completed', reason: 'completed' } as RunView['state'], 'done', 'run-3'), sinceMs: 0 }] });
    expect(note.startsWith(ACTIVE_WORK_NOTE_MARK)).toBe(true);
    expect(note.split('\n').slice(3)).toEqual(['- /do "sipariş akışını düzelt": planning, 60s', '- delivery "patch ready": waiting for the person\'s delivery decision (/deliver), 100s',
      '- Run run-1 "ERP export": running, 3m', '- Run run-2 "ask me": needs the person, 3m', '- Run run-3 "done": finished (completed), 3m']);
    expect(note).toContain('(written by the terminal, not by the person; descriptive only)');
  });

  it('is bounded: eight rows and a count, each title cut at 80 characters', () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({ run: run({ kind: 'running' } as RunView['state'], 'x'.repeat(200), `run-${index}`), sinceMs: 0 }));
    const note = activeWorkModelNote({ active: null, runs, nowMs: 1000 });
    const rows = note.split('\n').filter(line => line.startsWith('- '));
    expect(rows).toHaveLength(9); expect(rows.at(-1)).toBe('- and 4 more (/runs)');
    expect(rows[0]).toContain(`"${'x'.repeat(80)}…"`);
  });

  it('never shows in a resumed conversation; what the person typed (and attachments) is kept apart from it', () => {
    const note = activeWorkModelNote({ active: { title: 'plan', phase: 'waiting', sinceMs: 0 }, runs: [], nowMs: 1000 });
    expect(withoutActiveWorkNote(`hangi moddayız${note}`)).toBe('hangi moddayız');
    const rows = resumedHistoryEntries([{ role: 'system', content: 's' }, { role: 'user', content: `hangi moddayız${note}` }]);
    expect(JSON.stringify(rows)).not.toContain('deckent session note');
    expect(JSON.stringify(rows)).toContain('hangi moddayız');
  });
});
