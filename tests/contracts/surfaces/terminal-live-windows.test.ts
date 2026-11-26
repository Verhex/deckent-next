import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement, Fragment } from 'react';
import { Box, render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortId, clearConfigCache, t } from '#platform/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { ensureConfiguredTerminalIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { main } from '../../../src/surfaces/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { immediateSlashAction, liveWindowClosedText, liveWindowLines, liveWindowStatus, LIVE_WINDOW_MAX_ROWS, type LiveWindowRenderLabels } from '#surfaces/core/terminal-work/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry, type WorklineLedgerPorts } from '#surfaces/core/terminal/index.js';
import { LiveWatchWindow } from '#surfaces/core/terminal-work/index.js';
import { withSurfaceSnapshot } from '#surfaces/core/terminal-admin/index.js';
import { Window, WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { plainText, resolveRenderGlyphs, RenderGlyphsContext, span } from '#surfaces/core/terminal-render-ink/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';

/** T3 L5: `/monitor` and `/tasks` as bounded modal windows. */
const ESC = '\u001B';
const EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr');
const labelsOf = (work: typeof EN): LiveWindowRenderLabels => ({ live: work.live!, panel: work.panel, workerLine: work.workerLine, jobs: work.jobs });
const worker = (index: number): WorkLedgerWorkerEntry => ({ schemaVersion: 1, kind: 'worker', id: `w-${index}`, scopeId: 'scope-a', taskId: `task-${index}`, process: 'running',
  provider: 'docker', authority: 'next-ledger', ordinal: index + 1 });
const run = (index: number, extra: Partial<WorkLedgerRunEntry> = {}): WorkLedgerRunEntry => ({ schemaVersion: 1, kind: 'run', id: `r-${index}`, runId: `run-${index}`, scopeId: 'scope-a',
  revision: index + 1, cancellationRequested: false, runState: { kind: 'running' }, taskPhases: 'active:1', ...extra });

describe('live window content (pure)', () => {
  it('words the workers list and the combined tasks window in the session language, with an empty line before the first read', () => {
    for (const [locale, work] of [['en', EN], ['tr', TR]] as const) {
      const labels = labelsOf(work);
      const rows = (kind: 'workers' | 'tasks', data: { workers: WorkLedgerWorkerEntry[]; runs: WorkLedgerRunEntry[] }) => liveWindowLines(kind, data, labels).map(line => plainText(line.spans));
      expect(rows('workers', { workers: [], runs: [] }), locale).toEqual([work.live!.empty]);
      expect(rows('workers', { workers: [worker(0)], runs: [] })[0]).toContain(locale === 'en' ? 'Task 1' : 'Görev 1');
      const tasks = rows('tasks', { workers: [worker(0)], runs: [run(0, { cancellationRequested: true })] });
      expect(tasks[0]).toBe(work.panel.title); expect(tasks).toContain(work.live!.runsTitle); expect(tasks).toContain('');
      expect(tasks.at(-1)).toContain(shortId('run-0'));
      // F2-3: a generated 64-hex Run id shows its 8-character head; a human id stays whole (F2-6 `notlar-s`).
      expect([shortId('0ab01bb5'.padEnd(64, 'c')), shortId('notlar-satiri-ekle')]).toEqual(['0ab01bb5', 'notlar-satiri-ekle']);
      expect(rows('tasks', { workers: [], runs: [] }), locale).toEqual([work.panel.title, work.live!.empty, '', work.live!.runsTitle, work.live!.empty]);
      expect.soft(liveWindowStatus({ workers: [worker(0)], runs: [run(0), run(1)] }, labels)).toBe(locale === 'en' ? '1 observed worker(s) · 2 listed Run(s)' : '1 gözlemlenen işçi · 2 listelenen iş');
      expect.soft(liveWindowStatus({ workers: [], runs: [run(0)] }, labels)).toBe(locale === 'en' ? '0 observed worker(s) · 1 listed Run(s)' : '0 gözlemlenen işçi · 1 listelenen iş');
      expect(liveWindowClosedText({ workers: [worker(0)], runs: [run(0)] }, work.live!)).toContain('1');
    }
  });
  it('bounds a list at the ledger tail limit and says how many rows are not shown', () => {
    const labels = labelsOf(EN), many = Array.from({ length: LIVE_WINDOW_MAX_ROWS + 5 }, (_, index) => worker(index));
    const rows = liveWindowLines('workers', { workers: many, runs: [] }, labels).map(line => plainText(line.spans));
    expect(rows).toHaveLength(LIVE_WINDOW_MAX_ROWS + 1);
    expect(rows.at(-1)).toBe(EN.panel.more.replace('{count}', '5'));
    const runs = liveWindowLines('tasks', { workers: [], runs: Array.from({ length: LIVE_WINDOW_MAX_ROWS + 2 }, (_, index) => run(index)) }, labels).map(line => plainText(line.spans));
    expect(runs.at(-1)).toBe(EN.live!.runsMore.replace('{count}', '2'));
  });
});

describe('live window commands (pure)', () => {
  const ledger = { scopeId: 'scope-a', async listWorkers() { return null as never; }, async inspectRun() { return null; }, async listRunIds() { return []; } };
  const context = (extra: Record<string, unknown> = {}) => ({ ledger: ledger as never, labels: WORKLINE_TEST_LABELS as never, watch: { workers: false, runs: false }, ...extra });
  it('opens the tasks window, starts exactly the feeds it shows, and reopens an already followed feed without announcing it again', () => {
    expect(immediateSlashAction('tasks', context())).toMatchObject({ window: 'tasks', watch: { workers: true, runs: true } });
    // A ledger that cannot list runs follows workers only.
    expect(immediateSlashAction('tasks', context({ ledger: { ...ledger, listRunIds: undefined } }))).toMatchObject({ window: 'tasks', watch: { workers: true, runs: false } });
    expect(immediateSlashAction('tasks', context({ watch: { workers: true, runs: true } }))).toEqual({ entries: [], window: 'tasks' });
    // Owner 2026-10-30: the watch commands are gone from the terminal; `/tasks` and `/runs` carry the same information.
    for (const removed of ['watch-workers', 'watch-runs', 'watch-stop']) expect(immediateSlashAction(removed, context())?.entries[0]).toMatchObject({ level: 'error' });
  });
  it('refuses with a typed notice when there is no ledger or no window words', () => {
    expect(immediateSlashAction('tasks', context({ ledger: undefined }))?.entries[0]).toMatchObject({ kind: 'notice', level: 'error' });
    const bare = { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, live: undefined } } as never;
    const result = immediateSlashAction('tasks', context({ labels: bare }));
    expect(result?.window).toBeUndefined(); expect(result?.watch).toBeUndefined(); expect(result?.entries[0]).toMatchObject({ level: 'error' });
  });
});

