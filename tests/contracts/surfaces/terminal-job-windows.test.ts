import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { Box, Text, useApp } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIVERY_SUMMARY_ACTIONS, deliverySummarySchema, projectResultBrief, targetQueueViewSchema, type RunView } from '#engine/index.js';
import { fillTemplate, type WorkLedgerEntry, type WorklineLedgerPorts, type WorklineApproval } from '#surfaces/core/terminal-ledger/index.js';
import { ticketSummaryBlock } from '#surfaces/core/delivery-summary/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { openingWorkText, runDetailLines, runLedgerCommand } from '#surfaces/core/terminal-work/index.js';
import { DECISION_ARM_DEFAULT } from '#surfaces/core/terminal-window/index.js';
import { CLEAR_VISIBLE_SCREEN, resolveWorklinePalette, WorklineApp } from '#surfaces/core/terminal/index.js';
import { openTerminalHost } from '#surfaces/core/terminal-host/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS, TYPED_ARGUMENT_NOTE } from '../support/slash-window-labels.js';
import { panelFixture } from '../support/workline-panel-fixture.js';
import { terminalScreen } from '../../fixtures/terminal-screen.js';

const captured = vi.hoisted(() => ({ entries: [] as WorkLedgerEntry[], seen: new WeakSet<object>() }));
vi.mock('#surfaces/core/terminal-work/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#surfaces/core/terminal-work/index.js')>();
  return { ...original, LedgerEntryRow(props: Parameters<typeof original.LedgerEntryRow>[0]) {
    if (!captured.seen.has(props.entry)) { captured.seen.add(props.entry); captured.entries.push(props.entry); }
    return createElement(original.LedgerEntryRow, props);
  } };
});
const EN = workSurfaceLabels('en'), ESC = '\u001B';
const runId = '3f2a9c1e-8b4d-4e7a-9c55-1d2e3f4a5b6c', attemptId = '4b0c9811-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const run = { schemaVersion: 3, runId, scopeId: 'scope-a', revision: 7, cancellationRequested: false, state: { kind: 'running' }, tasks: [{ id: 'task-id', phase: 'active',
  taskBrief: { schemaVersion: 1, task: 'Fix checkout', model: null, scopePaths: [], acceptance: null, criteria: [], profile: null, effort: null, contextRefs: [] }, resultBrief: projectResultBrief(attemptId, { verdict: 'accepted' }, null, { state: 'delivered', commit: '0123456789abcdef' }) }] } as unknown as RunView;
const approval: WorklineApproval = { approvalId: 'approval-1', revision: 2, summary: 'Review checkout', expiresAt: Date.now() + 600_000, runId, taskId: 'task-id', requester: 'owner', status: 'pending', decision: null };
function ports(extra: Partial<WorklineLedgerPorts> = {}): WorklineLedgerPorts {
  return { scopeId: 'scope-a', listRunIds: async () => [runId], inspectRun: async id => id === runId ? run : null,
    listWorkers: async () => ({ schemaVersion: 1, observedAt: Date.now(), scopeId: 'scope-a', sources: [{ workers: [{ taskId: 'task-id', process: 'running', provider: 'codex', authority: 'next-ledger',
      identity: { scopeId: 'scope-a', runId, taskId: 'task-id', attemptId, generation: 1, layoutRevision: 'layout' } }] }] }) as never,
    inspectTranscript: async () => Array.from({ length: 90 }, (_, i) => `TRANSCRIPT ${i}`).join('\n'), listApprovalPage: async () => ({ items: [approval], nextAfter: null }),
    decideApproval: async (_target, decision) => ({ ...approval, decision, status: 'decided' }), cancelRun: async () => 'Cancellation requested', ...extra };
}
const mounted: ReturnType<typeof mountWorkline>[] = [];
let renderDir: string;
beforeEach(async () => { captured.entries = []; captured.seen = new WeakSet(); renderDir = await mkdtemp(join(tmpdir(), 'sw2-window-render-')); });
afterEach(async () => { for (const view of mounted.splice(0)) view.instance.unmount(); vi.useRealTimers(); await rm(renderDir, { recursive: true, force: true }); });
const open = async (command: string, ledger = ports(), locale: 'en' | 'tr' = 'en', rows = 60, rich = false,
  screen?: { readonly columns: number; readonly onFrame: (frame: string) => void }) => {
  const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale),
    ...(rich ? { windows: SLASH_WINDOW_TEST_LABELS, focus: { composer: 'INPUT FOCUS', window: 'WINDOW FOCUS' } } : {}) };
  const view = mountWorkline({ labels, ledger, pollMs: 60_000 }, screen?.columns ?? 100, { rows, ...screen }); mounted.push(view);
  await settle(30); view.stdin.write(`${command}\r`); return view;
};
const choose = async (view: ReturnType<typeof mountWorkline>) => { await settle(40); view.stdin.write('\r'); };
const close = async (view: ReturnType<typeof mountWorkline>) => { await settle(40); view.stdin.write(ESC); await until(() => captured.entries.length > 0, 'summary'); };
async function snapshot(name: string, view: ReturnType<typeof mountWorkline>) {
  await writeFile(join(renderDir, `${name}.txt`), view.stdout.frame);
  const captureRoot = process.env['SW2_CAPTURE_DIR'];
  if (captureRoot && captureRoot.startsWith(`${tmpdir()}/`)) await writeFile(join(captureRoot, `${name}.txt`), view.stdout.frame);
}
function onlySummary() { expect(captured.entries).toHaveLength(1); expect(captured.entries[0]).toMatchObject({ kind: 'notice', id: 'system-summary' }); }

