import { afterEach, describe, expect, it } from 'vitest';
import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

/** Harness-gap quick wins (owner-approved 2026-10-18, Codex gap research items 1–4). */
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

describe('1 — persistent context use under the bar', () => {
  it('shows "unknown" before a measurement, then the /context measurement; a narrow terminal drops it before scope, state and mode', async () => {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, render: { ...WORKLINE_TEST_LABELS.render, contextUnknown: 'CTX-UNKNOWN' } }, fullscreen: true,
      streamTurn: async function* (): AsyncGenerator<TurnDelta> {
        yield { kind: 'context', promptTokens: 4_200, windowTokens: 10_000, quality: 'upper-bound' };
        yield { kind: 'text', text: 'answered\n' }; yield { kind: 'done', finish: 'stop' };
      } } as never, 120, { rows: 24 });
    mounted.push(view.instance);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    expect(view.stdout.frame).toContain('CTX-UNKNOWN');
    view.stdin.write('hello\r'); await until(() => view.stdout.frame.includes('answered') && view.stdout.frame.includes('READY'), 'answer');
    expect(view.stdout.frame).toMatch(/CTX ~42% of 10/u); expect(view.stdout.frame).not.toContain('CTX-UNKNOWN');
    Object.assign(view.stdout, { columns: 28 }); view.stdout.emit('resize'); await settle(120);
    const status = view.stdout.frame.split('\n').find(row => row.includes('READY'))!;
    expect(status).not.toContain('CTX'); expect(status).toContain('scope');
  });
});

describe('2/3 — draft stash (Ctrl+S) and edit undo (Ctrl+_)', () => {
  const CTRL_S = '\u0013', UNDO = '\u001f';
  const labels = { ...WORKLINE_TEST_LABELS, composer: { ...WORKLINE_TEST_LABELS.composer, stashed: 'STASHED' } };
  const composerRow = (frame: string) => frame.split('\n').find(row => row.startsWith('│ > ')) ?? '';
  it('puts a whole draft aside and brings it back only into an empty composer; a submit keeps the stash', async () => {
    const sent: string[] = [];
    const view = mountWorkline({ labels, completeTurn: async messages => { sent.push(String(messages.at(-1)?.content)); return 'ok'; } } as never, 100, { rows: 24 });
    mounted.push(view.instance);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    for (const char of 'first draft') { view.stdin.write(char); await settle(3); }
    view.stdin.write(CTRL_S); await settle(40);
    expect(composerRow(view.stdout.frame)).not.toContain('first draft'); expect(view.stdout.frame).toContain('STASHED');
    for (const char of 'quick question') { view.stdin.write(char); await settle(3); }
    view.stdin.write(CTRL_S); await settle(40); // a stash is already kept: nothing is overwritten, the draft stays
    expect(composerRow(view.stdout.frame)).toContain('quick question');
    view.stdin.write('\r'); await until(() => sent.length === 1, 'sent'); expect(sent[0]).toBe('quick question');
    expect(view.stdout.frame).toContain('STASHED'); // the stash survives the submit
    view.stdin.write(CTRL_S); await settle(40);
    expect(composerRow(view.stdout.frame)).toContain('first draft'); expect(view.stdout.frame).not.toContain('STASHED');
  });
  it('undoes unsent edits step by step (a typing run is one step), never resubmits, and forgets the history on submit', async () => {
    const sent: string[] = [];
    const view = mountWorkline({ labels, completeTurn: async messages => { sent.push(String(messages.at(-1)?.content)); return 'ok'; } } as never, 100, { rows: 24 });
    mounted.push(view.instance);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    for (const char of 'hello world') { view.stdin.write(char); await settle(3); }
    view.stdin.write('\u0017'); await settle(30); // Ctrl+W deletes "world"
    expect(composerRow(view.stdout.frame)).not.toContain('world');
    view.stdin.write(UNDO); await settle(30); expect(composerRow(view.stdout.frame)).toContain('hello world');
    view.stdin.write(UNDO); await settle(30); expect(composerRow(view.stdout.frame)).not.toContain('hello');
    expect(sent).toEqual([]);
    for (const char of 'abc') { view.stdin.write(char); await settle(3); }
    view.stdin.write('\r'); await until(() => sent.length === 1, 'sent');
    view.stdin.write(UNDO); await settle(30); expect(composerRow(view.stdout.frame)).not.toContain('abc'); expect(sent).toEqual(['abc']);
  });
});