describe('live windows in the workline', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
  const report = (count: number) => ({ schemaVersion: 1, scopeId: 'scope-a', sources: [{ workers: Array.from({ length: count }, (_, index) => ({
    taskId: `task-${index}`, process: 'running', provider: 'docker', authority: 'next-ledger' })) }] }) as never;
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it('/tasks shows workers and runs together, updates in place, and Esc closes it, stops the feed and leaves the summary', async () => {
    for (const [locale, work] of [['en', EN], ['tr', TR]] as const) {
      let count = 0, calls = 0;
      const inspected = vi.fn(async (runId: string) => ({ runId, scopeId: 'scope-a', revision: 3, cancellationRequested: false,
        state: { kind: 'parked', reason: 'environment-not-ready', since: 1, failureCode: 'NOT_READY' }, tasks: [{ phase: 'active' }] }) as never);
      const labels = { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, live: work.live, jobs: work.jobs, workerLine: work.workerLine } };
      const view = mountWorkline({ labels, pollMs: 20, ledger: { scopeId: 'scope-a', async listWorkers() { calls++; return report(count); }, async listRunIds() { return ['run-a']; }, inspectRun: inspected } }); mounted.push(view.instance);
      const task = locale === 'en' ? 'Task' : 'Görev';
      await settle(20); view.stdin.write('/tasks\r');
      await until(() => view.stdout.frame.includes(work.live!.tasksTitle) && view.stdout.frame.includes('run-a'), 'parked Run in the tasks window');
      expect(view.stdout.frame).toContain(work.live!.runsTitle);
      expect(view.stdout.frame).toContain(locale === 'en' ? '[parked]' : '[bekletildi]');
      expect(view.stdout.frame).not.toContain(`${task} 1 · docker`);
      expect.soft(view.stdout.frame).toContain(locale === 'en' ? '0 observed worker(s) · 1 listed Run(s)' : '0 gözlemlenen işçi · 1 listelenen iş');
      expect.soft(view.stdout.frame).toContain(locale === 'en' ? 'Recorded task phases: 1 active in the Run record.' : 'Kayıtlı görev durumları: iş kaydında 1 etkin görev.');
      expect.soft(view.stdout.frame).not.toContain(locale === 'en' ? '1 running' : '1 çalışıyor');
      count = 1; await until(() => view.stdout.frame.includes(`${task} 1 · docker`), 'the first observed worker appears');
      expect.soft(view.stdout.frame).toContain(locale === 'en' ? '1 observed worker(s) · 1 listed Run(s)' : '1 gözlemlenen işçi · 1 listelenen iş');
      count = 2; await until(() => view.stdout.frame.includes(`${task} 2 · docker`), 'the second worker appears in the open window');
      // In place: one row each, no card appended to the scrollback.
      expect(occurrences(view.stdout.frame, `${task} 1 · docker`)).toBe(1); expect(occurrences(view.stdout.frame, `${task} 2 · docker`)).toBe(1);
      view.stdin.write(ESC);
      const summary = locale === 'en' ? '2 workers and 1 runs at the last read' : 'son okumada 2 işçi ve 1 iş';
      await until(() => !view.stdout.frame.includes(work.live!.tasksHints!) && view.stdout.frame.includes(summary), 'closed with the summary');
      const after = calls; await settle(120); expect(calls - after).toBeLessThanOrEqual(1);
      mounted.pop()!.unmount();
    }
  });

  it('/tasks opens the selected transcript and confirms refreshed Run cancellation within the selected project', async () => {
    const attempt = { scopeId: 'scope-a', runId: 'run-a', taskId: 'task-0', attemptId: 'attempt-a' };
    const cancelled: unknown[][] = [], transcripts: unknown[] = [];
    let revision = 3, ready!: () => void;
    const view = mountWorkline({ opening: { ready: new Promise<void>(resolve => { ready = resolve; }), wait: 'OPENING-WAIT' }, pollMs: 20, ledger: { scopeId: 'scope-a', listWorkers: async () => ({ schemaVersion: 1, scopeId: 'scope-a', sources: [{
      workers: [{ taskId: 'task-0', process: 'running', provider: 'docker', authority: 'next-ledger', identity: attempt }] }] }) as never,
      listRunIds: async () => ['run-a'], inspectRun: async () => ({ runId: 'run-a', scopeId: 'scope-a', revision, cancellationRequested: false,
        tasks: [{ id: 'task-0', phase: 'active' }], state: { kind: 'running' } }) as never,
      inspectTranscript: async target => { transcripts.push(target); return 'SELECTED-TRANSCRIPT'; },
      cancelRun: async (...args) => { cancelled.push(args); return 'CANCELLED-SELECTED-RUN'; },
    } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/tasks\r'); await until(() => view.stdout.frame.includes('Task 1'), 'task rows');
    view.stdin.write('\r'); await settle(60);
    expect(transcripts).toEqual([]); expect(cancelled).toEqual([]); expect(view.stdout.text).toContain('OPENING-WAIT');
    ready(); await until(() => view.stdout.frame.includes('SELECTED-TRANSCRIPT'), 'selected transcript after readiness');
    expect(transcripts).toEqual([attempt]); expect(cancelled).toEqual([]);
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'tasks returns');
    revision = 9; view.stdin.write('x'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'existing cancel approval');
    expect(view.stdout.frame).toContain('9'); expect(cancelled).toEqual([]);
    view.stdin.write('n'); await until(() => view.stdout.text.includes('C-KEPT'), 'deny keeps run'); expect(cancelled).toEqual([]);
    await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'tasks after denial');
    view.stdin.write('x'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'cancel approval again'); view.stdin.write('y');
    await until(() => cancelled.length === 1, 'approved cancellation'); expect(cancelled).toEqual([['run-a', 9]]);

    for (const instance of mounted.splice(0)) instance.unmount();

    // A foreign row must retain its project identity even when its Attempt matches a local one.
    {
      const attempt = { scopeId: 'scope-a', runId: 'run-a', taskId: 'task-0', attemptId: 'attempt-a', generation: 1, layoutRevision: 'layout-a' };
      const inspectTranscript = vi.fn(async () => 'ACTIVE-PROJECT-TRANSCRIPT'), cancelRun = vi.fn(async () => 'CANCELLED');
      const source = (id: string, path: string, provider: string) => ({
        id, path, kind: 'next-project' as const, status: 'available' as const, truncated: false, nextAfter: null,
        workers: [{ taskId: attempt.taskId, identity: attempt, process: 'running' as const, provider, authority: 'next-ledger' as const,
          workspace: null, handle: null, terminal: null, outputRecorded: false, patchRecorded: false, files: null, diagnostics: [] }],
      });
      const active = source('current', '/project-a', 'local-worker'), other = source('project-b', '/project-b', 'observed-worker');
      let sources = [{ ...active, workers: [] }, other];
      const ledger: WorklineLedgerPorts = { scopeId: attempt.scopeId,
        listWorkers: async () => ({ schemaVersion: 1, observedAt: 1, scopeId: attempt.scopeId, sources, control: 'observe-only' }),
        listRunIds: async () => [attempt.runId], inspectRun: async () => ({ runId: attempt.runId, scopeId: attempt.scopeId,
          revision: 3, cancellationRequested: false, tasks: [{ id: attempt.taskId, phase: 'active' }], state: { kind: 'running' } }) as never,
        inspectTranscript, cancelRun,
      };
      const view = mountWorkline({ pollMs: 20, ledger, labels: { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, unavailable: EN.unavailable } } });
      mounted.push(view.instance);
      await until(() => view.stdout.frame.includes(WORKLINE_TEST_LABELS.statusReady) && view.stdin.listenerCount('readable') > 0, 'English composer ready for input');
      view.stdin.write('/tasks\r');
      await until(() => view.stdout.frame.includes('1 observed worker(s) · 1 listed Run(s)'), 'observed worker and the active Run');
      view.stdin.write('\u001b[B');
      await until(() => />[^\n]*run-a/u.test(view.stdout.frame), 'active Run highlighted');
      for (const workers of [1, 0]) {
        if (workers === 0) sources = [{ ...active, workers: [] }];
        await until(() => view.stdout.frame.includes(`${workers} observed worker(s) · 1 listed Run(s)`), 'Run without a local worker');
        view.stdin.write('\r');
        await until(() => view.stdout.frame.includes(EN.jobs!.transcriptTitle), 'Run transcript window without a local worker');
        expect.soft(view.stdout.frame).toContain('No local worker record for this Run. If the work runs in another project, open that project.');
        expect.soft(view.stdout.frame).not.toContain(EN.unavailable);
        expect(inspectTranscript).not.toHaveBeenCalled();
        view.stdin.write(ESC);
        await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'back to tasks after the unavailable transcript');
      }
      sources = [{ ...active, workers: [] }, other];
      await until(() => view.stdout.frame.includes('1 observed worker(s) · 1 listed Run(s)'), 'other project worker returns');
      view.stdin.write('\u001b[A');
      await until(() => />[^\n]*Task 1 · observed-worker/u.test(view.stdout.frame), 'other project worker explicitly selected');

      const cancelRefusal = "Cancellation can't start from this worker row. Select the Run's row.";
      view.stdin.write('x');
      await until(() => view.stdout.text.includes(cancelRefusal) || view.stdout.frame.includes('C-PROMPT'), 'foreign worker cancellation response');
      expect.soft(view.stdout.text).toContain(cancelRefusal);
      expect(t('terminal.live.workerCancelUnavailable', {}, 'tr')).toBe('Bu işçi satırından iptal başlatılamaz. İşin kendi satırını seçin.');
      expect.soft(view.stdout.frame).not.toContain('C-PROMPT');
      expect(view.stdout.text).not.toContain('C-PROMPT');
      expect(cancelRun).not.toHaveBeenCalled();

      const beforeForeignEnter = view.stdout.text.length;
      const transcriptRefusal = "This worker belongs to another project. Its transcript can't be opened here.";
      view.stdin.write('\r');
      await until(() => view.stdout.text.slice(beforeForeignEnter).includes(transcriptRefusal) || view.stdout.frame.includes(EN.jobs!.transcriptTitle), 'foreign worker transcript response');
      expect.soft(inspectTranscript).not.toHaveBeenCalled();
      expect.soft(view.stdout.text).toContain(transcriptRefusal);
      expect(t('terminal.live.workerTranscriptUnavailable', {}, 'tr')).toBe('Bu işçi başka bir projeye ait. İşçi kaydı burada açılamaz.');
      expect(view.stdout.frame).toContain(EN.live!.tasksHints!);
      expect.soft(view.stdout.frame).not.toContain(EN.jobs!.transcriptTitle);
      expect(view.stdout.text.slice(beforeForeignEnter)).not.toContain(EN.jobs!.transcriptTitle);
      inspectTranscript.mockClear();

      sources = [active, other];
      await until(() => view.stdout.frame.includes('2 observed worker(s) · 1 listed Run(s)'), 'the same Attempt from both projects');
      expect.soft(view.stdout.frame).toMatch(/>[^\n]*Task 2 · observed-worker/u);
      sources = [active];
      await until(() => view.stdout.frame.includes('1 observed worker(s) · 1 listed Run(s)'), 'the observed project disappears');
      expect.soft(view.stdout.frame).toContain('Selected item is no longer in the task list.');
      const beforeLostInput = view.stdout.text.length;
      view.stdin.write('\r');
      await until(() => view.stdin.readableLength === 0, 'Enter consumed with no selection');
      view.stdin.write('x');
      await until(() => view.stdin.readableLength === 0, 'x consumed with no selection');
      // The next selection proves the same key flow progressed past both lost-target actions.
      view.stdin.write('\u001b[B');
      await until(() => />[^\n]*local-worker/u.test(view.stdout.frame)
        || view.stdout.frame.includes(EN.jobs!.transcriptTitle) || view.stdout.frame.includes('C-PROMPT'), 'selection after lost-target input');
      const lostInputOutput = view.stdout.text.slice(beforeLostInput);
      expect.soft(inspectTranscript).not.toHaveBeenCalled();
      expect.soft(lostInputOutput).not.toContain(EN.jobs!.transcriptTitle);
      expect.soft(lostInputOutput).not.toContain('C-PROMPT');
      expect.soft(view.stdout.frame).not.toContain('C-PROMPT');
      expect(cancelRun).not.toHaveBeenCalled();

      inspectTranscript.mockClear();
      expect(view.stdout.frame).toMatch(/>[^\n]*local-worker/u);
      view.stdin.write('\r');
      await until(() => view.stdout.frame.includes('ACTIVE-PROJECT-TRANSCRIPT'), 'active worker transcript');
      expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(attempt);
      view.stdin.write(ESC);
      await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'back to tasks after the active transcript');
      view.stdin.write('x');
      await until(() => view.stdout.frame.includes('C-PROMPT'), 'active Run cancellation confirmation');
      expect(cancelRun).not.toHaveBeenCalled();
      view.stdin.write('y');
      await until(() => cancelRun.mock.calls.length === 1, 'active Run cancelled after confirmation');
      expect(cancelRun).toHaveBeenCalledExactlyOnceWith(attempt.runId, 3);

      sources = [active, other];
      await until(() => view.stdout.frame.includes('2 observed worker(s) · 1 listed Run(s)') && view.stdout.frame.includes(EN.live!.tasksHints!), 'both projects after the local confirmation');
      inspectTranscript.mockClear();
      view.stdin.write('\u001b[A');
      await until(() => />[^\n]*run-a/u.test(view.stdout.frame), 'active Run row explicitly selected');
      view.stdin.write('\r');
      await until(() => view.stdout.frame.includes('ACTIVE-PROJECT-TRANSCRIPT'), 'Run transcript uses its own worker with both sources present');
      expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(attempt);
      expect(cancelRun).toHaveBeenCalledExactlyOnceWith(attempt.runId, 3);
      inspectTranscript.mockClear();
      for (const instance of mounted.splice(0)) instance.unmount();

      // The visible Run may outlast its local worker between a snapshot read and Enter.
      const snapshot = withSurfaceSnapshot({ ...ledger, async *followEvents(signal) {
        yield { control: 'start', scopeId: attempt.scopeId, cursors: { approval: 0, run: 0, worker: 0 } };
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      } }, async () => ({ binding: 'test-session', kinds: ['approval', 'run', 'worker'] }));
      const tr = mountWorkline({ pollMs: 20, ledger: snapshot, labels: { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, jobs: TR.jobs, live: TR.live, unavailable: TR.unavailable } } });
      mounted.push(tr.instance);
      await until(() => tr.stdout.frame.includes(WORKLINE_TEST_LABELS.statusReady) && tr.stdin.listenerCount('readable') > 0, 'Turkish composer ready for input');
      tr.stdin.write('/tasks\r');
      await until(() => tr.stdout.frame.includes('2 gözlemlenen işçi · 1 listelenen iş'), 'both project sources through the Turkish snapshot');
      tr.stdin.write('\u001b[B');
      await until(() => />[^\n]*observed-worker/u.test(tr.stdout.frame), 'other project worker selected in Turkish');
      tr.stdin.write('\u001b[B');
      await until(() => />[^\n]*run-a/u.test(tr.stdout.frame), 'active Run highlighted in Turkish');
      expect(inspectTranscript).not.toHaveBeenCalled();
      sources = [{ ...active, workers: [] }, other];
      tr.stdin.write('\r');
      await until(() => /^│\s*İşçi kaydı(?:\s|│)/mu.test(tr.stdout.frame), 'Turkish Run transcript window after the local worker disappears');
      expect.soft(tr.stdout.frame).toContain('Bu iş için bu projede işçi kaydı yok. İş başka bir projede çalışıyorsa o projeyi açın.');
      expect.soft(tr.stdout.frame).not.toContain(TR.unavailable);
      expect(inspectTranscript).not.toHaveBeenCalled();
    }
  });

  it('refuses /tasks without a ledger and opens no window', async () => {
    const view = mountWorkline({}); mounted.push(view.instance);
    await settle(20); view.stdin.write('/tasks\r'); await until(() => view.stdout.text.includes('NO-LEDGER') || view.stdout.text.includes('UNWIRED'), 'refused');
    expect(view.stdout.frame).not.toContain(EN.live!.tasksTitle);
  });

  it('/tasks leaves Enter and x without a target when the selected worker disappears', async () => {
    const attempts = ['a', 'b', 'c'].map(id => ({ scopeId: 'scope-a', runId: `run-${id}`, taskId: `task-${id}`, attemptId: `attempt-${id}` }));
    let visible = attempts, legacy = false, legacySources = ['legacy-a'];
    const inspectTranscript = vi.fn(async () => 'NEIGHBOUR-TRANSCRIPT'), cancelRun = vi.fn(async () => 'CANCELLED');
    const ledger: WorklineLedgerPorts = { scopeId: 'scope-a',
      listWorkers: async () => ({ scopeId: 'scope-a', sources: (legacy ? legacySources : ['current']).map(id => ({ id, workers: visible.map(identity =>
        ({ taskId: identity.taskId, process: id === 'legacy-b' ? 'present-unverified' : 'running',
          provider: legacy ? 'unknown' : 'docker', authority: legacy ? 'legacy-activity' : 'next-ledger', identity: legacy ? null : identity })) })) }) as never,
      listRunIds: async () => attempts.map(item => item.runId), inspectRun: async runId =>
        ({ runId, scopeId: 'scope-a', revision: 3, cancellationRequested: false, tasks: [{ id: 'task-c', phase: 'active' }], state: { kind: 'running' } }) as never,
      inspectTranscript, cancelRun,
    };
    const view = mountWorkline({ pollMs: 20, ledger }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/tasks\r');
    await until(() => view.stdout.frame.includes('3 observed worker(s) · 3 listed Run(s)'), 'initial live list');
    view.stdin.write('\r');
    await until(() => view.stdout.frame.includes('NEIGHBOUR-TRANSCRIPT'), 'transcript of the initial selection');
    expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(attempts[0]);
    view.stdin.write(ESC);
    await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'return to the live list');
    visible = [attempts[1]!, attempts[2]!];
    await until(() => view.stdout.frame.includes('2 observed worker(s) · 3 listed Run(s)'), 'initially acted-on worker leaves');
    expect.soft(view.stdout.frame).toContain('Selected item is no longer in the task list.');
    visible = attempts;
    await until(() => view.stdout.frame.includes('3 observed worker(s) · 3 listed Run(s)'), 'initial worker returns');
    view.stdin.write('\u001b[A');
    await until(() => />[^\n]*run-c/u.test(view.stdout.frame), 'cursor wraps to last Run');
    view.stdin.write('\u001b[B');
    await until(() => />[^\n]*Task 1/u.test(view.stdout.frame), 'first worker explicitly reselected');
    inspectTranscript.mockClear();
    view.stdin.write('\u001b[B');
    await until(() => />[^\n]*Task 2/u.test(view.stdout.frame), 'middle worker selected');
    visible = [attempts[0]!, attempts[2]!];
    await until(() => view.stdout.frame.includes('2 observed worker(s) · 3 listed Run(s)'), 'selected worker leaves');
    view.stdin.write('\r'); await settle(80);
    expect.soft(inspectTranscript).not.toHaveBeenCalled();
    if (view.stdout.frame.includes('NEIGHBOUR-TRANSCRIPT')) {
      view.stdin.write(ESC);
      await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'tasks window after unexpected transcript');
    }
    view.stdin.write('x'); await settle(80);
    expect.soft(view.stdout.frame).not.toContain('C-PROMPT');
    expect(cancelRun).not.toHaveBeenCalled();
    expect(view.stdout.frame).toContain('Selected item is no longer in the task list.');
    view.stdin.write('\u001b[B');
    await until(() => />[^\n]*Task 1/u.test(view.stdout.frame), 'explicit new worker selection');
    view.stdin.write('\r');
    await until(() => view.stdout.frame.includes('NEIGHBOUR-TRANSCRIPT'), 'newly selected transcript');
    expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(attempts[0]);
    view.stdin.write(ESC);
    await until(() => view.stdout.frame.includes(EN.live!.tasksHints!), 'return to the live list again');
    legacy = true; visible = [attempts[2]!];
    legacySources = ['legacy-a', 'legacy-b'];
    const legacyView = mountWorkline({ pollMs: 20, ledger }); mounted.push(legacyView.instance);
    await settle(20); legacyView.stdin.write('/tasks\r');
    await until(() => legacyView.stdout.frame.includes('2 observed worker(s) · 3 listed Run(s)') && />[^\n]*Task 1 · unknown/u.test(legacyView.stdout.frame), 'first of two legacy observations selected');
    legacyView.stdin.write('\u001b[B'); await settle(80);
    expect.soft(legacyView.stdout.frame).toMatch(/>[^\n]*Task 2 · unknown · present-unverified/u);
    legacySources = ['legacy-b', 'legacy-a'];
    await until(() => /Task 1 · unknown · present-unverified/u.test(legacyView.stdout.frame), 'legacy sources reordered');
    expect.soft(legacyView.stdout.frame).toMatch(/>[^\n]*Task 1 · unknown · present-unverified/u);
    legacySources = ['legacy-a'];
    await until(() => legacyView.stdout.frame.includes('1 observed worker(s) · 3 listed Run(s)'), 'selected legacy source disappears');
    expect.soft(legacyView.stdout.frame).toContain('Selected item is no longer in the task list.');
    inspectTranscript.mockClear();
    legacyView.stdin.write('x'); await settle(80);
    expect.soft(legacyView.stdout.text).not.toContain("Cancellation can't start from this worker row.");
    expect.soft(legacyView.stdout.frame).not.toContain('C-PROMPT');
    expect.soft(inspectTranscript).not.toHaveBeenCalled();
    expect.soft(cancelRun).not.toHaveBeenCalled();
    legacyView.stdin.write('\r'); await settle(80);
    expect.soft(legacyView.stdout.frame).not.toContain(EN.jobs!.transcriptTitle);
    expect.soft(inspectTranscript).not.toHaveBeenCalled();
    if (legacyView.stdout.frame.includes(EN.jobs!.transcriptTitle)) {
      legacyView.stdin.write(ESC);
      await until(() => legacyView.stdout.frame.includes(EN.live!.tasksHints!), 'return from unexpected unavailable window');
    }
    legacySources = ['legacy-a', 'legacy-b'];
    await until(() => legacyView.stdout.frame.includes('2 observed worker(s) · 3 listed Run(s)'), 'both observation sources are back');
    expect.soft(legacyView.stdout.frame).toContain('Selected item is no longer in the task list.');
    legacyView.stdin.write('\u001b[B');
    await until(() => />[^\n]*Task 1 · unknown/u.test(legacyView.stdout.frame), 'legacy worker explicitly selected');
    const tr = mountWorkline({ pollMs: 20, ledger, labels: { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, jobs: TR.jobs, live: TR.live } } });
    mounted.push(tr.instance);
    await settle(20); tr.stdin.write('/tasks\r');
    await until(() => />[^\n]*Task 1/u.test(tr.stdout.frame), 'Turkish session shows the worker');
    for (const [screen, work, feedback] of [
      [legacyView, EN, "Cancellation can't start from this worker row. Select the Run's row."],
      [tr, TR, 'Bu işçi satırından iptal başlatılamaz. İşin kendi satırını seçin.'],
    ] as const) {
      screen.stdin.write('\r');
      await until(() => screen.stdout.frame.includes(WORKLINE_TEST_LABELS.work!.unavailable) && screen.stdout.frame.includes(work.jobs!.transcriptTitle), 'transcript unavailable for a worker without an Attempt');
      expect(inspectTranscript).not.toHaveBeenCalled();
      screen.stdin.write(ESC);
      await until(() => screen.stdout.frame.includes(work.live!.tasksHints!), 'return from unavailable transcript');
      screen.stdin.write('x');
      await settle(100);
      expect.soft(screen.stdout.text).toContain(feedback);
      expect(screen.stdout.frame).toContain(work.live!.tasksHints!);
      expect(screen.stdout.frame).not.toContain('C-PROMPT');
      expect(cancelRun).not.toHaveBeenCalled();
      screen.stdin.write('\u001b[B');
      await until(() => />[^\n]*Task 2 · unknown/u.test(screen.stdout.frame), 'second legacy source selected explicitly');
      screen.stdin.write('\u001b[B');
      await until(() => />[^\n]*run-a/u.test(screen.stdout.frame), 'Run row selected explicitly');
      screen.stdin.write('x');
      await until(() => screen.stdout.frame.includes('C-PROMPT'), 'Run cancellation approval still opens');
      expect(cancelRun).not.toHaveBeenCalled();
      screen.stdin.write('n');
      await until(() => screen.stdout.text.includes('C-KEPT run-a'), 'Run kept after denial');
    }
  });
});