async function chooseScrolledTranscript() {
  const base = ports(), initial = await base.listWorkers(), source = initial.sources[0]!, first = source.workers[0]!;
  const [eighth, ...visible] = Array.from({ length: 7 }, (_, index) => ({
    ...first, identity: { ...first.identity!, attemptId: `${index + 1}0${attemptId.slice(2)}` },
  }));
  const intervening = { ...first, identity: { ...first.identity!, attemptId: `80${attemptId.slice(2)}` } };
  let workers = [visible[1]!, visible[0]!, ...visible.slice(2), first, eighth!];
  const reading = Promise.withResolvers<void>(), transcript = Promise.withResolvers<string>();
  const inspect = vi.fn(base.inspectTranscript!).mockImplementationOnce(() => { reading.resolve(); return transcript.promise; });
  const ledger = { ...base, inspectTranscript: inspect, listWorkers: async () => ({ ...initial, sources: [{ ...source, workers }] }) };
  const labels = { ...WORKLINE_TEST_LABELS, work: EN };
  // The terminal has room for the number, but the window's border and padding take it away.
  const drawn = Promise.withResolvers<string>();
  const view = await open('/transcript', ledger, 'en', 24, true, { columns: 10, onFrame: frame => {
    const row = frame.split('\n').find(line => line.includes('> T'));
    if (row) drawn.resolve(row);
  } });
  expect(await drawn.promise).not.toContain('Task 1');
  view.stdin.write('\r');
  await reading.promise;
  expect(inspect).toHaveBeenCalledExactlyOnceWith(visible[1]!.identity);
  await view.instance.waitUntilRenderFlush();
  if (view.stdout.frame.includes('WINDOW FO')) {
    view.stdin.write('\u000f');
    await view.instance.waitUntilRenderFlush();
  }
  expect(view.stdout.frame).toContain('INPUT FOC');
  view.stdin.write('\u0003');
  transcript.resolve('CANCELLED READ');
  await view.instance.waitUntilRenderFlush();
  expect(captured.entries).toEqual([]);
  expect(view.stdout.frame).not.toContain('Trans…');
  inspect.mockClear();

  workers = [...visible, first, eighth!];
  await runLedgerCommand('transcript', '1', ledger, labels);
  expect(inspect.mock.calls).toEqual([[visible[0]!.identity]]);
  captured.entries = [];
  Object.assign(view.stdout, { columns: 100 }); view.stdout.emit('resize');
  await view.instance.waitUntilRenderFlush();
  view.stdin.write('/transcript\r');
  await until(() => view.stdout.frame.includes('> Task 1'), 'worker picker');
  expect(view.stdout.frame).not.toContain('Task 7');

  // An out-of-range read lets us observe which Attempt a number resolves to without binding it.
  workers = [...visible.slice(1), first, visible[0]!, eighth!];
  await runLedgerCommand('transcript', '7 9', ledger, labels);
  expect(inspect).toHaveBeenLastCalledWith(visible[0]!.identity);

  // A successful read now shows 7 for another Attempt while the seventh picker row is still hidden.
  workers = [...visible.slice(1), first, intervening, visible[0]!, eighth!];
  const shown = await runLedgerCommand('transcript', '7', ledger, labels);
  expect(shown).toMatchObject([{ level: 'info', text: expect.stringContaining('Transcript · worker 7') }]);
  expect(inspect).toHaveBeenLastCalledWith(intervening.identity);
  view.stdin.write('\u001B[A');
  await until(() => view.stdout.frame.includes('> Task 8'), 'scrolled worker');
  expect(view.stdout.frame).toContain(`Task ${attemptId}`);
  await runLedgerCommand('transcript', '8 9', ledger, labels);
  expect(inspect).toHaveBeenLastCalledWith(eighth!.identity);
  expect(await runLedgerCommand('transcript', '7', ledger, labels)).toEqual(shown);
  expect(inspect).toHaveBeenLastCalledWith(intervening.identity);
  view.stdin.write('\u001B[B');
  await until(() => view.stdout.frame.includes('> Task 1'), 'first worker again');
  view.stdin.write('\u001B[A\u001B[A');
  await until(() => view.stdout.frame.includes(`> Task ${attemptId}`), 'select the full Attempt reference');
  await choose(view);
  return { view, inspect, first, observe: (...next: typeof workers) => { workers = next; } };
}

