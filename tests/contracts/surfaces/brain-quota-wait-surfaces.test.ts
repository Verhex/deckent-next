// f3 item 1 (owner Q-H4): the Brain quota wait is visible where the person planned — the terminal /do window and the active work strip, the CLI
// `do` stderr line — and cancellable there. Texts come from the brainwait EN/TR family. No model call.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { BrainPlanObserver, BrainPlanProgress } from '#domain/index.js';
import { clockText, t } from '#platform/index.js';
import { activeWorkItems } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { main } from '../../fixtures/cli-input.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

const mounted: ReturnType<typeof mountWorkline>[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const view of mounted.splice(0)) view.instance.unmount(); for (const close of cleanup.splice(0)) await close(); });
const untilMs = Date.UTC(2026, 9, 23, 18, 5), wait: Extract<BrainPlanProgress, { kind: 'quota-wait' }> = { kind: 'quota-wait', attempt: 2, maxAttempts: 2,
  resetsAtMs: untilMs - 15_000, untilMs, after: { commandId: 'c1', invocationId: 'i1' } };

it('the active work strip names the quota wait and its local reset time (EN/TR from the catalog)', () => {
  for (const locale of ['en', 'tr'] as const) {
    const labels = workSurfaceLabels(locale);
    const [item] = activeWorkItems({ labels: labels.activeWork!, jobs: labels.jobs!, duration: labels.workerLine, nowMs: 100_000, runs: [],
      active: { title: 'order', phase: 'quota-wait', sinceMs: 40_000, untilText: clockText(untilMs) } });
    expect(item!.state).toBe(t('brainwait.activeWork', { time: clockText(untilMs) }, locale));
    expect(item!.role).toBe('warning');
  }
  expect(t('brainwait.activeWork', { time: 'X' }, 'tr')).toContain('kota beklemesi');
});

it('terminal /do shows the wait in its window with the cancel hint; Ctrl+C cancels the waiting plan', async () => {
  let signal: AbortSignal | undefined, observed: BrainPlanObserver | undefined;
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, work: workSurfaceLabels('en') }, pollMs: 60_000,
    doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => [],
      quotaWait: progress => ({ untilText: clockText(progress.untilMs), hint: t('brainwait.cancelHint', {}, 'en'),
        body: t('brainwait.window', { time: clockText(progress.untilMs), attempt: progress.attempt, maxAttempts: progress.maxAttempts }, 'en') }),
      plan: async (_intent, _id, received, _reference, observe) => {
        signal = received; observed = observe; observe?.(wait);
        return new Promise((_resolve, reject) => received.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      } } });
  mounted.push(view);
  await settle(40); view.stdin.write('/do Prepare purchase\r');
  await until(() => view.stdout.frame.includes('Brain waits until'), 'quota wait window');
  expect(observed).toBeTypeOf('function');
  expect(view.stdout.frame).toContain(clockText(untilMs)); expect(view.stdout.frame).toContain('stop waiting and cancel planning');
  expect(view.stdout.frame).not.toContain('PLANNING');
  await settle(40); view.stdin.write('\u0003');
  await until(() => signal?.aborted === true && !view.stdout.frame.includes('Brain waits until'), 'cancelled wait');
});

it('CLI do passes an observer and prints the wait and the next attempt on stderr; stdout keeps the one JSON result (EN/TR)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-brain-wait-cli-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  const stdout: string[] = [], stderr: string[] = [], result = pendingBrainFixture();
  const context = { root, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') }, stdout: { write(text: string) { stdout.push(text); } },
    stderr: { write(text: string) { stderr.push(text); } },
    async planRun(_root: string, _input: unknown, _options: unknown, _signal?: AbortSignal, observe?: BrainPlanObserver) {
      observe?.(wait); observe?.({ kind: 'planning', attempt: 2 }); return result; } };
  for (const locale of ['en', 'tr'] as const) {
    stdout.length = 0; stderr.length = 0;
    expect(await main(['do', '--request', 'Plan purchase', '--scope', 's', '--command-id', 'brain', '--json', '--lang', locale], context)).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(result);
    expect(stderr.join('')).toContain(t('brainwait.cli', { time: clockText(untilMs), attempt: 2, maxAttempts: 2 }, locale));
    expect(stderr.join('')).toContain(t('brainwait.resumed', { attempt: 2 }, locale));
  }
});