class Screen extends Writable {
  frame = ''; text = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { if (chunk.length) { this.frame = chunk.toString('utf8'); this.text += this.frame; } done(); }
}
function keyboard() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  return stdin;
}
const mountedStandalone: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mountedStandalone.splice(0)) view.unmount(); });

describe('live window frame', () => {
  it('draws with ASCII characters only on an ASCII terminal and keeps the word cues without colour', async () => {
    const stdout = new Screen(100, 30), stdin = keyboard();
    const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(true) },
      createElement(WindowStackProvider, null, createElement(LiveWatchWindow, { data: { workers: [worker(0)], runs: [run(0, { cancellationRequested: true })] },
        labels: labelsOf(EN), position: EN.window.position, onClose: () => undefined }))) });
    const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mountedStandalone.push(instance);
    await settle(60);
    expect(stdout.frame).toContain(EN.live!.tasksTitle); expect(stdout.frame).toContain('Task 1'); expect(stdout.frame).toContain('cancel');
    expect(stdout.frame).toMatch(/\+-+\+/u); expect(stdout.frame).not.toMatch(/[╭╮╰╯│─]/u);
  });
});

describe('/monitor window', () => {
  const mountedViews: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const view of mountedViews.splice(0)) view.unmount(); });
  async function monitorPort(calls: string[] = []) {
    const surface = await loadMonitorSurface();
    return async () => { calls.push('load'); return surface.monitorWindowView({ load: async () => fullSnapshot, initial: fullSnapshot, intervalMs: 60_000, locale: 'en', ascii: false,
      palette: resolveWorklinePalette('none'), errorText: String }); };
  }

  it('opens the monitor inside a window frame, scopes its keys to the window, and q or Esc close it', async () => {
    const calls: string[] = [], sent: string[] = [];
    const view = mountWorkline({ monitorWindow: await monitorPort(calls), completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'ok'; } }); mountedViews.push(view.instance);
    await settle(20);
    expect(calls).toEqual([]); // The body loads on first use, not at start.
    view.stdin.write('/monitor\r');
    await until(() => view.stdout.frame.includes(EN.live!.monitorHints) && view.stdout.frame.includes('[1 '), 'monitor window with its tab bar');
    expect(calls).toEqual(['load']);
    // The monitor's own keys work inside the window (tab number), and typed text does not reach the composer.
    view.stdin.write('2'); await until(() => view.stdout.frame.includes('[2 '), 'tab 2 selected');
    view.stdin.write('hello\r'); await settle(60); expect(sent).toEqual([]);
    // Owner SW-2: Esc stops the open monitor window, including while its help is visible.
    view.stdin.write('?'); await settle(40); view.stdin.write(ESC); await settle(80);
    await until(() => !view.stdout.frame.includes(EN.live!.monitorHints), 'Esc at the top closes the window');
    view.stdin.write('hello\r'); await until(() => sent.length === 1, 'composer listens again');
    view.stdin.write('/monitor\r'); await until(() => view.stdout.frame.includes(EN.live!.monitorHints), 'reopened');
    view.stdin.write('q'); await until(() => !view.stdout.frame.includes(EN.live!.monitorHints), 'q closes');
  });

  it('without window words a typed /monitor argument keeps the text command; the bare command uses a window for the text port fallback', async () => {
    const calls: string[] = [];
    const view = mountWorkline({ monitor: async args => { calls.push(args); return ['TEXT-MONITOR']; } }); mountedViews.push(view.instance);
    await settle(20); view.stdin.write('/monitor --scope x\r');
    await until(() => calls.length === 1 && view.stdout.text.includes('TEXT-MONITOR'), 'typed text command (TERM=dumb style)');
    expect(calls).toEqual(['--scope x']); await settle(30);
    view.stdin.write('/monitor\r'); await until(() => view.stdout.frame.includes(EN.live!.monitorTitle) && calls.length === 2, 'fallback window');
    expect(calls).toEqual(['--scope x', '']); view.stdin.write(ESC); await until(() => view.stdout.frame.includes('Monitor closed'), 'summary');
  });

  it('keeps a monitor load failure in its window, then leaves one labelled summary', async () => {
    const view = mountWorkline({ monitorWindow: async () => { throw new Error('load-failed'); } }); mountedViews.push(view.instance);
    await settle(20); view.stdin.write('/monitor\r');
    await until(() => view.stdout.frame.includes('ERR:load-failed'), 'failure window');
    expect(view.stdout.frame).toContain(EN.live!.monitorTitle);
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes('◆ deckent system · Monitor closed'), 'summary');
  });

  it('an inactive or covered monitor body ignores keys and retains the selected Run', async () => {
    const surface = await loadMonitorSurface(), closed = vi.fn();
    const stdout = new Screen(100, 30), stdin = keyboard();
    const body = (active: boolean, covered = false) => createElement(Fragment, null,
      createElement(Box, { display: covered ? 'none' : 'flex' }, createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(surface.MonitorBody, {
        load: async () => fullSnapshot, initial: fullSnapshot, intervalMs: 60_000, locale: 'en', ascii: false, palette: resolveWorklinePalette('none'), errorText: String,
        active, covered, onClose: closed, escapeCloses: true, minRows: 6, size: { columns: 96, rows: 24 } }) })),
      covered ? createElement(Window, { title: [span('COVERING-WINDOW')], hints: '', position: '', onInput: () => true }) : null);
    const instance = render(body(false), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mountedStandalone.push(instance);
    await settle(60); stdin.write('q'); stdin.write(ESC); await settle(80); expect(closed).not.toHaveBeenCalled();
    instance.rerender(body(true)); await settle(60); closed.mockClear();
    stdin.write('2'); await until(() => stdout.frame.includes('[2 Runs]'), 'Runs tab');
    stdin.write('\u001b[B]'); await until(() => /›[ +*]│ run-broken-quiet\s/u.test(stdout.frame), 'second Run selected');
    instance.rerender(body(true, true));
    await until(() => stdout.frame.includes('COVERING-WINDOW'), 'cover visible');
    expect(stdout.frame).not.toContain('[2 Runs]');
    stdin.write('1'); stdin.write('q'); await settle(60); expect(closed).not.toHaveBeenCalled();
    instance.rerender(body(true));
    await until(() => /›[ +*]│ run-broken-quiet\s/u.test(stdout.frame), 'selection survives the cover');
    stdin.write('q'); await settle(60); expect(closed).toHaveBeenCalled();
  });

  it('fits a short terminal: the window never exceeds the rows it was given', async () => {
    const view = mountWorkline({ monitorWindow: await monitorPort() }, 100, { rows: 24 }); mountedViews.push(view.instance);
    await settle(20); view.stdin.write('/monitor\r');
    await until(() => view.stdout.frame.includes(EN.live!.monitorHints), 'window on 24 rows');
    const lines = view.stdout.frame.split('\n'), start = lines.findIndex(line => /[╭┌]/u.test(line)), end = lines.findIndex(line => /[╰└]/u.test(line));
    expect(start).toBeGreaterThanOrEqual(0); expect(end - start + 1).toBeLessThanOrEqual(24 - 8);
  });
});