async function checkClippedTranscriptPickerHeightAndRefusal() {
  const base = ports(), initial = await base.listWorkers(), source = initial.sources[0]!, first = source.workers[0]!;
  let workers = [first, ...Array.from({ length: 5 }, (_, index) => ({
    ...first, identity: { ...first.identity!, attemptId: `${index + 1}0${attemptId.slice(2)}` },
  }))];
  const inspect = vi.fn(base.inspectTranscript!);
  const ledger = { ...base, inspectTranscript: inspect, listWorkers: async () => ({ ...initial, sources: [{ ...source, workers }] }) };
  const labels = { ...WORKLINE_TEST_LABELS, work: EN };
  const view = mountWorkline({ labels, ledger, fullscreen: true, pollMs: 60_000 }, 100, { rows: 8 });
  mounted.push(view);
  await view.instance.waitUntilRenderFlush();
  view.stdin.write('/transcript\r');
  await view.instance.waitUntilRenderFlush();
  expect(view.stdout.frame).toContain('Task 5');
  expect(view.stdout.frame).not.toContain('Task 4');
  view.stdin.write('\u0003');
  await view.instance.waitUntilRenderFlush();
  expect(view.stdout.frame).not.toContain('Task 5');

  workers = [...workers].reverse();
  await runLedgerCommand('transcript', '4', ledger, labels);
  expect(inspect).toHaveBeenCalledExactlyOnceWith(workers[3]!.identity);
  view.instance.unmount();
  captured.entries = [];
  captured.seen = new WeakSet();

  const refused = await open('/transcript', ports({ inspectTranscript: async () => { throw new Error('POLICY_DENIED'); } }));
  await until(() => refused.stdout.frame.includes('> Task 1'), 'picker'); await choose(refused);
  await until(() => refused.stdout.frame.includes('ERR:POLICY_DENIED'), 'refusal window'); expect(captured.entries).toEqual([]); await close(refused); onlySummary();
}

