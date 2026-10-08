import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from '#platform/index.js';
import type { RunView, WorkerObservationReport } from '#engine/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { WORKLINE_TEST_LABELS, mountWorkline, settle, until } from '../support/workline-harness.js';

// TUI2 L3: the run and worker cards carry words from the catalog (no `rev`, `cancel`, `pending:2 active:1`, raw process or authority names)
// and a short run identity; the real workline renders them in EN and TR without colour (NO_COLOR palette). SLASH-WINDOWS (SW-2): run and worker
// rows live in windows now, never as chat cards; the run card words are the `/watch-runs` window rows, the worker words the `/workers` window rows.
const RUN = '3f2a9c1e-8b4d-4e7a-9c55-1d2e3f4a5b6c', TASK = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const run = { runId: RUN, scopeId: 'scope-main', revision: 4, cancellationRequested: true, tasks: [{ phase: 'pending' }, { phase: 'pending' }, { phase: 'active' }, { phase: 'weird' }] } as unknown as RunView;
const report = { schemaVersion: 1, observedAt: 1, scopeId: 'scope-main', control: 'observe-only', sources: [{ workers: [
  { taskId: TASK, identity: null, provider: 'claude', process: 'running', authority: 'next-ledger', files: null },
  { taskId: 'legacy-1', identity: null, provider: 'docker', process: 'present-unverified', authority: 'legacy-activity', files: null }] }] } as unknown as WorkerObservationReport;
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
async function card(locale: Locale, command: string, done: string) {
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, runCard: locale === 'en' ? 'Run' : 'İş', workerCard: locale === 'en' ? 'Worker' : 'İşçi', work: workSurfaceLabels(locale) },
    ledger: { scopeId: 'scope-main', async listWorkers() { return report; }, async inspectRun() { return run; }, async listRunIds() { return [RUN]; } } as never });
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready');
  for (const char of `${command}\r`) { view.stdin.write(char); await settle(2); }
  await until(() => view.stdout.text.includes(done), `card ${command}`);
  return view.stdout.text;
}

describe('run and worker cards', () => {
  it.each([['en', ['revision 4 · cancellation requested', '2 waiting, 1 running, 1 weird', '· 3f2a9c1e']],
    ['tr', ['revizyon 4 · iptal istendi', '2 bekliyor, 1 çalışıyor, 1 weird', '· 3f2a9c1e']]] as const)('/runs (%s)', async (locale, lines) => {
    const text = await card(locale, '/watch-runs ', lines[2]);
    for (const line of lines) expect(text).toContain(line);
    expect(text).not.toContain(RUN); expect(text).not.toMatch(/\brev\b|pending:|active:|· cancel\b/u);
  });
  it.each([['en', ['[running] worker 1 · claude · running', '[present (unverified)] worker 2 · docker · present (unverified)']],
    ['tr', ['[çalışıyor] işçi 1 · claude · çalışıyor', '[var (doğrulanmadı)] işçi 2 · docker · var (doğrulanmadı)']]] as const)('/workers (%s)', async (locale, lines) => {
    const text = await card(locale, '/workers ', lines[1]);
    for (const line of lines) expect(text).toContain(line);
    expect(text).not.toContain(TASK); expect(text).not.toMatch(/next-ledger|legacy-activity|present-unverified/u);
  });
});
