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