async function checkTranscriptNumber(presentation: 'resize-hidden' | 'editor' | 'accessible' | 'both digits' | 'first digit' | 'last digit') {
  const accessible = presentation === 'resize-hidden' || presentation === 'editor' || presentation === 'accessible';
  const resizeHidden = presentation === 'resize-hidden' || presentation === 'accessible';
  vi.stubEnv('INK_SCREEN_READER', String(accessible));
  const base = ports(), report = await base.listWorkers(), source = report.sources[0]!, first = source.workers[0]!;
  let workers = Array.from({ length: 10 }, (_, i) => ({ ...first, identity: { ...first.identity!, attemptId: `${i + 10}${attemptId.slice(2)}` } }));
  const tenth = workers[9]!;
  const transcript = Promise.withResolvers<string>();
  const inspect = vi.fn(base.inspectTranscript!).mockReturnValueOnce(transcript.promise);
  const ledger = { ...base, inspectTranscript: inspect, listWorkers: async () => ({ ...report, sources: [{ ...source, workers }] }) };
  const work = { ...EN, transcriptHeader: '{n}', jobs: { ...EN.jobs!, hints: '' } };
  const labels = { ...WORKLINE_TEST_LABELS, work };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  let output = '', holdFlush = false;
  const hidden = Promise.withResolvers<() => void>();
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }), { isTTY: true, columns: presentation === 'accessible' ? 5 : 8, rows: 60 });
  const write = stdout.write.bind(stdout);
  stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    if (holdFlush && chunk === '' && typeof args[0] === 'function') { holdFlush = false; hidden.resolve(args[0] as () => void); return true; }
    return Reflect.apply(write, stdout, [chunk, ...args]);
  }) as typeof stdout.write;
  const editor = Promise.withResolvers<void>();
  let suspend!: ReturnType<typeof useApp>['suspendTerminal'];
  function EditorControl() { suspend = useApp().suspendTerminal; return null; }
  const host = await openTerminalHost({ palette: resolveWorklinePalette('none'), stdin: stdin as never, stdout: stdout as never,
    fullscreen: presentation !== 'editor', ascii: presentation === 'accessible', view: context => createElement(Box, { flexDirection: 'column' }, createElement(EditorControl),
      createElement(WorklineApp, { ...panelFixture({ ledger }), labels, ledger, fullscreen: context.fullscreen, target: 'fixture',
        decisionArmMs: 0, systemPrompt: 'SYSTEM', historyMessages: 40, completeTurn: async () => 'unused', errorText: String, pollMs: 60_000 })) });
  let release: (() => void) | undefined, suspension: Promise<unknown> | undefined;
  try {
    await host.flushed();
    const opened = output.length;
    stdin.write('/transcript\r'); await host.flushed();
    if (presentation === 'accessible') {
      // Five ASCII columns cut the ellipsis: a screen reader hears the drawn marker piece of each row, not the cut ellipsis.
      const lines = stripVTControlCharacters(output.slice(opened)).split('\n'), more = lines.lastIndexOf('  +4');
      expect(lines.slice(more - 6, more)).toEqual(['>', ' ', ' ', ' ', ' ', ' ']);
    }
    stdin.write(`${ESC}[A`); await host.flushed();
    stdin.write('\r'); await host.flushed();
    expect(inspect.mock.calls, presentation).toEqual([[tenth.identity]]);
    if (presentation === 'editor') suspension = suspend(() => editor.promise);
    if (presentation !== 'editor') {
      holdFlush = resizeHidden;
      Object.assign(stdout, { columns: accessible ? 8 : 5, rows: accessible || presentation === 'both digits' ? 60 : 12 });
      stdout.emit('resize');
      if (resizeHidden) release = await hidden.promise;
      await host.flushed();
    }
    const start = output.length;
    transcript.resolve('BODY');
    await host.flushed();
    if (presentation === 'last digit') { stdin.write(`${ESC}[B`); await host.flushed(); }
    const shown = presentation === 'accessible' || presentation === 'both digits';
    if (accessible) {
      if (presentation === 'accessible') { release?.(); release = undefined; await host.flushed(); }
      expect(stripVTControlCharacters(output.slice(start)).split('\n').includes('10'), presentation).toBe(shown);
    } else {
      const bytes = output.slice(output.lastIndexOf(CLEAR_VISIBLE_SCREEN));
      const digits = terminalScreen(bytes.replaceAll('\n', '\r\n'), stdout.columns, stdout.rows).match(/│ [10] │/gu);
      expect(digits, presentation).toEqual(presentation === 'both digits' ? ['│ 1 │', '│ 0 │'] : [presentation === 'first digit' ? '│ 1 │' : '│ 0 │']);
    }
    workers = [...workers].reverse();
    // The rich composer routes slash arguments to the bare window; this is the existing typed reader.
    await runLedgerCommand('transcript', '10', ledger, labels);
    expect.soft(inspect.mock.calls.at(-1), presentation).toEqual([(shown ? tenth : workers[9]!).identity]);
  } finally {
    const closed = host.close();
    release?.(); editor.resolve(); await suspension;
    await closed;
    vi.unstubAllEnvs();
  }
}

