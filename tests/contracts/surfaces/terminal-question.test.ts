import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { QuestionWindow, WindowStackProvider, optionKey, questionStep, type QuestionOption } from '#surfaces/core/terminal-window/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import type { Key } from 'ink';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

/** TERMINAL-SABIT-DUZEN slice 2: one question contract — approvals as a list (default No), single and multi choice, the same keys. */
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const UP = '\u001b[A', DOWN = '\u001b[B';
const key = (patch: Partial<Key> = {}): Key => ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
  ...patch } as Key);

describe('question model', () => {
  const options: QuestionOption[] = [{ id: 'a', label: 'A', key: 'y' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C', key: 'n' }];
  it('moves with arrows, j/k and digits, submits with Enter or an option letter, cancels with Esc/Ctrl+C, ignores paste and other keys', () => {
    const at = (n: number) => ({ at: n, ticked: [] as string[] });
    expect(questionStep('single', options, at(0), '', key({ downArrow: true }))).toEqual({ kind: 'move', state: at(1) });
    expect(questionStep('single', options, at(2), 'j', key())).toEqual({ kind: 'move', state: at(2) });
    expect(questionStep('single', options, at(2), 'k', key())).toEqual({ kind: 'move', state: at(1) });
    expect(questionStep('single', options, at(0), '3', key())).toEqual({ kind: 'move', state: at(2) });
    expect(questionStep('single', options, at(1), '', key({ return: true }))).toEqual({ kind: 'submit', ids: ['b'] });
    expect(questionStep('single', options, at(1), 'y', key())).toEqual({ kind: 'submit', ids: ['a'] });
    expect(questionStep('single', options, at(1), '', key({ escape: true }))).toEqual({ kind: 'cancel' });
    expect(questionStep('single', options, at(1), 'c', key({ ctrl: true }))).toEqual({ kind: 'cancel' });
    expect(questionStep('single', options, at(1), 'yes', key())).toEqual({ kind: 'ignored' });
    // BeUser E-14: a digit the card shows as an option's key answers with it (the purge reason card's "(4)"); unlabelled digits only move.
    expect(questionStep('single', [{ id: 'r1', label: 'one', key: '1' }, { id: 'r2', label: 'two', key: '2' }], at(0), '2', key())).toEqual({ kind: 'submit', ids: ['r2'] });
    expect(questionStep('single', options, at(1), 'x', key())).toEqual({ kind: 'ignored' });
    // Multi choice: Space ticks, Enter submits the ticked ones in option order, letters never submit.
    const ticked = questionStep('multi', options, at(2), ' ', key());
    expect(ticked).toEqual({ kind: 'move', state: { at: 2, ticked: ['c'] } });
    const both = questionStep('multi', options, { at: 0, ticked: ['c'] }, ' ', key());
    expect(both.kind === 'move' && questionStep('multi', options, both.state, '', key({ return: true }))).toEqual({ kind: 'submit', ids: ['a', 'c'] });
    expect(questionStep('multi', options, at(0), 'y', key())).toEqual({ kind: 'ignored' });
  });
  it('a yes/no question derives (y)/(n) from its answers in every locale: y and n answer, Enter sends the highlighted one; other answers keep their own letter', () => {
    const at = (n: number) => ({ at: n, ticked: [] as string[] });
    // The answer role, not the call site, owns the letter; an answer without a role ("Not now" beside a real No) is letterless; ids and order are free.
    const yesNo = [{ id: 'later', label: 'Not now' }, { id: 'apply', label: 'Apply', role: 'yes' }, { id: 'cancel', label: 'Cancel', role: 'no' }] as QuestionOption[];
    expect(questionStep('single', yesNo, at(0), 'y', key())).toEqual({ kind: 'submit', ids: ['apply'] });
    expect(questionStep('single', yesNo, at(0), 'N', key())).toEqual({ kind: 'submit', ids: ['cancel'] });
    expect(questionStep('single', yesNo, at(0), '', key({ return: true }))).toEqual({ kind: 'submit', ids: ['later'] });
    expect(questionStep('single', yesNo, at(0), '3', key())).toEqual({ kind: 'move', state: at(2) });
    expect(questionStep('multi', yesNo, at(0), 'y', key())).toEqual({ kind: 'ignored' });
    expect(yesNo.map(option => optionKey(option))).toEqual([undefined, 'y', 'n']);
    expect(optionKey({ id: 'session', label: 'Session', key: 's' })).toBe('s');
    // @ts-expect-error a yes/no answer never carries a hand-written letter
    expect(optionKey({ id: 'odd', label: 'Odd', role: 'yes', key: 'x' })).toBe('y');
  });
});

const hold = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const turn = (gate: Promise<void>, standing: boolean) => async function* (messages: readonly { content: unknown }[]): AsyncGenerator<TurnDelta> {
  if (messages.at(-1)?.content !== 'go') { yield { kind: 'done', finish: 'stop' }; return; }
  yield { kind: 'tool', phase: 'started', callId: 'c1', name: 'edit_file', target: 'src/a.ts', status: null, ms: null };
  yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'appr-q', revision: 0, summary: 'edit_file · src/a.ts · 0123456789ab', preview: 'diff',
    expiresAt: Date.now() + 600_000, tool: 'edit_file', target: 'src/a.ts', ...(standing ? { standing: { scopes: ['session', 'always'] as const, pattern: 'src/*' } } : {}) };
  await gate; yield { kind: 'done', finish: 'stop' };
};
const ledger = (calls: unknown[][]) => ({ scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
  async decideApproval(approval: { approvalId: string }, decision: string, standing?: string) {
    calls.push([approval.approvalId, decision, standing]);
    return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
  } });

describe('approval card as a list (real Workline, NO_COLOR palette)', () => {
  const W = workSurfaceLabels('en').approvalWindow.choices;
  async function open(standing: boolean, calls: unknown[][], gate: Promise<void>) {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') }, ledger: ledger(calls) as never, streamTurn: turn(gate, standing) as never }, 120, { rows: 40 });
    mounted.push(view.instance);
    await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
    await until(() => view.stdout.frame.includes('Approval needed'), 'card'); await settle(40);
    return view;
  }
  it('starts on No (Enter alone denies); arrows move, Enter on "Yes, once" approves once; no colour codes', async () => {
    const gate = hold(), calls: unknown[][] = [], view = await open(true, calls, gate.promise);
    try {
      expect(view.stdout.frame).toContain(`› 4. ${W.no} (n)`); expect(view.stdout.frame).toContain(`  1. ${W.once} (y)`);
      expect(view.stdout.frame).toContain(`${W.session} (s)`); expect(view.stdout.frame).toContain(`${W.always} (a)`);
      for (const step of [UP, UP, UP]) { view.stdin.write(step); await settle(30); }
      expect(view.stdout.frame).toContain(`› 1. ${W.once} (y)`);
      view.stdin.write('\r'); await until(() => calls.length === 1, 'decision');
      expect(calls[0]).toEqual(['appr-q', 'allow', undefined]);
      expect(view.stdout.text.split('\u001b[').slice(1).some(sequence => /^[\d;]*m/u.test(sequence))).toBe(false);
    } finally { gate.release(); }
  });
  it('"Yes, for this session" through the list carries the session scope (the existing G6 path); Enter on the default denies', async () => {
    const gate = hold(), calls: unknown[][] = [], view = await open(true, calls, gate.promise);
    try {
      view.stdin.write('2'); await settle(30); view.stdin.write('\r');
      await until(() => calls.length === 1, 'session decision'); expect(calls[0]).toEqual(['appr-q', 'allow', 'session']);
    } finally { gate.release(); }
    const gate2 = hold(), calls2: unknown[][] = [], second = await open(true, calls2, gate2.promise);
    try { second.stdin.write('\r'); await until(() => calls2.length === 1, 'default'); expect(calls2[0]![1]).toBe('deny'); } finally { gate2.release(); }
  });
  it('a card without offered scopes (floor items, always-ask locks) lists only "Yes, once" and "No"', async () => {
    const gate = hold(), calls: unknown[][] = [], view = await open(false, calls, gate.promise);
    try {
      expect(view.stdout.frame).toContain(`${W.once} (y)`); expect(view.stdout.frame).toContain(`› 2. ${W.no} (n)`);
      expect(view.stdout.frame).not.toContain(W.session); expect(view.stdout.frame).not.toContain(W.always);
      view.stdin.write('s'); view.stdin.write('a'); await settle(40); expect(calls).toEqual([]);
    } finally { gate.release(); }
  });
});

describe('multi-choice question window', () => {
  // eslint-disable-next-line no-control-regex -- a paste-mode toggle is not a frame
  class Tty extends Writable { isTTY = true; rows = 24; columns = 80; frame = ''; override _write(chunk: Buffer, _e: string, done: () => void) { const text = chunk.toString('utf8'); if (!/^(?:\u001b\[\?2004[hl])+$/u.test(text)) this.frame = text; done(); } }
  it('Space ticks, Enter submits the ticked options; nothing is highlighted until the person moves', async () => {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const answers: Array<readonly string[] | null> = [];
    const options = [{ id: 'erp', label: 'ERP' }, { id: 'crm', label: 'CRM' }, { id: 'mail', label: 'Mail' }];
    const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WindowStackProvider, { composerDefault: true },
      createElement(QuestionWindow, { title: 'Which systems?', kind: 'multi', options, hints: '↑↓ move · Space select · Enter submit', position: '{from}-{to}/{total}', onAnswer: ids => { answers.push(ids); } })) }),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await settle(400); // production arming
    expect(stdout.frame).toContain('[ ] ERP'); expect(stdout.frame).not.toContain('›');
    stdin.write(DOWN); await settle(30); stdin.write(' '); await settle(30); stdin.write(DOWN); await settle(30); stdin.write(DOWN); await settle(30); stdin.write(' '); await settle(30);
    expect(stdout.frame).toContain('[x] ERP'); expect(stdout.frame).toContain('[x] Mail');
    stdin.write('\r'); await until(() => answers.length === 1, 'submitted');
    expect(answers[0]).toEqual(['erp', 'mail']);
  });
});
