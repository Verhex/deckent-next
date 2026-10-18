import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortId, clearConfigCache } from '#platform/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { ensureConfiguredTerminalIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { main } from '../../../src/surfaces/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { immediateSlashAction, liveRunEntry, liveWindowClosedText, liveWindowLines, liveWindowStatus, LIVE_WINDOW_MAX_ROWS, runsRowKey, runsRowKeys, runsTabLine, runsWindowHints, type LiveWindowRenderLabels } from '#surfaces/core/terminal-work/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal/index.js';
import { RunsLiveWindow } from '#surfaces/core/terminal-work/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { RenderGlyphsContext, plainText, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { WORKER_LINE_EN } from '../support/worker-line-labels.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';

/** T3 L5 / K1: `/monitor` and the one Runs window as bounded windows. */
const ESC = '\u001B';
const EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr');
const labelsOf = (work: typeof EN): LiveWindowRenderLabels => ({ live: work.live!, panel: work.panel, workerLine: WORKER_LINE_EN });
const worker = (index: number): WorkLedgerWorkerEntry => ({ schemaVersion: 1, kind: 'worker', id: `w-${index}`, scopeId: 'scope-a', taskId: `task-${index}`, process: 'running',
  provider: 'docker', authority: 'next-ledger', ordinal: index + 1 });
const run = (index: number, extra: Partial<WorkLedgerRunEntry> = {}): WorkLedgerRunEntry => ({ schemaVersion: 1, kind: 'run', id: `r-${index}`, runId: `run-${index}`, scopeId: 'scope-a',
  revision: index + 1, cancellationRequested: false, taskPhases: 'active:1', ...extra });

describe('live window content (pure)', () => {
  it('words the runs and workers tabs in the session language, with an empty line before the first read', () => {
    for (const [locale, work] of [['en', EN], ['tr', TR]] as const) {
      const labels = labelsOf(work);
      const rows = (tab: 'workers' | 'runs', data: { workers: WorkLedgerWorkerEntry[]; runs: WorkLedgerRunEntry[] }) => liveWindowLines(tab, data, labels).map(line => plainText(line.spans));
      expect(rows('workers', { workers: [], runs: [] }), locale).toEqual([work.live!.empty]);
      expect(rows('runs', { workers: [], runs: [] }), locale).toEqual([work.live!.empty]);
      expect(rows('workers', { workers: [worker(0)], runs: [] })[0]).toContain('worker 1');
      expect(rows('runs', { workers: [], runs: [run(0, { cancellationRequested: true })] })[0]).toContain(shortId('run-0'));
      expect(liveWindowStatus({ workers: [worker(0)], runs: [run(0), run(1)] }, labels)).toBe(locale === 'en' ? '1 workers · 2 runs' : '1 işçi · 2 iş');
      expect(plainText(runsTabLine('runs', { workers: [worker(0)], runs: [run(0), run(1)] }, work.live!).spans)).toBe(`[${work.live!.tabRuns} 2]   ${work.live!.tabWorkers} 1 `);
      expect(liveWindowClosedText({ workers: [worker(0)], runs: [run(0)] }, work.live!)).toContain('1');
    }
  });
  it('K5: the unfocused close key is named in the Runs window hints and in the ? shortcuts panel, in both languages; Ctrl+O/Ctrl+T keep their words', () => {
    for (const locale of ['en', 'tr'] as const) {
      const work = workSurfaceLabels(locale), panel = terminalComposerLabels(locale).shortcuts;
      expect(work.live!.runsHints).toContain('Ctrl+X'); expect(panel.split('\n').some(line => line.startsWith('Ctrl+X  '))).toBe(true);
      expect(work.activeWork!.title).toContain('Ctrl+T');
    }
  });
  it('bounds a list at the ledger tail limit and says how many rows are not shown', () => {
    const labels = labelsOf(EN), many = Array.from({ length: LIVE_WINDOW_MAX_ROWS + 5 }, (_, index) => worker(index));
    const rows = liveWindowLines('workers', { workers: many, runs: [] }, labels).map(line => plainText(line.spans));
    expect(rows).toHaveLength(LIVE_WINDOW_MAX_ROWS + 1);
    expect(rows.at(-1)).toBe(EN.panel.more.replace('{count}', '5'));
    const runs = liveWindowLines('runs', { workers: [], runs: Array.from({ length: LIVE_WINDOW_MAX_ROWS + 2 }, (_, index) => run(index)) }, labels).map(line => plainText(line.spans));
    expect(runs.at(-1)).toBe(EN.live!.runsMore.replace('{count}', '2'));
  });
  it('offers a row only the keys its state and this terminal allow (K4/K6/K7, Y1); the hints name exactly those keys', () => {
    const view = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => liveRunEntry({ runId: 'run-a', scopeId: 'scope-a', revision: 2, cancellationRequested: false,
      tasks: [{ id: 'task-a', phase: 'awaiting-decision', ...extra }], state } as never, 'r');
    const all = { cancel: true, control: true, answer: true, deliverable: () => false };
    expect(runsRowKeys(view({ kind: 'running' }), all)).toEqual(['cancel', 'hold']);
    const asking = view({ kind: 'parked', reason: 'needs-input', since: 1, deadline: 2 }, { decision: { reason: 'needs-input', question: 'Which branch?', since: 1, deadline: 2 } });
    expect(runsRowKeys(asking, all)).toEqual(['cancel', 'hold', 'close', 'answer']);
    expect(runsRowKeys(asking, { ...all, answer: false, control: false })).toEqual(['cancel']);
    expect(runsRowKeys(view({ kind: 'terminal', outcome: 'completed' }), { ...all, deliverable: () => true })).toEqual(['deliver']);
    expect(runsRowKeys(view({ kind: 'terminal', outcome: 'completed' }), all)).toEqual([]);
    expect(runsRowKeys(worker(0), all)).toEqual(['cancel']); expect(runsRowKeys(worker(0), { ...all, cancel: false })).toEqual([]);
    expect(runsRowKey('x', {})).toBe('cancel'); expect(runsRowKey('x', { ctrl: true })).toBeNull(); expect(runsRowKey('xd', {})).toBeNull(); expect(runsRowKey('q', {})).toBeNull();
    const labels = { ...labelsOf(EN), runControl: EN.runControl };
    expect(runsWindowHints('runs', ['cancel', 'hold', 'deliver'], labels)).toBe([EN.live!.runsHints, EN.live!.keys.detail, EN.live!.keys.cancel, EN.runControl!.keyHold, EN.live!.keys.deliver].join(' · '));
    expect(runsWindowHints('workers', [], labels)).toBe([EN.live!.runsHints, EN.live!.keys.transcript].join(' · '));
  });
});