async function checkListedTranscriptPicker({ view, inspect, first, observe }: Awaited<ReturnType<typeof chooseScrolledTranscript>>) {
  const second = { ...first, identity: { ...first.identity!, attemptId: '5b0c9811-1b2c-4d3e-8f90-a1b2c3d4e5f6', generation: 2 } };
  const replacement = { ...first, identity: { ...first.identity!, attemptId: '6b0c9811-1b2c-4d3e-8f90-a1b2c3d4e5f6', generation: 3 } };
  const windowFocused = () => view.stdout.frame.includes('WINDOW FOCUS');
  const composerReady = () => !windowFocused() && view.stdout.frame.includes('READY');
  const summaryCount = captured.entries.length;
  inspect.mockClear();

  // A fresh /workers list supplies the numbering for the rest of this Workline session.
  await until(composerReady, 'composer ready after the scrolled transcript');
  observe(first, second);
  view.stdin.write('/workers\r');
  await until(() => view.stdout.frame.includes('Task 2') && windowFocused(), 'listed worker 2 with window focus');
  view.stdin.write(ESC);
  await until(() => captured.entries.length === summaryCount + 1 && composerReady(), 'workers summary and composer ready');

  observe(second, first);
  view.stdin.write('/transcript\r');
  await until(() => view.stdout.frame.includes('> Task 2') && windowFocused(), 'picker preserves worker 2');
  view.stdin.write('\r');
  await until(() => view.stdout.frame.includes('TRANSCRIPT 0') && windowFocused(), 'worker 2 output with window focus');
  expect(view.stdout.frame).toContain('Transcript · worker 2 · task task-id · attempt 5b0c9811');
  view.stdin.write(ESC);
  await until(() => captured.entries.length === summaryCount + 2 && composerReady(), 'worker 2 summary and composer ready');
  expect(captured.entries.at(-1)).toMatchObject({ text: 'Transcript: Task 2' });

  observe(replacement, first);
  view.stdin.write('/transcript\r');
  await until(() => view.stdout.frame.includes(`> Task ${replacement.identity.attemptId}`) && windowFocused(), 'picker shows full Attempt ID');
  view.stdin.write('\r');
  await until(() => view.stdout.frame.includes('TRANSCRIPT 0') && windowFocused(), 'replacement output with window focus');
  expect(view.stdout.frame).toContain(`Transcript · worker ${replacement.identity.attemptId}`);
  expect(inspect.mock.calls).toEqual([[second.identity], [replacement.identity]]);
  view.stdin.write(ESC);
  await until(() => captured.entries.length === summaryCount + 3, 'replacement summary');
  expect(captured.entries.at(-1)).toMatchObject({ text: expect.stringContaining(replacement.identity.attemptId) });

  const tr = workSurfaceLabels('tr');
  expect(fillTemplate(tr.transcriptHeader, { n: 2, task: 'task-id', attempt: '5b0c9811' }))
    .toBe('Döküm · işçi 2 · görev task-id · deneme 5b0c9811');
  expect(`${tr.jobs!.transcriptTitle}: ${fillTemplate(tr.workerLine.ordinal, { n: 2 })}`).toBe('İşçi kaydı: Görev 2');
  const id = replacement.identity.attemptId;
  expect(fillTemplate(tr.transcriptHeader, { n: id, task: 'task-id', attempt: '6b0c9811' })).toContain(`Döküm · işçi ${id}`);
  expect(`${tr.jobs!.transcriptTitle}: ${fillTemplate(tr.workerLine.ordinal, { n: id })}`).toContain(id);
}

