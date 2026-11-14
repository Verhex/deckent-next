import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useState } from 'react';
import { render, Text } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { DecisionCard } from '#surfaces/core/approval-presentation-ink/index.js';
import { decisionArmLabels } from '#surfaces/core/cli-human/index.js';
import { DECISION_ARM_DEFAULT, DecisionArmLabelsContext, DecisionArmContext, QuestionWindow, Window, WindowStackProvider, WINDOW_PRIORITY } from '#surfaces/core/terminal-window/index.js';
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
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en'), decisionArm: decisionArmLabels('en') }, ledger: ledger(calls) as never, streamTurn: turn(gate) as never, decisionArmMs: ARM } as never, 100, { rows: 40 });
  mounted.push(view.instance); return view;
}
const cardShown = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame.includes('Approval needed');
/** A decision counts keys once its key hints show (TERMINAL-SABIT-DUZEN: the visible armed state); the settle first lets a restart repaint. */
async function armed(frame: () => string, hint: string) { await settle(); await until(() => frame().includes(hint) || frame().includes('press it again') || frame().includes('… ×') || frame().includes('Text typed here') || frame().includes('… × ↵ ↑↓'), `armed (${hint} or typed-text feedback)`); }

it('108: typed letters never approve once/session/always; Enter is not No; an open reason field still takes text (EN/TR)', async () => {
  class Screen extends Writable { isTTY = true; rows = 40; columns = 120; frame = ''; override _write(chunk: Buffer, _encoding: string, done: () => void) { if (chunk.toString().includes('Approval')) this.frame = chunk.toString(); done(); } }
  for (const locale of ['en', 'tr'] as const) for (const word of ['hello', '/policy']) {
    const labels = decisionArmLabels(locale), calls: unknown[][] = [], stdout = new Screen();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
    const instance = render(createElement(DecisionArmLabelsContext.Provider, { value: labels }, createElement(WindowStackProvider, null,
      createElement(DecisionCard, { title: { spans: [{ text: 'Approval' }], fields: [] }, projectedLines: [], prompt: 'Enter confirm', pendingText: 'Pending',
        scopes: ['session', 'always'], choices: { once: 'Once', session: 'Session', always: 'Always', no: 'No' }, reason: { label: 'Reason', hint: 'Enter keeps reason', empty: '(empty)' },
        onDecide: (...args: unknown[]) => { calls.push(args); } }))),
    { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    const press = async (input: string) => { stdin.write(input); await settle(50); };
    try {
      await armed(() => stdout.frame, 'Enter confirm');
      for (const char of word) await press(char);
      for (const char of 'asnyq12jk ') await press(char);
      expect(calls).toEqual([]); expect(stdout.frame).toContain(labels.typedText); expect(stdout.frame).toContain('› 4. No (n)');
      await press('\r'); expect(calls).toEqual([]); expect(stdout.frame).toContain(locale === 'en' ? 'Nothing was chosen.' : 'Hiçbir şey seçilmedi.');
      expect(stdout.frame).toContain('Enter confirm'); expect(stdout.frame).not.toContain(labels.typedText);
      if (word === '/policy') {
        await press('/'); // Tab must still open a reason while typed text is active.
        await press('\t'); expect(stdout.frame).toContain('Enter keeps reason');
        for (const char of 'yes always') await press(char);
        await press('\u001b[200~ pasted\r\ny1\u001b[201~'); // The open reason still receives pastes as text.
        expect(calls).toEqual([]); expect(stdout.frame).toContain('yes always pasted y1');
        await press('\r'); expect(calls).toEqual([]);
      }
      await press('y');
      expect(calls).toEqual([[true, undefined, word === 'hello' ? undefined : 'yes always pasted y1']]);
    } finally { instance.unmount(); }
  }
}, 15_000);

it('109: one early character only repeats itself on a real approval card and a questionStep owner; only its own keys clear it (EN/TR)', async () => {
  class Screen extends Writable { isTTY = true; rows = 40; columns = 120; frame = ''; override _write(chunk: Buffer, _encoding: string, done: () => void) { if (chunk.toString().includes('EARLY-CARD')) this.frame = chunk.toString(); done(); } }
  // Each row is a distinct consent risk; every press is its own stdin read at the production arming value. The rule lives in the shared
  // Window, so the rows that never reach an owner run on the approval card only, and Turkish only where its words are waited on.
  const answering = ['same', 'different', 'enter', 'unoffered', 'unhandled-repeat'], shared = ['two-early', 'paste', 'mixed-read', 'ambiguous', 'arrow', 'rearm', 'focus', 'always'];
  for (const [locale, owner, scenarios] of [['en', 'approval', [...answering, ...shared]], ['en', 'question', answering], ['tr', 'approval', ['same', 'enter']]] as const) {
    for (const scenario of scenarios) {
      const labels = decisionArmLabels(locale), calls: unknown[][] = [], stdout = new Screen();
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
      const card = owner === 'approval' ? createElement(DecisionCard, {
        title: { spans: [{ text: 'EARLY-CARD' }], fields: [] }, projectedLines: [], prompt: 'Enter confirm', pendingText: 'Pending',
        scopes: ['session', 'always'], choices: { once: 'Once', session: 'Session', always: 'Always', no: 'No' },
        onDecide: (...args: unknown[]) => { calls.push(args); },
      }) : createElement(QuestionWindow, { title: 'EARLY-CARD', kind: 'single', initial: 1,
        options: [{ id: 'yes', label: 'Yes', role: 'yes' }, { id: 'no', label: 'No', role: 'no' }], hints: 'Enter confirm', position: '',
        onAnswer: ids => { calls.push([ids]); } });
      const instance = render(createElement(DecisionArmLabelsContext.Provider, { value: labels }, createElement(WindowStackProvider, { composerDefault: true }, card)),
        { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
      mounted.push(instance);
      const press = async (input: string) => { stdin.write(input); await settle(35); };
      const wait = (words: string) => until(() => stdout.frame.includes(words), `${locale}/${owner}/${scenario}: ${words}`);
      try {
        await wait(labels.arming);
        const first = scenario === 'always' ? 'a' : scenario === 'unoffered' || scenario === 'unhandled-repeat' || scenario === 'focus' ? 'x' : 'y';
        await press(scenario === 'paste' ? '\u001b[200~y\u001b[201~' : scenario === 'mixed-read' ? '\u001b[Ay' : scenario === 'ambiguous' ? '\u000fy' : first);
        if (scenario === 'two-early') await press('y');
        expect(calls, `${owner}/${scenario}: early`).toEqual([]);
        expect(stdout.frame).toContain(labels.arming); expect(stdout.frame).not.toContain(labels.ignored);
        const text = ['two-early', 'paste', 'mixed-read', 'ambiguous'].includes(scenario);
        await wait(text ? labels.typedText : labels.ignored);
        if (scenario === 'focus' || scenario === 'rearm') {
          // Neither a focus round trip nor a rejected non-text read forgets the early key: the card re-arms into the same repeat row.
          if (scenario === 'focus') { await press(CTRL_O); expect(stdout.frame).not.toContain(labels.ignored); await press(CTRL_O); } else await press('\r\u001b[A');
          expect(calls).toEqual([]); await wait(labels.arming); await wait(labels.ignored);
        }
        if (scenario === 'same' || scenario === 'always') {
          await press(first);
          expect(calls).toEqual(owner === 'question' ? [[['yes']]] : [[true, scenario === 'always' ? 'always' : undefined, undefined]]);
          continue;
        }
        if (scenario === 'arrow') {
          await press('\u001b[A'); expect(calls).toEqual([]); await wait('Enter confirm');
          expect(stdout.frame).not.toContain(labels.unchosen); await press('n');
        } else {
          if (scenario !== 'enter') {
            await press(scenario === 'different' || scenario === 'rearm' ? 'n' : scenario === 'unhandled-repeat' ? 'x' : 'y');
            expect(calls).toEqual([]); await wait(labels.typedText);
          }
          await press('\r'); expect(calls).toEqual([]); await wait(labels.unchosen);
          expect(stdout.frame).toContain('Enter confirm'); expect(stdout.frame).not.toContain(labels.typedText);
          await press('n');
        }
        expect(calls).toEqual(owner === 'question' ? [[['no']]] : [[false, undefined, undefined]]);
      } finally { instance.unmount(); }
    }
  }
}, 45_000);

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
      await armed(() => view.stdout.frame, 'Enter confirm'); view.stdin.write('\u001b');
      await until(() => calls.length === 1 && !cardShown(view), 'denied'); expect(calls[0]![1]).toBe('deny');
      await settle(60); expect(view.stdout.frame).toMatch(/│ > y+/u);
    } finally { gate.release(); }
  });

  it('keys during arming are swallowed; a held (auto-repeated) key keeps it disarmed; it answers only after a quiet period', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card');
      // A shown number answers an armed card (owner 2026-10-29); typed while it arms, "1" (Yes, once) decides nothing.
      view.stdin.write('1'); await settle(30); expect(calls).toEqual([]);
      // Auto-repeat of y every 30 ms for longer than the arming period: never decides.
      for (let elapsed = 0; elapsed < ARM * 2.5; elapsed += 30) { view.stdin.write('y'); await settle(30); }
      expect(calls).toEqual([]);
      // A bracketed paste after arming never answers either.
      await armed(() => view.stdout.frame, 'Enter confirm'); view.stdin.write('\u001b[200~y\r\u001b[201~'); await settle(60);
      expect(calls).toEqual([]);
      // Owner 108: the Enter following swallowed text also decides nothing; Enter again denies (No is the default).
      await armed(() => view.stdout.frame, 'Enter confirm'); view.stdin.write('\r'); await settle(60); expect(calls).toEqual([]);
      view.stdin.write('\r'); await until(() => calls.length === 1, 'decision'); expect(calls[0]![1]).toBe('deny');
    } finally { gate.release(); }
  });

  it('Esc during arming decides nothing; a focus round trip (Ctrl+O twice) re-arms the card', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card');
      view.stdin.write('\u001b'); await settle(40); expect(calls).toEqual([]);
      await armed(() => view.stdout.frame, 'Enter confirm');
      view.stdin.write(CTRL_O); await settle(30); view.stdin.write(CTRL_O); await settle(20); view.stdin.write('y'); await settle(60);
      expect(calls).toEqual([]);
      // Owner 109: only the same early y answers once the repeat row is visible.
      await until(() => view.stdout.frame.includes('press it again'), 'same early y can count'); view.stdin.write('y');
      await until(() => calls.length === 1, 'approved after re-arm'); expect(calls[0]).toEqual(['appr-race', 'allow', undefined]);
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
      await until(() => cardShown(view), 'card'); await armed(() => view.stdout.frame, 'Enter confirm');
      for (const bytes of ['\u001b[13;5u', '\u001b\r', '\u001b[13;5uy']) {
        view.stdin.write(bytes); await settle(60); expect(calls).toEqual([]); await armed(() => view.stdout.frame, 'Enter confirm');
      }
      view.stdin.write('\t'); await until(() => view.stdout.frame.includes('Reason'), 'reason field'); await settle(40);
      view.stdin.write('\r\u001b[Ay'); await settle(80);
      expect(calls).toEqual([]);
    } finally { gate.release(); }
  });

  it('an unbracketed burst ending in a lone y ("text\\x7fy") never decides', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card'); await armed(() => view.stdout.frame, 'Enter confirm');
      view.stdin.write('text\u007fy'); await settle(80);
      expect(calls).toEqual([]);
      // A later answer letter remains text until Enter or an arrow ends the text.
      await armed(() => view.stdout.frame, 'Enter confirm'); view.stdin.write('n'); await settle(60); expect(calls).toEqual([]);
      view.stdin.write('\r'); await settle(60); expect(calls).toEqual([]); view.stdin.write('n'); await until(() => calls.length === 1, 'deliberate n'); expect(calls[0]![1]).toBe('deny');
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
    await armed(() => stdout.frame, 'HINT'); stdin.write('n');
    await until(() => answers.length === 1, 'first answer');
    // A held key arriving right after the switch must not answer the newly shown card.
    for (let i = 0; i < 8; i++) { stdin.write('y'); await settle(25); }
    expect(answers).toHaveLength(1);
    await armed(() => stdout.frame, 'HINT'); stdin.write('n'); await settle(60); expect(answers).toHaveLength(1);
    stdin.write('\r'); await settle(60); expect(answers).toHaveLength(1); stdin.write('n');
    await until(() => answers.length === 2, 'second answer after its own arming');
    expect(answers[1]!.endsWith(':n')).toBe(true);
  });

  it('a new question in the same window (inputRevision) is unarmed from its first frame: its keys are not drawn before they count', async () => {
    const answers: string[] = [], frames: string[] = [];
    let next!: () => void;
    function One() {
      const [turn, setTurn] = useState(0); next = () => setTurn(1);
      return createElement(WindowStackProvider, { composerDefault: true }, createElement(Window, { title: [{ text: `Q-${turn}` }], hints: 'HINT', position: '{from}-{to}/{total}',
        priority: WINDOW_PRIORITY.approval, decision: true, inputRevision: turn, onInput: (input: string) => { if (input === 'y') { answers.push(`${turn}:y`); return true; } return false; } }));
    }
    class Frames extends Tty { override _write(chunk: Buffer, encoding: string, done: () => void) { frames.push(chunk.toString('utf8')); super._write(chunk, encoding, done); } }
    const stdout = new Frames(), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const labels = { arming: 'ARMING', ignored: 'AGAIN', typedText: 'TEXT', unchosen: 'NONE' }, counts = (frame: string) => /HINT|AGAIN|TEXT/u.test(frame);
    const instance = render(createElement(DecisionArmContext.Provider, { value: ARM }, createElement(DecisionArmLabelsContext.Provider, { value: labels }, createElement(One))),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await armed(() => stdout.frame, 'HINT');
    // The key sent with the change never answers the new question (a read of the old question is text, a read of the new one its early key),
    // and every frame of the new question says "arming" until its keys count.
    frames.length = 0; next(); stdin.write('y'); await settle(60); expect(answers).toEqual([]);
    await until(() => stdout.frame.includes('Q-1') && counts(stdout.frame), 'question two armed');
    const second = frames.filter(frame => frame.includes('Q-1')), until2 = second.findIndex(counts);
    expect(until2).toBeGreaterThan(0); expect(second.slice(0, until2).every(frame => frame.includes('ARMING'))).toBe(true);
    stdin.write('\r'); await until(() => stdout.frame.includes('NONE') && stdout.frame.includes('HINT'), 'the Enter after that key chooses nothing'); expect(answers).toEqual([]);
    stdin.write('y'); await until(() => answers.length === 1, 'a deliberate key answers question two'); expect(answers).toEqual(['1:y']);
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
    await armed(() => stdout.frame, 'HINT');
    // A key already in flight reaches the card that was on screen (production: the controller refuses its stale handle); the replacement
    // never takes it, nor the next one, until it has armed itself.
    replace(); stdin.write('y'); await settle(20); stdin.write('y'); await settle(60);
    expect(stdout.frame).toContain('CARD-rev-1'); expect(answers.filter(answer => answer.startsWith('rev-1'))).toEqual([]);
    await armed(() => stdout.frame, 'HINT'); stdin.write('n'); await settle(60); expect(answers.filter(answer => answer.startsWith('rev-1'))).toEqual([]);
    stdin.write('\r'); await settle(60); stdin.write('n');
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
      createElement(QuestionWindow, { title: 'Q', kind: 'single', options, hints: 'HINT', position: '{from}-{to}/{total}', onAnswer: ids => { answers.push(ids); } }))),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, interactive: true, exitOnCtrlC: false });
    mounted.push(instance);
    await armed(() => stdout.frame, 'HINT');
    stdin.write('\u001b[Ay'); await settle(60); expect(answers).toEqual([]);
    await armed(() => stdout.frame, 'HINT'); stdin.write('\u000fy'); await settle(60); expect(answers).toEqual([]);
    await armed(() => stdout.frame, 'HINT'); stdin.write('n'); await settle(60); expect(answers).toEqual([]);
    stdin.write('\r'); await settle(60); expect(answers).toEqual([]); stdin.write('n'); await until(() => answers.length === 1, 'deliberate key'); expect(answers[0]).toEqual(['stop']);
  });

  it('focus returning to an armed decision after a later decision closes (K1–K8 return-focus rule) re-arms it: an in-flight key never answers it', async () => {
    const answers: string[] = [];
    let openB!: () => void;
    function Card({ id, onDone }: { readonly id: string; readonly onDone?: () => void }) {
      return createElement(Window, { title: [{ text: `DECISION-${id}` }], hints: 'HINT', position: '{from}-{to}/{total}', priority: WINDOW_PRIORITY.approval, decision: true,
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
    await armed(() => stdout.frame, 'HINT'); // A is armed
    openB(); await armed(() => stdout.frame, 'HINT'); // B took the keyboard and armed; A waits behind it
    expect(stdout.frame).toContain('DECISION-B'); expect(stdout.frame).not.toContain('DECISION-A');
    stdin.write('n'); await until(() => answers.length === 1, 'B answered'); expect(answers).toEqual(['B:n']);
    stdin.write('y'); await settle(30); stdin.write('y'); await settle(60);
    expect(answers).toEqual(['B:n']); // focus is back on A, which re-armed: the keys in flight never answer it
    await armed(() => stdout.frame, 'HINT'); stdin.write('n'); await settle(60); expect(answers).toEqual(['B:n']);
    stdin.write('\r'); await settle(60); expect(answers).toEqual(['B:n']); stdin.write('n'); await until(() => answers.length === 2, 'deliberate key on A'); expect(answers).toEqual(['B:n', 'A:n']);
  });
});

describe('CI 2026-10-18: a key during arming is never a silent swallow', () => {
  it('109: one early key shows arming until ready, then press again; a focus round trip keeps the remembered key', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise), labels = decisionArmLabels('en');
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card');
      expect(view.stdout.frame).toContain(labels.arming); expect(view.stdout.frame).not.toContain('Enter confirm');
      view.stdin.write('x'); await settle(40); expect(calls).toEqual([]);
      expect(view.stdout.frame).toContain(labels.arming); expect(view.stdout.frame).not.toContain(labels.ignored);
      view.stdin.write('\r'); await settle(40); expect(calls).toEqual([]); // Even Enter while unarmed is swallowed.
      expect(view.stdout.frame).toContain(labels.arming); expect(view.stdout.frame).not.toContain(labels.typedText);
      await until(() => view.stdout.frame.includes(labels.ignored), 'armed one early key');
      expect(view.stdout.frame).not.toContain(labels.typedText);
      view.stdin.write(CTRL_O); await settle(40); expect(view.stdout.frame).not.toContain(labels.ignored); view.stdin.write(CTRL_O);
      await until(() => view.stdout.frame.includes(labels.ignored), 'the early x is still remembered after the focus round trip'); expect(calls).toEqual([]);
      view.stdin.write('h'); await until(() => view.stdout.frame.includes(labels.typedText), 'another letter after the early x is text');
      view.stdin.write('n'); await settle(40); expect(calls).toEqual([]);
      view.stdin.write('\r'); await settle(40); expect(calls).toEqual([]);
      expect(view.stdout.frame).toContain(labels.unchosen); expect(view.stdout.frame).toContain('Enter confirm');
      view.stdin.write(CTRL_O); await settle(40); view.stdin.write(CTRL_O);
      await until(() => view.stdout.frame.includes('Enter confirm'), 'normal keys after unchosen re-arm');
      expect(view.stdout.frame).not.toContain(labels.unchosen);
      view.stdin.write('n'); await until(() => calls.length === 1, 'fresh n after focus re-arm'); expect(calls[0]![1]).toBe('deny');
    } finally { gate.release(); }
  });

  it('a read of navigation keys only (held PgDn, coalesced arrows) still scrolls/moves an armed card and never decides; adding a letter drops it', async () => {
    const gate = hold(), calls: unknown[][] = [], view = mountCard(calls, gate.promise);
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
      await until(() => cardShown(view), 'card'); await armed(() => view.stdout.frame, 'Enter confirm');
      expect(view.stdout.frame).toContain('› 3. No (n)');
      view.stdin.write('\u001b[A\u001b[A'); await until(() => view.stdout.frame.includes('› 1. Yes, once (y)'), 'highlight moved by a coalesced read');
      expect(calls).toEqual([]);
      view.stdin.write('\u001b[By'); await settle(80); expect(calls).toEqual([]); // navigation + letter in one read: dropped whole
      expect(view.stdout.frame).toContain('› 1. Yes, once (y)');
    } finally { gate.release(); }
  });
});
