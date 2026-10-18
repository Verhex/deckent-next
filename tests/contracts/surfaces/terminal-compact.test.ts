import { afterEach, describe, expect, it } from 'vitest';
import { t } from '#platform/index.js';
import type { WorklineStreamTurn } from '#surfaces/core/terminal/index.js';
import { terminalInfoLabels } from '#surfaces/core/terminal-admin/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// K3 (owner 2026-10-14, protocol v30): bare `/compact` compacts the conversation now through the service (no model round), a `/compact` typed
// during a turn waits behind it, and `/context` offers compacting now and a focus window (Tab writes the focus, y compacts, n keeps).
const words = (key: string) => t(key as never, {}, 'en');
const COMPACT = { running: words('terminal.compact.running'), focusTitle: words('terminal.compact.focusTitle'), focusDetail: words('terminal.compact.focusDetail'),
  focusPrompt: words('terminal.compact.focusPrompt'), pending: words('terminal.compact.pending'), kept: words('terminal.compact.kept'),
  reason: { label: words('terminal.compact.reason.label'), hint: words('terminal.compact.reason.hint'), empty: words('terminal.compact.reason.empty') },
  now: words('terminal.compact.now'), nowDetail: words('terminal.compact.nowDetail'), withFocus: words('terminal.compact.withFocus'), withFocusDetail: words('terminal.compact.withFocusDetail') };
const ESC = '\u001B', TAB = '\t', DOWN = '\u001B[B';
type Call = Readonly<{ messages: readonly { role: string; content: string }[]; compact?: Readonly<{ focus?: string }> }>;
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

function fake(gate?: Promise<void>) {
  const calls: Call[] = [];
  const streamTurn: WorklineStreamTurn = async function* (messages, _signal, turn) {
    calls.push({ messages: messages.map(message => ({ role: message.role, content: message.content })), ...(turn?.compact ? { compact: turn.compact } : {}) });
    if (turn?.compact) {
      yield { kind: 'compacted', messages: [{ role: 'user', content: 'SUMMARY-OF-OLDER' }, ...messages.slice(-1)], replacedMessages: messages.length - 2 } as never;
      yield { kind: 'done', finish: 'stop', note: '[deckent] COMPACTED-NOTE' } as never;
      return;
    }
    if (gate) await gate;
    const answer = `ANSWER-${calls.length}`;
    yield { kind: 'text', text: answer } as never;
    yield { kind: 'message', message: { role: 'assistant', content: answer, toolCalls: [] } } as never;
    yield { kind: 'done', finish: 'stop', note: null } as never;
  };
  return { calls, streamTurn };
}
async function type(view: ReturnType<typeof mountWorkline>, text: string) { for (const char of text) { view.stdin.write(char); await settle(2); } }
function open(streamTurn?: WorklineStreamTurn, extra: Record<string, unknown> = {}) {
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, compact: COMPACT }, ...(streamTurn ? { streamTurn } : {}), ...extra });
  mounted.push(view.instance); return view;
}

describe('/compact (K3)', () => {
  it('sends one compact turn with the whole history, replaces the history with the compacted one, and the next turn carries it', async () => {
    const { calls, streamTurn } = fake(), view = open(streamTurn);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    await type(view, 'first\r'); await until(() => view.stdout.text.includes('ANSWER-1'), 'first answer');
    await type(view, 'second\r'); await until(() => view.stdout.text.includes('ANSWER-2'), 'second answer');
    await type(view, '/compact\r'); await until(() => view.stdout.text.includes('COMPACTED-NOTE'), 'compaction note');
    expect(view.stdout.text).toContain(COMPACT.running); expect(view.stdout.text).not.toContain('[deckent] COMPACTED-NOTE');
    const compact = calls[2]!;
    expect(compact.compact).toEqual({});
    expect(compact.messages.map(message => message.content)).toEqual(['SYSTEM', 'first', 'ANSWER-1', 'second', 'ANSWER-2']);
    await type(view, 'third\r'); await until(() => view.stdout.text.includes('ANSWER-4'), 'next answer');
    expect(calls[3]!.messages.map(message => message.content)).toEqual(['SYSTEM', 'SUMMARY-OF-OLDER', 'ANSWER-2', 'third']);
  });

  it('a /compact typed during a running turn waits behind it, then runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { calls, streamTurn } = fake(gate), view = open(streamTurn);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    await type(view, 'long\r'); await until(() => calls.length === 1, 'turn running');
    await type(view, '/compact\r'); await until(() => view.stdout.text.includes('QUEUED: /compact'), 'queued');
    await settle(60); expect(calls).toHaveLength(1);
    release(); await until(() => calls.length === 2 && view.stdout.text.includes('COMPACTED-NOTE'), 'compaction after the turn');
    expect(calls[1]!.compact).toEqual({}); expect(calls[1]!.messages.map(message => message.content)).toEqual(['SYSTEM', 'long', 'ANSWER-1']);
  });

  it.each(['y', 'n'] as const)('/context offers "Compact now" and the focus window; %s on the focus window', async key => {
    const { calls, streamTurn } = fake(), info = { ports: {}, labels: terminalInfoLabels('en') };
    const view = open(streamTurn, { info, sessions: { async save() {}, async list() { return []; }, async load() { return null; } } });
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    await type(view, 'hello\r'); await until(() => view.stdout.text.includes('ANSWER-1'), 'answer');
    await type(view, '/context\r'); await until(() => view.stdout.frame.includes(COMPACT.now) && view.stdout.frame.includes(COMPACT.withFocus), 'context choices');
    await settle(40); await type(view, DOWN); await settle(40); await type(view, '\r');
    await until(() => view.stdout.frame.includes(COMPACT.focusTitle) && view.stdout.frame.includes(COMPACT.focusPrompt), 'focus window');
    await type(view, TAB); await type(view, 'keep the API decisions (y is text here)'); await type(view, TAB);
    expect(calls).toHaveLength(1);
    await type(view, key);
    if (key === 'y') {
      await until(() => calls.length === 2, 'compact turn with the focus');
      expect(calls[1]!.compact).toEqual({ focus: 'keep the API decisions (y is text here)' });
    } else {
      await until(() => view.stdout.text.includes(COMPACT.kept), 'kept'); await settle(60); expect(calls).toHaveLength(1);
    }
  });

  it('Esc on the focus window sends nothing; without the streamed agent turn /compact says the part is unavailable', async () => {
    const { calls, streamTurn } = fake(), info = { ports: {}, labels: terminalInfoLabels('en') };
    const view = open(streamTurn, { info, sessions: { async save() {}, async list() { return []; }, async load() { return null; } } });
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    await type(view, '/context\r'); await until(() => view.stdout.frame.includes(COMPACT.withFocus), 'context choices');
    await settle(40); await type(view, DOWN); await settle(40); await type(view, '\r'); await until(() => view.stdout.frame.includes(COMPACT.focusTitle), 'focus window');
    await type(view, ESC); await until(() => view.stdout.text.includes(COMPACT.kept), 'kept'); expect(calls).toHaveLength(0);
    const plain = open(undefined);
    await until(() => plain.stdout.frame.includes('READY'), 'ready');
    await type(plain, '/compact\r'); await until(() => plain.stdout.text.includes('NO-PORT compact'), 'unavailable');
  });
});
