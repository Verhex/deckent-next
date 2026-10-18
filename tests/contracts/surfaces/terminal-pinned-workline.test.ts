import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_ARM_DEFAULT, mainScreenOutput, preserveMainScreenScrollback, PinnedWorkline } from '#surfaces/core/terminal-window/index.js';
import { createElement } from 'react';
import { render, Text } from 'ink';
import { cells } from '#surfaces/core/terminal-render/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { terminalScreen } from '../../fixtures/terminal-screen.js';
import type { RunView } from '#engine/index.js';
import { PassThrough, Writable } from 'node:stream';
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
const mounted: ReturnType<typeof mountWorkline>[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.instance.unmount(); });
const focus = { composer: 'INPUT-FOCUS Ctrl+O', window: 'WINDOW-FOCUS Ctrl+O', decide: 'DECIDE-HERE Ctrl+O' }, SWITCH = '\u000f';
function mount(props: Parameters<typeof mountWorkline>[0] = {}, columns = 80, rows = 24, debug = true) {
  const view = mountWorkline({ ...props, labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, focus, ...props.labels } }, columns, { rows, debug });
  mounted.push(view); return view;
}
/** A real PTY turns Ink's LF into CR LF (termios ONLCR); the in-memory TTY does not, so the replay applies it. */
const onlcr = (text: string) => text.replaceAll('\n', '\r\n');
function lines(view: ReturnType<typeof mountWorkline>) { return view.stdout.frame.replace(/\n$/u, '').split('\n'); }
function assertPinned(view: ReturnType<typeof mountWorkline>, rows: number, columns: number, replay: false | 'full' | 'fresh' = false) {
  // R3 (bounded, not filled): the live area is at most rows−1 rows (Ink's trailing newline keeps the last row, so its ED3 overflow path is
  // never taken); the focus hint is its last row, status and caret are in it, every row fits the width. Debug Ink prepends its full Static
  // replay, so the physical screen is read from the actual cursor bytes (fake VT viewport) instead.
  const screen = replay ? terminalScreen(onlcr(view.stdout.text), columns, rows).split('\n') : lines(view);
  const frame = screen.slice(-(rows - 1));
  expect(frame.length).toBeLessThanOrEqual(rows - 1);
  expect(frame.at(-1)).toMatch(/HINT|INPUT-FOCUS|WINDOW-FOCUS/u);
  expect(frame.some(row => row.includes('READY') || row.includes('BUSY'))).toBe(true);
  expect(frame.some(row => row.includes('|'))).toBe(true);
  expect(frame.every(row => cells(row) <= columns)).toBe(true);
  // Once content fills the screen the composer is on its bottom rows; a fresh screen keeps it under the content (nothing pushed away).
  if (replay === 'full') expect(screen.length).toBeGreaterThanOrEqual(rows - 1);
  if (replay === 'fresh') expect(screen.length).toBeLessThan(rows - 1);
}
describe('pinned Workline terminal', () => {
  it('keeps the caret and status at the bottom through long output, multiline draft and resize in NO_COLOR', async () => {
    const reply = Array.from({ length: 80 }, (_, i) => `output-row-${i}`).join('\n');
    const view = mount({ completeTurn: async () => reply }, 80, 24, false); await settle(100);
    assertPinned(view, 24, 80, 'fresh');
    view.stdin.write('hello\r'); await until(() => view.stdout.text.includes('output-row-79'), 'full completed output');
    view.stdin.write('taslak Türkçe 漢字 '.repeat(50)); await settle(100);
    assertPinned(view, 24, 80, 'full');
    expect(view.stdout.text).toContain('output-row-0'); expect(terminalScreen(onlcr(view.stdout.text), 80, 24)).toContain('output-row-79');
    for (const [rows, columns] of [[14, 32], [30, 100], [10, 20]]) {
      Object.assign(view.stdout, { rows, columns }); view.stdout.emit('resize'); await settle(120);
      assertPinned(view, rows!, columns!, 'full');
    }
    expect(view.stdout.text.split('\u001b[').slice(1).some(sequence => /^[\d;]*m/u.test(sequence))).toBe(false);
  });

  it('shows each completed record once on screen and in the scrollback (no live-area replay of the transcript)', async () => {
    const view = mount({ completeTurn: async () => 'UNIQUE-ANSWER' }, 80, 24, false); await settle(100);
    view.stdin.write('UNIQUE-QUESTION\r'); await until(() => view.stdout.text.includes('UNIQUE-ANSWER'), 'answer'); await settle(100);
    const screen = terminalScreen(onlcr(view.stdout.text), 80, 24);
    expect(screen.match(/UNIQUE-ANSWER/gu)).toHaveLength(1); expect(screen.match(/UNIQUE-QUESTION/gu)).toHaveLength(1);
    assertPinned(view, 24, 80, 'fresh');
  });

  it('clips an over-tall live part at rows−1 and keeps the footer whole (the bound does not depend on each window capping itself)', async () => {
    class Tty extends Writable { isTTY = true; rows = 12; columns = 40; frame = ''; override _write(chunk: Buffer, _e: string, done: () => void) { const text = chunk.toString('utf8'); if (text.includes('FOOTER')) this.frame = text; done(); } }
    const stdout = new Tty();
    const tall = Array.from({ length: 50 }, (_, i) => createElement(Text, { key: i }, `live-${i}`));
    const instance = render(createElement(PinnedWorkline, { footer: createElement(Text, null, 'FOOTER'), children: tall }),
      { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false });
    try {
      await settle(60);
      const rows = stdout.frame.replace(/\n$/u, '').split('\n');
      expect(rows).toHaveLength(11); expect(rows.at(-1)).toBe('FOOTER'); expect(rows.at(-2)).toBe('live-49'); expect(stdout.frame).not.toContain('live-0\n');
    } finally { instance.unmount(); }
  });

  it('keeps an information window open while typing and queues submit until the focused window is closed', async () => {
    const sent: string[] = [], view = mount({ completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'done'; } });
    await settle(80); view.stdin.write('/bad-command\r'); await until(() => view.stdout.frame.includes('Unknown'), 'unknown command window');
    expect(view.stdout.frame).toContain('WINDOW-FOCUS');
    view.stdin.write(SWITCH); await settle(60); // User-opened window takes focus; explicitly return to the composer to type.
    view.stdin.write('next request'); await settle(80);
    expect(view.stdout.frame).toContain('next request'); expect(view.stdout.frame).toContain('INPUT-FOCUS'); expect(sent).toEqual([]);
    view.stdin.write('\r'); await settle(80); expect(sent).toEqual([]);
    view.stdin.write(SWITCH); await settle(60); expect(view.stdout.frame).toContain('WINDOW-FOCUS');
    view.stdin.write('\u001b'); await until(() => sent.length === 1, 'queued request after closing window');
    expect(sent).toEqual(['next request']);
  });

  it('does not let composer answers decide /do approval; explicit focus + original-card approval precedes the effect', async () => {
    const pending = pendingBrainFixture(), decisions: string[] = [];
    let plans = 0, created = 0, decided = false;
    const admitted = { schemaVersion: 3, runId: 'r', scopeId: 's', revision: 1, cancellationRequested: false, state: { kind: 'running' }, tasks: [] } as unknown as RunView;
    const approval: WorklineApproval = { approvalId: pending.proposal.approval!.approvalId, runId: 'r', taskId: '-', requester: 'owner', revision: 0,
      status: 'pending', decision: null, summary: 'Create proposed Run', expiresAt: pending.proposal.approval!.expiresAt };
    const ledger = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => [], inspectRun: async () => null,
      listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }), listApprovalPage: async () => ({ items: decided ? [] : [approval], nextAfter: null }),
      decideApproval: async (target: WorklineApproval, answer: 'allow' | 'deny') => { expect(target.approvalId).toBe(approval.approvalId); decisions.push(answer); decided = true;
        return { ...target, revision: 1, status: 'decided', decision: answer }; } } as WorklineLedgerPorts;
    const view = mount({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, focus, work: workSurfaceLabels('en') }, ledger, pollMs: 60_000, decisionArmMs: DECISION_ARM_DEFAULT,
      doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => ['PLAN-RESULT'],
        plan: async () => { plans++; if (!decided) return pending; created++;
          return { ...pending, run: admitted, proposal: { ...pending.proposal, status: 'accepted', approval: null } }; } } }, 160, 60);
    await settle(80); view.stdin.write('/do original\r'); await until(() => view.stdout.frame.includes('Create proposed Run'), 'actual approval card');
    // TERMINAL-SABIT-DUZEN slice 2 (replaces R2's Ctrl+O rule): the card takes the keyboard by itself and arms first, so keys typed for the input
    // at once (letters, Enter, a coalesced control+letter) never decide; Ctrl+O still moves between input and card, and each return re-arms it.
    expect(view.stdout.frame).toContain('WINDOW-FOCUS'); expect(view.stdout.frame).not.toContain('DECIDE-HERE');
    view.stdin.write('ynsa'); await settle(60); expect(decisions).toEqual([]); expect(created).toBe(0);
    view.stdin.write('\r'); await settle(60); expect(decisions).toEqual([]); expect(plans).toBe(1);
    view.stdin.write(SWITCH); await settle(60); expect(view.stdout.frame).toContain('INPUT-FOCUS'); expect(view.stdout.frame).toContain('DECIDE-HERE Ctrl+O');
    view.stdin.write('n'); await settle(60); expect(decisions).toEqual([]); expect(created).toBe(0); expect(view.stdout.frame).toContain('n');
    // Ink treats a coalesced control+letter as one ambiguous input: neither a focus switch nor a decision.
    view.stdin.write(`${SWITCH}y`); await settle(60); expect(decisions).toEqual([]); expect(view.stdout.frame).toContain('INPUT-FOCUS');
    view.stdin.write(SWITCH); await settle(60); expect(view.stdout.frame).toContain('WINDOW-FOCUS');
    view.stdin.write('y'); await settle(60); expect(decisions).toEqual([]); // back on the card it re-arms: a key at once is no decision
    await settle(DECISION_ARM_DEFAULT + 80); view.stdin.write('y');
    await until(() => decisions.length === 1, 'approve the original visible card');
    expect(decisions).toEqual(['allow']); await until(() => plans === 2, 'only then replay admission'); expect(created).toBe(1);
  });

  it('keeps planning visible and draft input available while /do awaits its producer', async () => {
    const pending = pendingBrainFixture(); let release: ((value: typeof pending) => void) | undefined;
    const view = mount({ doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => ['RESULT'], plan: async () => new Promise(resolve => { release = resolve; }) } });
    await settle(80); view.stdin.write('/do request\r'); await until(() => view.stdout.frame.includes('PLANNING'), 'planning');
    view.stdin.write('/status'); await settle(80);
    expect(view.stdout.frame).toContain('/status'); expect(view.stdout.frame).toContain('PLANNING'); assertPinned(view, 24, 80);
    release!(pending);
  });

  it('scrolls long /do result rows inside the focused window while input/status stay pinned', async () => {
    const pending = pendingBrainFixture();
    const view = mount({ doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST',
      plan: async () => ({ ...pending, proposal: { ...pending.proposal, status: 'rejected', approval: null } }),
      lines: () => Array.from({ length: 100 }, (_, i) => `plan-line-${i + 1}`) } });
    await settle(80); view.stdin.write('/do plan\r'); await until(() => view.stdout.frame.includes('plan-line-1'), 'result window');
    assertPinned(view, 24, 80); expect(view.stdout.frame).toMatch(/rows 1–\d+ of 100/u);
    view.stdin.write('draft'); await settle(60); expect(view.stdout.frame).toContain('draft');
    view.stdin.write(SWITCH); await settle(60); view.stdin.write('\u001b[F'); await settle(60);
    expect(view.stdout.frame).toContain('plan-line-100'); expect(view.stdout.frame).toMatch(/rows \d+–100 of 100/u);
    assertPinned(view, 24, 80); view.stdin.write(SWITCH); await settle(60); view.stdin.write(' stays'); await settle(60);
    expect(view.stdout.frame).toContain('draft stays'); expect(view.stdout.frame).toContain('plan-line-100');
  });

  it('keeps resize redraw scrollback and explicit /clear separate, and returns pipe streams unchanged', () => {
    const inkClear = '\u001b[2J\u001b[3J\u001b[H', explicit = '\u001b[H\u001b[2J\u001b[3J';
    expect(preserveMainScreenScrollback(`${inkClear}frame`)).toBe('\u001b[2J\u001b[Hframe');
    expect(preserveMainScreenScrollback(explicit)).toBe(explicit);
    const pipe = { isTTY: false } as NodeJS.WriteStream; expect(mainScreenOutput(pipe)).toBe(pipe);
    const writes: string[] = [], stdout = { isTTY: true, columns: 80, write: (text: string) => { writes.push(text); return false; } } as unknown as NodeJS.WriteStream;
    const stream = mainScreenOutput(stdout); expect(stream.write(inkClear)).toBe(false); stream.write(explicit);
    expect(writes).toEqual(['\u001b[2J\u001b[H', explicit]); Object.assign(stdout, { columns: 32 }); expect(stream.columns).toBe(32);
  });

  it('wires the scrollback-preserving output adapter in the production Workline entry during resize and shutdown', async () => {
    class Tty extends Writable {
      isTTY = true; rows = 24; columns = 80; text = '';
      override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
    }
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const controller = new AbortController();
    const running = runTerminalWorkline({ labels: WORKLINE_TEST_LABELS, context: { installationId: 'i', projectId: 'p', scopeId: 's' },
      target: 'scope', systemPrompt: 'system', historyMessages: 40, completeTurn: async () => 'unused', errorText: String,
      palette: resolveWorklinePalette('none'), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, signal: controller.signal });
    try {
      await until(() => stdout.text.includes('READY'), 'entrypoint first frame');
      stdout.rows = 12; stdout.columns = 32; stdout.emit('resize'); await settle(120);
      stdin.write('still typing'); await until(() => stdout.text.includes('still typing'), 'entrypoint resized input');
      // TERMINAL-SABIT-DUZEN: the production entry draws on the alternate screen; a resize still never erases the terminal's own scrollback.
      expect(stdout.text).not.toContain('\u001b[3J'); expect(stdout.text).toContain('\u001b[?1049h');
    } finally { controller.abort(); await running; }
    expect(stdout.text).not.toContain('\u001b[3J');
  });
});
