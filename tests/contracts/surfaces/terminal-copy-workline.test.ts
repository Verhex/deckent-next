import { afterEach, describe, expect, it } from 'vitest';
import type { TurnDelta } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

// T1: `/copy [n]` through the real Ink workline. The rich terminal drops slash arguments (SLASH-WINDOWS), except for /copy, whose argument is the answer number.
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
const COPY = { sent: 'COPIED {n} {count}', none: 'COPY-NONE', range: 'COPY-RANGE {max}', usage: 'COPY-USAGE', tooLarge: 'COPY-BIG {n} {bytes} {max}', unavailable: 'COPY-UNAVAILABLE' };

async function open(extra: Record<string, unknown>) {
  const copied: string[] = [];
  let turn = 0;
  const view = mountWorkline({ clipboard: text => { copied.push(text); return { ok: true, bytes: Buffer.byteLength(text) }; }, ...extra,
    async *streamTurn() {
      const text = `answer-${++turn}`;
      yield { kind: 'text', text } as TurnDelta;
      yield { kind: 'message', message: { role: 'assistant', content: text, toolCalls: [] } };
      yield { kind: 'done', finish: 'stop' };
    } } as never);
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready');
  const say = async (line: string, after: string) => { view.stdin.write(`${line}\r`); await until(() => view.stdout.text.includes(after), after); await until(() => view.stdout.frame.includes('READY'), 'idle'); await settle(20); };
  return { ...view, copied, say };
}

describe.each([['line terminal', { labels: { ...WORKLINE_TEST_LABELS, copy: COPY } }],
  ['rich terminal with slash windows', { labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, copy: COPY } }]] as const)('/copy in the %s', (_name, props) => {
  it('sends the latest answer, the n-th latest with a typed number, and says so', async () => {
    const view = await open(props);
    await view.say('one', 'answer-1'); await view.say('two', 'answer-2');
    await view.say('/copy', 'COPIED 1 8');
    await view.say('/copy 2', 'COPIED 2 8');
    expect(view.copied).toEqual(['answer-2', 'answer-1']);
    await view.say('/copy 3', 'COPY-RANGE 2');
    await view.say('/copy x', 'COPY-USAGE');
    expect(view.copied).toHaveLength(2);
  });

  it('says there is nothing to copy before any answer, and that the clipboard is unavailable without a host writer', async () => {
    const empty = await open(props);
    await empty.say('/copy', 'COPY-NONE');
    expect(empty.copied).toEqual([]);
    const none = await open({ ...props, clipboard: undefined });
    await none.say('hello', 'answer-1'); await none.say('/copy', 'COPY-UNAVAILABLE');
  });
});

it('without /copy words the command is reported unavailable instead of doing nothing', async () => {
  const view = await open({ labels: WORKLINE_TEST_LABELS });
  await view.say('hello', 'answer-1'); await view.say('/copy', 'NO-PORT copy');
  expect(view.copied).toEqual([]);
});