describe('SW-2 job windows', () => {
  it('112: a queued /run waits for quiet; its info window closes and a direct picker selects immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish: (text: string) => void = () => { throw new Error('turn did not start'); };
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: EN }, ledger: ports(), pollMs: 60_000,
      decisionArmMs: DECISION_ARM_DEFAULT, completeTurn: () => new Promise<string>(resolve => { finish = resolve; }) });
    mounted.push(view);
    const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await view.instance.waitUntilRenderFlush(); };
    const ready = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50 && !check(); attempt++) await view.instance.waitUntilRenderFlush();
      expect(check()).toBe(true); await view.instance.waitUntilRenderFlush();
    };
    await tick(60);
    view.stdin.write('task\r'); await tick(40);
    view.stdin.write('/run\r'); await tick(40);
    expect(view.stdout.frame).toContain('QUEUED');
    finish('done'); await tick(40);
    await ready(() => view.stdout.frame.includes('> Fix checkout'));
    view.stdin.write('\r'); await tick(DECISION_ARM_DEFAULT - 1);
    expect(view.stdout.frame).toContain('> Fix checkout'); expect(view.stdout.frame).not.toContain(EN.jobs!.delivery);
    await tick(1);
    view.stdin.write('\r'); await tick(20);
    await ready(() => view.stdout.frame.includes(EN.jobs!.delivery));
    // The queued command's next window is information, so Esc never needs another quiet wait.
    view.stdin.write(ESC); await tick(20);
    await ready(() => !view.stdout.frame.includes(EN.jobs!.delivery));
    view.stdin.write('/run\r'); await tick(40);
    await ready(() => view.stdout.frame.includes('> Fix checkout'));
    view.stdin.write('\r'); await tick(20);
    await ready(() => view.stdout.frame.includes(EN.jobs!.delivery));
  });
  it.each(['/workers', '/runs'] as const)('%s opens a list, never appends cards, and closes with one labelled line', async command => {
    const view = await open(command);
    await until(() => view.stdout.frame.includes(command === '/workers' ? 'Task 1' : 'Fix checkout'), 'list');
    expect(captured.entries).toEqual([]); expect(view.stdout.frame).not.toContain('Info:');
    await snapshot(command.slice(1), view);
    await close(view); onlySummary(); await snapshot(`${command.slice(1)}-summary`, view); expect(view.stdout.frame).toContain('◆ deckent system ·'); expect(view.stdout.frame).not.toContain('rows 1');
  });
  it.each(['en', 'tr'] as const)('%s: run picker opens sections with human titles and muted short IDs', async locale => {
    const work = workSurfaceLabels(locale), view = await open('/run', ports(), locale);
    await until(() => view.stdout.frame.includes('> Fix checkout'), 'run picker'); await snapshot(`run-picker-${locale}`, view); expect(view.stdout.frame).not.toContain(runId);
    await choose(view); await until(() => view.stdout.frame.includes(work.jobs!.delivery), 'detail');
    for (const label of [work.jobs!.state, work.jobs!.tasks, work.jobs!.attempts, work.jobs!.delivery]) expect(view.stdout.frame).toContain(label);
    expect(view.stdout.frame).toContain('4b0c9811'); expect(view.stdout.frame).not.toContain(attemptId);
    await snapshot(`run-detail-${locale}`, view);
    expect(runDetailLines(run, work).some(line => line.spans.some(item => item.role === 'muted'))).toBe(true);
    // R9h: rows and the task's section name it by number; its text appears once (the brief's task line).
    const detail = runDetailLines(run, work).map(line => [...line.label ?? [], ...line.spans].map(item => item.text).join(''));
    expect(detail.filter(text => text.includes('Fix checkout'))).toHaveLength(1); expect(detail).toContain(locale === 'en' ? 'Task 1' : 'Görev 1');
    await close(view); onlySummary();
  });
  it.each(['en', 'tr'] as const)('%s: /run shows the summary of a queue row read through the ledger port, and its not-available state when the read fails', async locale => {
    const subject = { scopeId: 'scope-a', runId, layoutRevision: 'layout', taskId: 'task-id', attemptId, generation: 1 };
    const ticket = targetQueueViewSchema.parse({ schemaVersion: 1, commandId: 'q1', identity: subject, operation: 'delivery', target: { kind: 'git-ref', id: 'refs/heads/integration' },
      display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
      state: 'awaiting-confirmation', outcome: null, revision: 1, observedAt: 1, freshness: 'last-known', position: 1, nextAction: 'confirm-batch', responsibility: 'human',
      basis: { observed: 'o', effective: 'e', candidate: 'c' }, verification: null, evidenceRefs: [], reason: null });
    const summary = deliverySummarySchema.parse({ schemaVersion: 1, operation: 'adopt', subject, target: { state: 'available', id: 'refs/heads/integration', protected: false },
      title: { source: 'work-input', text: 'Queue row headline' }, outcome: { state: 'withheld' }, acceptance: { verdict: 'accepted', criteriaCount: 1, evidence: [] },
      tests: { worker: { state: 'withheld' }, verification: { state: 'unavailable' } }, model: { state: 'withheld' },
      risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: [] }, actions: DELIVERY_SUMMARY_ACTIONS.adopt, change: { state: 'withheld' } });
    const queued = { ...run, targetQueue: { records: [ticket], truncated: false } } as unknown as RunView;
    const read = vi.fn(async () => [ticketSummaryBlock(summary, undefined, locale)]), shown = await open('/run', ports({ inspectRun: async () => queued, queueSummaryLines: read }), locale);
    await until(() => shown.stdout.frame.includes('> Fix checkout'), 'run picker'); await choose(shown);
    await until(() => shown.stdout.frame.includes('Queue row headline'), 'queue row summary'); expect(read).toHaveBeenCalledTimes(1); await snapshot(`run-queue-summary-${locale}`, shown);
    await close(shown); onlySummary();
    captured.entries = []; captured.seen = new WeakSet();
    const failing = await open('/run', ports({ inspectRun: async () => queued, queueSummaryLines: async () => { throw new Error('unreadable'); } }), locale);
    await until(() => failing.stdout.frame.includes('> Fix checkout'), 'run picker'); await choose(failing);
    await until(() => failing.stdout.frame.includes(workSurfaceLabels(locale).jobs!.delivery), 'detail'); await settle(40);
    expect(failing.stdout.frame).not.toContain('Queue row headline'); await close(failing);
  });
  it('picks the worker and pages the complete transcript by keys in a short terminal', async () => {
    const picker = await chooseScrolledTranscript(), { view, inspect } = picker;
    await until(() => view.stdout.frame.includes('TRANSCRIPT 0'), 'transcript'); await snapshot('transcript', view); expect(view.stdout.frame).not.toContain('TRANSCRIPT 89');
    expect(view.stdout.frame).toContain(`Transcript · worker ${attemptId}`);
    await settle(40); view.stdin.write('\u001B[F'); await until(() => view.stdout.frame.includes('TRANSCRIPT 89'), 'last page');
    expect(inspect.mock.calls.at(-1)![0].attemptId).toBe(attemptId); expect(captured.entries).toEqual([]); await close(view); onlySummary();
    await checkListedTranscriptPicker(picker);
    for (const presentation of ['both digits', 'first digit', 'last digit'] as const) await checkTranscriptNumber(presentation);
  });
  it.each(['y', 'n', ESC])('cancel picker excludes terminal/already cancelling runs; %s preserves revision authority', async key => {
    const cancel = vi.fn(async () => 'Cancellation requested');
    const ledger = ports({ listRunIds: async () => [runId, 'done', 'cancelling'], inspectRun: async id => id === runId ? run : { ...run, runId: id, cancellationRequested: id === 'cancelling', state: id === 'done' ? { kind: 'terminal', outcome: 'completed', reason: 'completed' } : { kind: 'running' }, tasks: [{ ...run.tasks[0]!, taskBrief: { ...run.tasks[0]!.taskBrief!, task: id } }] } as RunView, cancelRun: cancel });
    const view = await open('/cancel', ledger); await until(() => view.stdout.frame.includes('> Fix checkout'), 'cancel picker');
    expect(view.stdout.frame).not.toContain('> done'); expect(view.stdout.frame).not.toContain('cancelling'); await choose(view);
    await until(() => view.stdout.frame.includes('Cancel run 3f2a9c1e?'), 'card'); await snapshot('cancel', view); expect(captured.entries).toEqual([]);
    await settle(40); view.stdin.write(key); await until(() => captured.entries.length > 0, 'result'); onlySummary();
    expect(cancel.mock.calls).toEqual(key === 'y' ? [[runId, 7]] : []);
  });
  it('refreshes a chosen run and refuses cancellation if it became terminal', async () => {
    const inspect = vi.fn().mockResolvedValueOnce(run).mockResolvedValue({ ...run, state: { kind: 'terminal', outcome: 'completed' } }), cancel = vi.fn();
    const view = await open('/cancel', ports({ inspectRun: inspect, cancelRun: cancel }));
    await until(() => view.stdout.frame.includes('> Fix checkout'), 'picker'); await choose(view);
    await until(() => captured.entries.length > 0, 'closed'); expect(cancel).not.toHaveBeenCalled(); onlySummary();
    // R9m: `x` in /tasks on a finished Run says it already finished, never "Run details closed".
    const tasks = await open('/tasks', ports({ inspectRun: async () => ({ ...run, state: { kind: 'terminal', outcome: 'failed' } }) as RunView, cancelRun: cancel }));
    await until(() => tasks.stdout.frame.includes('Task 1'), 'task rows'); await settle(40); tasks.stdin.write('x');
    await until(() => tasks.stdout.text.includes('Fix checkout has already finished; there is nothing to cancel.'), 'already finished');
    expect(tasks.stdout.text).not.toContain('Run details closed'); expect(cancel).not.toHaveBeenCalled();
  });
  it('approvals picker opens the unchanged card and aggregates its result into one line', async () => {
    const decide = vi.fn(ports().decideApproval!), view = await open('/approvals', ports({ decideApproval: decide }));
    await until(() => view.stdout.frame.includes('Review checkout'), 'approval picker'); expect(captured.entries).toEqual([]); await choose(view);
    await until(() => view.stdout.frame.includes('Approval needed'), 'approval card'); await snapshot('approval', view); await settle(40); view.stdin.write('y');
    await until(() => captured.entries.length > 0, 'approved'); onlySummary(); expect(decide).toHaveBeenCalledWith(approval, 'allow', undefined, undefined);
  });
  it.each(['y', 'n', ESC])('clear-session is a picker row and %s requires a confirmed window', async key => {
    const clear = vi.fn(async () => undefined), view = await open('/approvals', ports({ listApprovalPage: async () => ({ items: [], nextAfter: null }), clearSessionStanding: clear }));
    await until(() => view.stdout.frame.includes(EN.jobs!.clearSession), 'clear row'); await choose(view);
    await until(() => view.stdout.frame.includes(EN.jobs!.clearDetail), 'confirm window'); await snapshot('clear-session', view); expect(clear).not.toHaveBeenCalled(); await settle(40); view.stdin.write(key);
    await until(() => captured.entries.length > 0, 'summary'); onlySummary(); expect(clear).toHaveBeenCalledTimes(key === 'y' ? 1 : 0);
  });
  // SLASH-WINDOWS I-1 (owner 2026-10-08): in the rich terminal a typed argument opens the same window as the bare command; that window notes once
  // that the terminal takes no typed argument, and the typed text is never shown or used.
  it.each(['/run ARG-TYPED', '/transcript ARG-TYPED 2', '/cancel ARG-TYPED', '/approvals ARG-TYPED', '/approvals clear-session', '/workers ARG-TYPED', '/tasks ARG-TYPED', '/monitor --scope ARG-TYPED'])('%s opens the bare window with the one-time note, never the typed text', async command => {
    const decide = vi.fn(), inspect = vi.fn(), view = await open(command, ports({ decideApproval: decide, inspectTranscript: inspect }), 'en', 60, true);
    await until(() => view.stdout.frame.includes(TYPED_ARGUMENT_NOTE), 'window with the note'); expect(captured.entries).toEqual([]);
    expect(view.stdout.frame).not.toContain('ARG-TYPED'); expect(decide).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    await close(view); onlySummary(); await settle(40);
    expect(view.stdout.frame).not.toContain(TYPED_ARGUMENT_NOTE);
  });
  it('/tasks keeps started/delivery words inside the window and leaves one summary when closed (Esc)', async () => {
    const view = await open('/tasks');
    await until(() => view.stdout.frame.includes('Watching · polling'), 'window status'); await snapshot('tasks', view);
    expect(captured.entries).toEqual([]); await close(view); onlySummary();
  });
  it('monitor uses one close summary and does not print its body', async () => {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: EN }, monitorWindow: async () => () => createElement(Text, null, 'MONITOR-BODY') }); mounted.push(view);
    await settle(30); view.stdin.write('/monitor\r'); await until(() => view.stdout.frame.includes('MONITOR-BODY'), 'monitor'); await snapshot('monitor', view);
    expect(captured.entries).toEqual([]); await close(view); onlySummary(); expect(view.stdout.frame).not.toContain('MONITOR-BODY');
  });
  it('the opening snapshot leaves one system line for running work (I-5), never cards, and the window shows the rows', async () => {
    const report = await ports().listWorkers(), source = report.sources[0]!, worker = source.workers[0]!;
    const workers = { ...report, sources: [{ ...source, workers: [worker,
      { ...worker, taskId: 'unknown-task', process: 'unknown' as const, terminal: null, files: null },
      { ...worker, taskId: 'released-task', custody: 'released' as const }] }] };
    const ledger = ports({ followEvents: async function* (signal) {
      yield { control: 'start', scopeId: 'scope-a', cursors: { worker: 0, run: 0, approval: 0 } };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }, readSurfaceSnapshot: async () => ({ scopeId: 'scope-a', denied: [], runs: [run], workers, approvals: [] }) });
    const view = await open('/tasks', ledger);
    await until(() => view.stdout.frame.includes('Fix checkout') && view.stdout.frame.includes('Task 1'), 'snapshot window');
    expect(captured.entries).toHaveLength(1); expect(captured.entries[0]).toMatchObject({ kind: 'notice', id: 'system-summary', text: 'Work: 1 unfinished runs, 1 active workers, 1 workers unknown · /runs /workers' });
    expect(openingWorkText([], 0, EN.jobs!, 1)).toBe('Work: 0 unfinished runs, 0 active workers, 1 workers unknown · /runs /workers');
    expect(openingWorkText([], 0, workSurfaceLabels('tr').jobs!, 1)).toBe('İş durumu: 0 bitmemiş iş, 0 etkin işçi, 1 durumu bilinmeyen işçi · /runs /workers');
    expect(openingWorkText([], 0, EN.jobs!, 0)).toBeNull();
    view.stdin.write(ESC); await until(() => captured.entries.length === 2, 'close summary');
    expect(captured.entries.every(entry => entry.kind === 'notice' && entry.id === 'system-summary')).toBe(true);
  });
  it('keeps policy refusal inside a transcript window and leaves only one summary after close', async () => {
    await checkClippedTranscriptPickerHeightAndRefusal();
    for (const presentation of ['resize-hidden', 'editor', 'accessible'] as const) await checkTranscriptNumber(presentation);
  });
});

it('/runs shows the fresh cancelled state without a close card or control write', async () => {
  const parked: RunView = { ...run, state: { kind: 'parked', reason: 'operator-hold', since: 1, deadline: 2 } };
  const cancelled: RunView = { ...run, revision: 8, state: { kind: 'terminal', outcome: 'cancelled', reason: 'cancelled' } };
  const inspectRun = vi.fn(async () => cancelled), controlRun = vi.fn();
  const view = await open('/runs', ports({ inspectRunObservation: async () => inspectRun.mock.calls.length ? cancelled : parked, inspectRun, controlRun }));
  await until(() => view.stdout.frame.includes(EN.runControl!.keyClose), 'parked row offers close');
  view.stdin.write('c');
  const card = 'Close parked run 3f2a9c1e', notice = 'Run 3f2a9c1e is cancelled. No action was sent.';
  await until(() => view.stdout.frame.includes(card) || view.stdout.frame.includes(notice), 'result of selecting close');
  expect(inspectRun).toHaveBeenCalledExactlyOnceWith(runId);
  expect(view.stdout.frame).not.toContain(card);
  expect(view.stdout.frame).toContain(notice);
  expect(controlRun).not.toHaveBeenCalled();
});
