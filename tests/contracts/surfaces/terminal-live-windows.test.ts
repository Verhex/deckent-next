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
import { immediateSlashAction, liveWindowClosedText, liveWindowLines, liveWindowStatus, liveWindowTitle, LIVE_WINDOW_MAX_ROWS, type LiveWindowRenderLabels } from '#surfaces/core/terminal-work/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal/index.js';
import { LiveWatchWindow } from '#surfaces/core/terminal-work/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { RenderGlyphsContext, plainText, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { WORKER_LINE_EN } from '../support/worker-line-labels.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';

/** T3 L5: `/monitor`, `/watch-workers`, `/watch-runs` and `/tasks` as bounded modal windows. */
const ESC = '\u001B';
const EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr');
const labelsOf = (work: typeof EN): LiveWindowRenderLabels => ({ live: work.live!, panel: work.panel, workerLine: WORKER_LINE_EN });
const worker = (index: number): WorkLedgerWorkerEntry => ({ schemaVersion: 1, kind: 'worker', id: `w-${index}`, scopeId: 'scope-a', taskId: `task-${index}`, process: 'running',
  provider: 'docker', authority: 'next-ledger', ordinal: index + 1 });
const run = (index: number, extra: Partial<WorkLedgerRunEntry> = {}): WorkLedgerRunEntry => ({ schemaVersion: 1, kind: 'run', id: `r-${index}`, runId: `run-${index}`, scopeId: 'scope-a',
  revision: index + 1, cancellationRequested: false, taskPhases: 'active:1', ...extra });

