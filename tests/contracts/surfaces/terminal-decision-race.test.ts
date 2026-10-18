import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useState } from 'react';
import { render, Text } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { DECISION_ARM_DEFAULT, DecisionArmContext, QuestionWindow, Window, WindowStackProvider, WINDOW_PRIORITY } from '#surfaces/core/terminal-window/index.js';
import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

/**
 * TERMINAL-SABIT-DUZEN slice 2 security (lead note 2026-10-18, review "unintended approval (keystroke race)"): a decision card that takes the
 * keyboard by itself must never be answered by keys meant for the input — typed before it appeared, during its arming, held/auto-repeated,
 * pasted, carried across a queued card switch or a focus change. It arms only after a quiet period with no keys, and its default is No.
 */
const ARM = DECISION_ARM_DEFAULT, CTRL_O = '\u000f';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

const hold = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const turn = (gate: Promise<void>) => async function* (messages: readonly { content: unknown }[]): AsyncGenerator<TurnDelta> {
  if (messages.at(-1)?.content !== 'go') { yield { kind: 'done', finish: 'stop' }; return; }
  // The card comes a moment after the turn starts, so keys typed meanwhile are typed for the input.
  await new Promise(resolve => setTimeout(resolve, 150));
  yield { kind: 'tool', phase: 'started', callId: 'c1', name: 'run_shell', target: 'rm -rf build', status: null, ms: null };
  yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'appr-race', revision: 0, summary: 'run_shell · rm -rf build · 0123456789ab',
    preview: '$ rm -rf build', expiresAt: Date.now() + 600_000, risk: 'shell-destructive', tool: 'run_shell', target: 'rm -rf build', standing: { scopes: ['session'], pattern: 'rm *' } };
  await gate;
  yield { kind: 'done', finish: 'stop' };
};
const ledger = (calls: unknown[][]) => ({ scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
  async decideApproval(approval: { approvalId: string }, decision: string, standing?: string) {
    calls.push([approval.approvalId, decision, standing]);
    return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
  } });

function mountCard(calls: unknown[][], gate: Promise<void>) {
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') }, ledger: ledger(calls) as never, streamTurn: turn(gate) as never, decisionArmMs: ARM } as never, 100, { rows: 40 });
  mounted.push(view.instance); return view;
}
const cardShown = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame.includes('Approval needed');

describe('decision card keystroke race (real Workline, production arming)', () => {
  it('keys typed for the input before the card appeared stay in the draft and decide nothing', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready');
      view.stdin.write('go\r'); await settle(30);
      // The person keeps typing while the turn runs; the card appears in the middle of it.
      for (let i = 0; i < 40 && !cardShown(view); i++) { view.stdin.write('y'); await settle(15); }
      await until(() => cardShown(view) || calls.length > 0, 'card');
      expect(calls).toEqual([]);
      view.stdin.write('y'); await settle(10); view.stdin.write('\r');
      await settle(ARM / 2);
      expect(calls).toEqual([]);
      // Denied after a quiet period with Esc; the draft typed before the card is back in the input.
      await settle(ARM + 80); view.stdin.write('\u001b');
      await until(() => calls.length === 1 && !cardShown(view), 'denied'); expect(calls[0]![1]).toBe('deny');
      await settle(60); expect(view.stdout.frame).toMatch(/│ > y+/u);
    } finally { gate.release(); }
  });

  it('keys during arming are swallowed; a held (auto-repeated) key keeps it disarmed; it answers only after a quiet period', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card');
      // Auto-repeat of y every 30 ms for longer than the arming period: never decides.
      for (let elapsed = 0; elapsed < ARM * 2.5; elapsed += 30) { view.stdin.write('y'); await settle(30); }
      expect(calls).toEqual([]);
      // A bracketed paste after arming never answers either.
      await settle(ARM + 80); view.stdin.write('\u001b[200~y\r\u001b[201~'); await settle(60);
      expect(calls).toEqual([]);
      // Enter on the default highlight after a quiet period denies (No is the default).
      await settle(ARM + 80); view.stdin.write('\r');
      await until(() => calls.length === 1, 'decision'); expect(calls[0]![1]).toBe('deny');
    } finally { gate.release(); }
  });

  it('Esc during arming decides nothing; a focus round trip (Ctrl+O twice) re-arms the card', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card');
      view.stdin.write('\u001b'); await settle(40); expect(calls).toEqual([]);
      await settle(ARM + 80);
      view.stdin.write(CTRL_O); await settle(30); view.stdin.write(CTRL_O); await settle(20); view.stdin.write('y'); await settle(60);
      expect(calls).toEqual([]);
      await settle(ARM + 80); view.stdin.write('y');
      await until(() => calls.length === 1, 'approved after re-arm'); expect(calls[0]![1]).toBe('allow');
    } finally { gate.release(); }
  });
});