describe('Runs window command (pure)', () => {
  const ledger = { scopeId: 'scope-a', async listWorkers() { return null as never; }, async inspectRun() { return null; }, async listRunIds() { return []; } };
  const context = (extra: Record<string, unknown> = {}) => ({ ledger: ledger as never, labels: WORKLINE_TEST_LABELS as never, watch: { workers: false, runs: false }, ...extra });
  it('opens the Runs window and starts exactly the feeds it shows; an already followed feed is not announced again', () => {
    expect(immediateSlashAction('runs', context())).toMatchObject({ window: 'runs', watch: { workers: true, runs: true } });
    // A ledger that cannot list runs follows workers only.
    expect(immediateSlashAction('runs', context({ ledger: { ...ledger, listRunIds: undefined } }))).toMatchObject({ window: 'runs', watch: { workers: true, runs: false } });
    expect(immediateSlashAction('runs', context({ watch: { workers: true, runs: true } }))).toEqual({ entries: [], window: 'runs' });
  });
  it('the eight old names and /quit are moved, never run (K2): a typed notice names the new command', () => {
    for (const [old, now] of [['workers', 'runs'], ['watch-workers', 'runs'], ['watch-runs', 'runs'], ['watch-stop', 'runs'], ['tasks', 'runs'], ['run', 'runs'], ['transcript', 'runs'], ['cancel', 'runs'], ['quit', 'exit']]) {
      const result = immediateSlashAction(old!, context());
      expect(result).toEqual({ entries: [expect.objectContaining({ kind: 'notice', level: 'error', text: `MOVED /${old} /${now}` })] });
    }
    expect(immediateSlashAction('plan', context())?.entries[0]).toMatchObject({ level: 'error', text: 'UNKNOWN: /plan' });
  });
  it('refuses with a typed notice when there is no ledger or no window words', () => {
    expect(immediateSlashAction('runs', context({ ledger: undefined }))?.entries[0]).toMatchObject({ kind: 'notice', level: 'error' });
    const bare = { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, live: undefined } } as never;
    const result = immediateSlashAction('runs', context({ labels: bare }));
    expect(result?.window).toBeUndefined(); expect(result?.watch).toBeUndefined(); expect(result?.entries[0]).toMatchObject({ level: 'error' });
  });
});