describe('live window content (pure)', () => {
  it('words workers, runs and the combined tasks window in the session language, with an empty line before the first read', () => {
    for (const [locale, work] of [['en', EN], ['tr', TR]] as const) {
      const labels = labelsOf(work);
      const rows = (kind: 'workers' | 'runs' | 'tasks', data: { workers: WorkLedgerWorkerEntry[]; runs: WorkLedgerRunEntry[] }) => liveWindowLines(kind, data, labels).map(line => plainText(line.spans));
      expect(rows('workers', { workers: [], runs: [] }), locale).toEqual([work.live!.empty]);
      expect(rows('runs', { workers: [], runs: [] }), locale).toEqual([work.live!.empty]);
      expect(rows('workers', { workers: [worker(0)], runs: [] })[0]).toContain('worker 1');
      expect(rows('runs', { workers: [], runs: [run(0, { cancellationRequested: true })] })[0]).toContain(shortId('run-0'));
      const tasks = rows('tasks', { workers: [worker(0)], runs: [run(0)] });
      expect(tasks[0]).toBe(work.panel.title); expect(tasks).toContain(work.live!.runsTitle); expect(tasks).toContain('');
      expect(liveWindowStatus('tasks', { workers: [worker(0)], runs: [run(0), run(1)] }, labels)).toBe(locale === 'en' ? '1 workers · 2 runs' : '1 işçi · 2 iş');
      expect(liveWindowTitle('runs', labels)).toBe(work.live!.runsTitle);
      expect(liveWindowClosedText('tasks', { workers: [worker(0)], runs: [run(0)] }, work.live!)).toContain('1');
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
});

describe('live window commands (pure)', () => {
  const ledger = { scopeId: 'scope-a', async listWorkers() { return null as never; }, async inspectRun() { return null; }, async listRunIds() { return []; } };
  const context = (extra: Record<string, unknown> = {}) => ({ ledger: ledger as never, labels: WORKLINE_TEST_LABELS as never, watch: { workers: false, runs: false }, ...extra });
  it('opens the matching window and starts exactly the feeds it shows', () => {
    expect(immediateSlashAction('watch-workers', context())).toMatchObject({ window: 'workers', watch: { workers: true, runs: false } });
    expect(immediateSlashAction('watch-runs', context())).toMatchObject({ window: 'runs', watch: { workers: false, runs: true } });
    expect(immediateSlashAction('tasks', context())).toMatchObject({ window: 'tasks', watch: { workers: true, runs: true } });
    // A ledger that cannot list runs follows workers only.
    expect(immediateSlashAction('tasks', context({ ledger: { ...ledger, listRunIds: undefined } }))).toMatchObject({ window: 'tasks', watch: { workers: true, runs: false } });
  });
  it('opens an already followed feed without announcing it again, and /watch-stop closes the window', () => {
    expect(immediateSlashAction('watch-workers', context({ watch: { workers: true, runs: false } }))).toEqual({ entries: [], window: 'workers' });
    expect(immediateSlashAction('watch-stop', context({ watch: { workers: true, runs: true } }))).toMatchObject({ window: null, watch: { workers: false, runs: false } });
    expect(immediateSlashAction('watch-stop', context())).toEqual({ entries: [] });
  });
  it('refuses with a typed notice when there is no ledger, no run listing for /watch-runs, or no window words', () => {
    expect(immediateSlashAction('tasks', context({ ledger: undefined }))?.entries[0]).toMatchObject({ kind: 'notice', level: 'error' });
    expect(immediateSlashAction('watch-runs', context({ ledger: { ...ledger, listRunIds: undefined } }))?.entries[0]).toMatchObject({ level: 'error' });
    const bare = { ...WORKLINE_TEST_LABELS, work: { ...WORKLINE_TEST_LABELS.work!, live: undefined } } as never;
    const result = immediateSlashAction('watch-workers', context({ labels: bare }));
    expect(result?.window).toBeUndefined(); expect(result?.watch).toBeUndefined(); expect(result?.entries[0]).toMatchObject({ level: 'error' });
  });
});

describe('live windows in the workline', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
  const report = (count: number) => ({ schemaVersion: 1, scopeId: 'scope-a', sources: [{ workers: Array.from({ length: count }, (_, index) => ({
    taskId: `task-${index}`, process: 'running', provider: 'docker', authority: 'next-ledger' })) }] }) as never;
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it('/watch-workers updates the worker list in place, takes the keyboard from the composer, and Esc closes it, stops the watch and leaves one line', async () => {
    let count = 1, calls = 0;
    const sent: string[] = [];
    const view = mountWorkline({ pollMs: 20, completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'ok'; },
      ledger: { scopeId: 'scope-a', async listWorkers() { calls++; return report(count); }, async inspectRun() { return null; } } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/watch-workers\r');
    await until(() => view.stdout.frame.includes('LIVE-PANEL') && view.stdout.frame.includes('worker 1 · docker'), 'window with the first worker');
    expect(view.stdout.frame).toContain(EN.live!.hints);
    // The window owns the keyboard: typed text and Enter do not reach the composer.
    view.stdin.write('hello\r'); await settle(60); expect(sent).toEqual([]);
    count = 2; await until(() => view.stdout.frame.includes('worker 2 · docker'), 'the second worker appears in the open window');
    // In place: one row each, no card appended to the scrollback.
    expect(occurrences(view.stdout.frame, 'worker 1 · docker')).toBe(1); expect(occurrences(view.stdout.frame, 'worker 2 · docker')).toBe(1);
    view.stdin.write(ESC);
    await until(() => view.stdout.frame.includes(EN.live!.closedWorkers.replace('{count}', '2')) && !view.stdout.frame.includes('LIVE-PANEL'), 'Esc closes the window and leaves the summary');
    const after = calls; await settle(120); expect(calls - after).toBeLessThanOrEqual(1);
    view.stdin.write('hello\r'); await until(() => sent.length === 1, 'the composer listens again');
  });

  it('/tasks shows workers and runs together; the finished output stays in the scrollback', async () => {
    const inspected = vi.fn(async (runId: string) => ({ runId, scopeId: 'scope-a', revision: 3, cancellationRequested: false, tasks: [{ phase: 'active' }] }) as never);
    const view = mountWorkline({ pollMs: 20, ledger: { scopeId: 'scope-a', async listWorkers() { return report(1); }, async listRunIds() { return ['run-a']; }, inspectRun: inspected } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/tasks\r');
    await until(() => view.stdout.frame.includes(EN.live!.tasksTitle) && view.stdout.frame.includes('worker 1') && view.stdout.frame.includes('rev 3'), 'both lists in one window');
    expect(view.stdout.frame).toContain(EN.live!.runsTitle); expect(view.stdout.frame).toContain('1 workers · 1 runs');
    view.stdin.write(ESC);
    await until(() => !view.stdout.frame.includes(EN.live!.hints) && view.stdout.frame.includes('1 workers and 1 runs at the last read'), 'closed with the summary');
  });

  it('/watch-runs follows runs only', async () => {
    let workerReads = 0;
    const view = mountWorkline({ pollMs: 20, ledger: { scopeId: 'scope-a', async listWorkers() { workerReads++; return report(1); }, async listRunIds() { return ['run-b']; },
      async inspectRun(runId: string) { return { runId, scopeId: 'scope-a', revision: 7, cancellationRequested: true, tasks: [] } as never; } } }); mounted.push(view.instance);
    await settle(20); view.stdin.write('/watch-runs\r');
    await until(() => view.stdout.frame.includes(EN.live!.runsTitle) && view.stdout.frame.includes('rev 7') && view.stdout.frame.includes('cancel'), 'run row with the requested cancellation');
    expect(workerReads).toBe(0);
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes('1 runs at the last read'), 'closed');
  });

  it('refuses /tasks and /watch-workers without a ledger and opens no window', async () => {
    const view = mountWorkline({}); mounted.push(view.instance);
    await settle(20); view.stdin.write('/tasks\r'); await until(() => view.stdout.text.includes('NO-LEDGER') || view.stdout.text.includes('UNWIRED'), 'refused');
    expect(view.stdout.frame).not.toContain(EN.live!.tasksTitle);
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
      createElement(WindowStackProvider, null, createElement(LiveWatchWindow, { kind: 'tasks', data: { workers: [worker(0)], runs: [run(0, { cancellationRequested: true })] },
        labels: labelsOf(EN), position: EN.window.position, onClose: () => undefined }))) });
    const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mountedStandalone.push(instance);
    await settle(60);
    expect(stdout.frame).toContain(EN.live!.tasksTitle); expect(stdout.frame).toContain('worker 1'); expect(stdout.frame).toContain('cancel');
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

  it('refuses typed /monitor arguments in a window and uses a window for the text port fallback', async () => {
    const calls: string[] = [];
    const view = mountWorkline({ monitor: async args => { calls.push(args); return ['TEXT-MONITOR']; } }); mountedViews.push(view.instance);
    await settle(20); view.stdin.write('/monitor --scope x\r');
    await until(() => view.stdout.frame.includes('without arguments'), 'argument refusal window');
    expect(calls).toEqual([]); expect(view.stdout.frame).not.toContain('TEXT-MONITOR');
    view.stdin.write(ESC); await until(() => view.stdout.frame.includes('Monitor closed'), 'summary'); await settle(30);
    view.stdin.write('/monitor\r'); await until(() => view.stdout.frame.includes('TEXT-MONITOR'), 'fallback window');
    expect(calls).toEqual(['']); view.stdin.write(ESC);
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