describe('Codex review 6d458d9d repro sequences (paste split across focus, multi-event bursts)', () => {
  it('a bracketed paste begun in the input and finished after the card took the keyboard never answers it', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r'); await settle(30);
      view.stdin.write('\u001b[200~y');
      await until(() => cardShown(view), 'card'); await settle(ARM + 120);
      view.stdin.write('\u001b[201~'); await settle(80);
      expect(calls).toEqual([]);
    } finally { gate.release(); }
  });

  it('one stdin chunk that closes the reason field and then types y never decides ("\\r\\x1b[Ay")', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card'); await settle(ARM + 80);
      view.stdin.write('\t'); await settle(ARM + 80);
      view.stdin.write('\r\u001b[Ay'); await settle(80);
      expect(calls).toEqual([]);
    } finally { gate.release(); }
  });

  it('an unbracketed burst ending in a lone y ("text\\x7fy") never decides', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card'); await settle(ARM + 80);
      view.stdin.write('text\u007fy'); await settle(80);
      expect(calls).toEqual([]);
      // A deliberate single key after a quiet period still works.
      await settle(ARM + 80); view.stdin.write('n'); await until(() => calls.length === 1, 'deliberate n'); expect(calls[0]![1]).toBe('deny');
    } finally { gate.release(); }
  });
});