describe('live windows in the workline', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
  const report = (count: number) => ({ schemaVersion: 1, scopeId: 'scope-a', sources: [{ workers: Array.from({ length: count }, (_, index) => ({
    taskId: `task-${index}`, process: 'running', provider: 'docker', authority: 'next-ledger' })) }] }) as never;
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  const CTRL_O = '\u000F', CTRL_X = '\u0018', TAB = '\t';
  it('/runs workers tab updates in place; in the background the composer keeps input and Ctrl+X closes it and stops the feed (K5)', async () => {
    let count = 1, calls = 0;
    const sent: string[] = [];
    const view = mountWorkline({ pollMs: 20, completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'ok'; },
      ledger: { scopeId: 'scope-a', async listWorkers() { calls++; return report(count); }, async inspectRun() { return null; } } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/runs\r');
    await until(() => view.stdout.frame.includes(EN.live!.runsTitle), 'the Runs window');
    view.stdin.write(TAB); await until(() => view.stdout.frame.includes('worker 1 · docker'), 'workers tab with the first worker');
    expect(view.stdout.frame).toContain(EN.live!.runsHints);
    // Opened by the person it took focus; Ctrl+O gives input back to the composer while the window stays and updates.
    view.stdin.write(CTRL_O); await settle(30);
    view.stdin.write('hello\r'); await until(() => sent.length === 1, 'composer while observing');
    count = 2; await until(() => view.stdout.frame.includes('worker 2 · docker'), 'the second worker appears in the open window');
    // In place: one row each, no card appended to the scrollback.
    expect(occurrences(view.stdout.frame, 'worker 1 · docker')).toBe(1); expect(occurrences(view.stdout.frame, 'worker 2 · docker')).toBe(1);
    // Ctrl+X is not composer text: a draft stays as typed and the window closes.
    view.stdin.write('draft'); await settle(30); view.stdin.write(CTRL_X);
    await until(() => view.stdout.frame.includes('2 workers and 0 runs at the last read') && !view.stdout.frame.includes(EN.live!.runsHints), 'Ctrl+X closes the window and leaves the summary');
    expect(view.stdout.frame).toContain('draft');
    const after = calls; await settle(120); expect(calls - after).toBeLessThanOrEqual(1);
    view.stdin.write('\u0015hello\r'); await until(() => sent.length === 2, 'the composer listens again');
  });

  it('/runs shows runs and workers in tabs; the finished output stays in the scrollback', async () => {
    const inspected = vi.fn(async (runId: string) => ({ runId, scopeId: 'scope-a', revision: 3, cancellationRequested: false, tasks: [{ phase: 'active' }] }) as never);
    const view = mountWorkline({ pollMs: 20, ledger: { scopeId: 'scope-a', async listWorkers() { return report(1); }, async listRunIds() { return ['run-a']; }, inspectRun: inspected } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/runs\r');
    await until(() => view.stdout.frame.includes(EN.live!.runsTitle) && view.stdout.frame.includes('rev 3'), 'runs tab');
    expect(view.stdout.frame).toContain('1 workers · 1 runs');
    view.stdin.write(TAB); await until(() => view.stdout.frame.includes('worker 1'), 'workers tab');
    view.stdin.write(ESC);
    await until(() => !view.stdout.frame.includes(EN.live!.runsHints) && view.stdout.frame.includes('1 workers and 1 runs at the last read'), 'closed with the summary');
  });

  it('/runs Enter opens the Run detail, Enter on a worker its transcript, and x uses the refreshed run cancellation approval; opening a card never cancels (K4)', async () => {
    const attempt = { scopeId: 'scope-a', runId: 'run-a', taskId: 'task-0', attemptId: 'attempt-a' };
    const cancelled: unknown[][] = [], transcripts: unknown[] = [];
    let revision = 3;
    const view = mountWorkline({ pollMs: 20, ledger: { scopeId: 'scope-a', listWorkers: async () => ({ schemaVersion: 1, scopeId: 'scope-a', sources: [{
      workers: [{ taskId: 'task-0', process: 'running', provider: 'docker', authority: 'next-ledger', identity: attempt }] }] }) as never,
      listRunIds: async () => ['run-a'], inspectRun: async () => ({ runId: 'run-a', scopeId: 'scope-a', revision, cancellationRequested: false,
        tasks: [{ id: 'task-0', phase: 'active', taskBrief: { task: 'ORDER-RUN' } }], state: { kind: 'running' } }) as never,
      inspectTranscript: async target => { transcripts.push(target); return 'SELECTED-TRANSCRIPT'; },
      cancelRun: async (...args) => { cancelled.push(args); return 'CANCELLED-SELECTED-RUN'; },
    } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/runs\r'); await until(() => view.stdout.frame.includes('ORDER-RUN') && view.stdout.frame.includes(EN.live!.keys.cancel), 'run row with its keys');
    view.stdin.write('\r'); await until(() => view.stdout.frame.includes(EN.jobs!.state) && view.stdout.frame.includes(EN.jobs!.attempts), 'run detail window');
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes(EN.live!.runsHints), 'runs returns');
    view.stdin.write(TAB); await until(() => view.stdout.frame.includes('worker 1'), 'workers tab');
    view.stdin.write('\r'); await until(() => view.stdout.frame.includes('SELECTED-TRANSCRIPT'), 'selected transcript');
    expect(transcripts).toEqual([attempt]); expect(cancelled).toEqual([]);
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes(EN.live!.runsHints), 'runs returns again');
    view.stdin.write(TAB); await until(() => view.stdout.frame.includes(EN.live!.keys.detail), 'runs tab');
    revision = 9; view.stdin.write('x'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'existing cancel approval');
    expect(view.stdout.frame).toContain('9'); expect(cancelled).toEqual([]);
    view.stdin.write('n'); await until(() => view.stdout.text.includes('C-KEPT'), 'deny keeps run'); expect(cancelled).toEqual([]);
    await until(() => view.stdout.frame.includes(EN.live!.runsHints), 'runs after denial');
    view.stdin.write('x'); await until(() => view.stdout.frame.includes('C-PROMPT'), 'cancel approval again'); view.stdin.write('y');
    await until(() => cancelled.length === 1, 'approved cancellation'); expect(cancelled).toEqual([['run-a', 9]]);
  });

  it('a row key its state does not offer does nothing: no x on a finished Run, no h/r/c/a/d without their ports', async () => {
    const cancelled: unknown[] = [];
    const view = mountWorkline({ pollMs: 20, ledger: { scopeId: 'scope-a', listWorkers: async () => report(0), listRunIds: async () => ['run-z'],
      inspectRun: async () => ({ runId: 'run-z', scopeId: 'scope-a', revision: 4, cancellationRequested: false, tasks: [{ id: 't', phase: 'completed', taskBrief: { task: 'DONE-RUN' } }],
        state: { kind: 'terminal', outcome: 'completed' } }) as never, cancelRun: async (...args) => { cancelled.push(args); return 'NO'; } } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/runs\r'); await until(() => view.stdout.frame.includes('DONE-RUN'), 'finished run row');
    expect(view.stdout.frame).not.toContain(EN.live!.keys.cancel);
    for (const key of ['x', 'h', 'r', 'c', 'a', 'd']) { view.stdin.write(key); await settle(30); }
    expect(view.stdout.frame).not.toContain('C-PROMPT'); expect(cancelled).toEqual([]);
    expect(view.stdout.frame).toContain(EN.live!.runsHints);
  });

  it('refuses /runs without a ledger and opens no window', async () => {
    const view = mountWorkline({}); mounted.push(view.instance);
    await settle(20); view.stdin.write('/runs\r'); await until(() => view.stdout.text.includes('NO-LEDGER') || view.stdout.text.includes('UNWIRED'), 'refused');
    expect(view.stdout.frame).not.toContain(EN.live!.runsHints);
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
      createElement(WindowStackProvider, null, createElement(RunsLiveWindow, { data: { workers: [worker(0)], runs: [run(0, { cancellationRequested: true })] },
        labels: labelsOf(EN), position: EN.window.position, offer: { cancel: true, control: false, answer: false, deliverable: () => false }, onClose: () => undefined }))) });
    const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mountedStandalone.push(instance);
    await settle(60);
    expect(stdout.frame).toContain(EN.live!.runsTitle); expect(stdout.frame).toContain(shortId('run-0')); expect(stdout.frame).toContain('cancel');
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
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes('◆ Deckent system · Monitor closed'), 'summary');
  });

  it('an inactive monitor body ignores keys (a window below the top layer must not react)', async () => {
    const surface = await loadMonitorSurface(), closed = vi.fn();
    const stdout = new Screen(100, 30), stdin = keyboard();
    const body = (active: boolean) => createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(surface.MonitorBody, {
      load: async () => fullSnapshot, initial: fullSnapshot, intervalMs: 60_000, locale: 'en', ascii: false, palette: resolveWorklinePalette('none'), errorText: String,
      active, onClose: closed, escapeCloses: true, minRows: 6, size: { columns: 96, rows: 12 } }) });
    const instance = render(body(false), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mountedStandalone.push(instance);
    await settle(60); stdin.write('q'); stdin.write(ESC); await settle(80); expect(closed).not.toHaveBeenCalled();
    instance.rerender(body(true)); await settle(60); closed.mockClear(); stdin.write('q'); await settle(60); expect(closed).toHaveBeenCalled();
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
    // The last painted frame: Ink's synchronized-update block (a single write ends the screen state).
    const lastFrame = () => { const at = stdout.text.lastIndexOf('\u001B[?2026h'); return at >= 0 ? stdout.text.slice(at) : stdout.text; };
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