describe('/monitor window through the real terminal entry', () => {
  const roots: string[] = [];
  afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it.skipIf(process.platform === 'win32')('binds the monitor window to the host snapshot port, loads it on first use, and Esc returns to the composer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-live-window-')); roots.push(root);
    const project = join(root, 'project'), home = join(root, 'home');
    await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(home, { recursive: true })]);
    const actor = readLocalOsIdentity();
    await writeFile(join(project, '.deckent/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
      grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
    const stdout = new Screen(120, 40), stdin = keyboard(), reads: string[] = [];
    // The screen as the terminal shows it now, replayed from every byte written (CI 2026-10-18: the full window redraws only changed rows, so
    // the last synchronized block alone is not the screen — a frame that only moved the spinner lacked the window's hints and looked closed).
    const lastFrame = () => terminalBuffers(stdout.text.replaceAll('\u001b[?1000h', '').replaceAll('\u001b[?1006h', ''), 120, 40).text;
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'tr'], { root: project, env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      DECKENT_GLOBAL_HOME: join(home, 'global'), NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
      ensureTerminalIdentity: ensureConfiguredTerminalIdentity, async completeTerminalChat() { return 'x'; },
      async inspectMonitor(rootArg: string) { reads.push(rootArg); return fullSnapshot; } } as never);
    await until(() => stdout.text.includes('Bir görev yaz'), 'terminal open');
    expect(reads).toEqual([]); // nothing is read until /monitor opens
    stdin.write('/monitor\r');
    await until(() => lastFrame().includes(TR.live!.monitorHints) && reads.length >= 1, 'monitor window in Turkish through the host port');
    expect(lastFrame()).toContain(TR.live!.monitorTitle); expect(reads.every(read => read === project)).toBe(true);
    stdin.write(ESC); await until(() => !lastFrame().includes(TR.live!.monitorHints), 'Esc closes');
    stdin.write('/exit\r'); expect(await run).toBe(0);
  }, 20_000);
});