describe('queued decisions (one shown, "n/total"), each armed when it becomes visible', () => {
  // eslint-disable-next-line no-control-regex -- a paste-mode toggle is not a frame
  class Tty extends Writable { isTTY = true; rows = 30; columns = 80; frame = ''; override _write(chunk: Buffer, _e: string, done: () => void) { const text = chunk.toString('utf8'); if (!/^(?:\u001b\[\?2004[hl])+$/u.test(text)) this.frame = text; done(); } }
  it('answering the first card never carries a held key into the next one', async () => {
    const answers: string[] = [];
    function Card({ id, onAnswer }: { readonly id: string; readonly onAnswer: (id: string, input: string) => void }) {
      return createElement(Window, { title: [{ text: `CARD-${id}` }], hints: 'HINT', position: '{from}-{to}/{total}', priority: WINDOW_PRIORITY.approval, decision: true,
        onInput: (input: string) => { if (input === 'y' || input === 'n') { onAnswer(id, input); return true; } return false; } });
    }
    function Queue() {
      // Closes a card as soon as it has an answer, like the panel does after a decision.
      const [open, setOpen] = useState(['A', 'B']);
      const onAnswer = (id: string, input: string) => { answers.push(`${id}:${input}`); setOpen(value => value.filter(item => item !== id)); };
      return createElement(WindowStackProvider, { composerDefault: true }, createElement(Text, null, 'BASE'), ...open.map(id => createElement(Card, { key: id, id, onAnswer })));
    }
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const instance = render(createElement(DecisionArmContext.Provider, { value: ARM }, createElement(Queue)),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await settle(40);
    expect(stdout.frame).toContain('1/2'); expect(stdout.frame.match(/CARD-/gu)).toHaveLength(1);
    await settle(ARM + 80); stdin.write('n');
    await until(() => answers.length === 1, 'first answer');
    // A held key arriving right after the switch must not answer the newly shown card.
    for (let i = 0; i < 8; i++) { stdin.write('y'); await settle(25); }
    expect(answers).toHaveLength(1);
    await settle(ARM + 80); stdin.write('n');
    await until(() => answers.length === 2, 'second answer after its own arming');
    expect(answers[1]!.endsWith(':n')).toBe(true);
  });

  it('a card replaced while a key is in flight (new revision) starts disarmed: the key never answers the replacement', async () => {
    const answers: string[] = [];
    let replace!: () => void;
    function Card({ id }: { readonly id: string }) {
      return createElement(Window, { title: [{ text: `CARD-${id}` }], hints: 'HINT', position: '{from}-{to}/{total}', priority: WINDOW_PRIORITY.approval, decision: true,
        onInput: (input: string) => { if (input === 'y' || input === 'n') { answers.push(`${id}:${input}`); return true; } return false; } });
    }
    function One() {
      const [id, setId] = useState('rev-0'); replace = () => setId('rev-1');
      return createElement(WindowStackProvider, { composerDefault: true }, createElement(Text, null, 'BASE'), createElement(Card, { key: id, id }));
    }
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const instance = render(createElement(DecisionArmContext.Provider, { value: ARM }, createElement(One)),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await settle(ARM + 80);
    // A key already in flight reaches the card that was on screen (production: the controller refuses its stale handle); the replacement
    // never takes it, nor the next one, until it has armed itself.
    replace(); stdin.write('y'); await settle(20); stdin.write('y'); await settle(60);
    expect(stdout.frame).toContain('CARD-rev-1'); expect(answers.filter(answer => answer.startsWith('rev-1'))).toEqual([]);
    await settle(ARM + 80); stdin.write('n');
    await until(() => answers.some(answer => answer.startsWith('rev-1')), 'answer after the replacement armed'); expect(answers.at(-1)).toBe('rev-1:n');
  });
});

describe('review 2026-10-18 (fail-open burst handling, focus return onto a decision)', () => {
  class Tty extends Writable { isTTY = true; rows = 30; columns = 80; frame = ''; override _write(chunk: Buffer, _e: string, done: () => void) { const text = chunk.toString('utf8'); if (!/^(?:\u001b\[\?2004[hl])+$/u.test(text)) this.frame = text; done(); } } // eslint-disable-line no-control-regex
  const keyboard = () => { const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } }); return stdin; };
  it('a question that does not take burst text drops a multi-event read whole: "\\x1b[Ay" never answers it, "\\x0fy" neither', async () => {
    const answers: Array<readonly string[] | null> = [], stdout = new Tty(), stdin = keyboard();
    const options = [{ id: 'go', label: 'Go', key: 'y' }, { id: 'stop', label: 'Stop', key: 'n' }];
    const instance = render(createElement(DecisionArmContext.Provider, { value: ARM }, createElement(WindowStackProvider, { composerDefault: true },
      createElement(QuestionWindow, { title: 'Q', kind: 'single', options, hints: 'H', position: '{from}-{to}/{total}', onAnswer: ids => { answers.push(ids); } }))),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await settle(ARM + 80);
    stdin.write('\u001b[Ay'); await settle(60); expect(answers).toEqual([]);
    await settle(ARM + 80); stdin.write('\u000fy'); await settle(60); expect(answers).toEqual([]);
    await settle(ARM + 80); stdin.write('n'); await until(() => answers.length === 1, 'deliberate key'); expect(answers[0]).toEqual(['stop']);
  });

  it('focus returning to an armed decision after a later decision closes (K1–K8 return-focus rule) re-arms it: an in-flight key never answers it', async () => {
    const answers: string[] = [];
    let openB!: () => void;
    function Card({ id, onDone }: { readonly id: string; readonly onDone?: () => void }) {
      return createElement(Window, { title: [{ text: `DECISION-${id}` }], hints: 'H', position: '{from}-{to}/{total}', priority: WINDOW_PRIORITY.approval, decision: true,
        onInput: (input: string) => { if (input === 'y' || input === 'n') { answers.push(`${id}:${input}`); onDone?.(); return true; } return false; } });
    }
    function Both() {
      const [b, setB] = useState(false); openB = () => setB(true);
      return createElement(WindowStackProvider, { composerDefault: true }, createElement(Card, { id: 'A' }), b ? createElement(Card, { id: 'B', onDone: () => setB(false) }) : null);
    }
    const stdout = new Tty(), stdin = keyboard();
    const instance = render(createElement(DecisionArmContext.Provider, { value: ARM }, createElement(Both)),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await settle(ARM + 80); // A is armed
    openB(); await settle(ARM + 80); // B took the keyboard and armed; A waits behind it
    expect(stdout.frame).toContain('DECISION-B'); expect(stdout.frame).not.toContain('DECISION-A');
    stdin.write('n'); await until(() => answers.length === 1, 'B answered'); expect(answers).toEqual(['B:n']);
    stdin.write('y'); await settle(30); stdin.write('y'); await settle(60);
    expect(answers).toEqual(['B:n']); // focus is back on A, which re-armed: the keys in flight never answer it
    await settle(ARM + 80); stdin.write('n'); await until(() => answers.length === 2, 'deliberate key on A'); expect(answers).toEqual(['B:n', 'A:n']);
  });
});
