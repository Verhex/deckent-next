import { describe, expect, it } from 'vitest';
import type { MonitorRun, MonitorSnapshot } from '#engine/index.js';
import { loadMonitorSurface, renderBriefLines } from '#surfaces/core/monitor/index.js';
import { emptySnapshot, fullSnapshot, OBSERVED_AT } from '../../fixtures/monitor/snapshots.js';

/** M2/M3: worker narrative, typed delivery outlook and failed tests, EN + TR, from fixture snapshots (the producer side is covered by the engine and composition tests). */
const surface = await loadMonitorSurface();
const base = fullSnapshot.installs[0]!.runs.find(run => run.state === 'accepted')!;
const MIN = 60_000;
const snapshotWith = (run: MonitorRun): MonitorSnapshot => ({ ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs: [run] }] });
const detail = (snapshot: MonitorSnapshot, locale: 'en' | 'tr') => surface.buildMonitorView(snapshot, locale, true).tabs.runs
  .flatMap(block => block.kind === 'table' ? block.rows : []).flatMap(row => row.detail().map(line => line.map(item => item.text).join(''))).join('\n');
const summaryText = (snapshot: MonitorSnapshot, locale: 'en' | 'tr') => surface.renderMonitorText(snapshot, { locale, width: 200, ascii: true });
const patchless: MonitorRun = { ...base, runId: 'run-dt', delivery: null, deliveryOutlook: 'patch-not-prepared' };

describe('M2 delivery outlook of an accepted Run', () => {
  it('names a prepared-nothing accepted Run as "patch not prepared" in the Runs table, the detail and the summary (EN + TR), without claiming a cause', () => {
    const en = summaryText(snapshotWith(patchless), 'en'), tr = summaryText(snapshotWith(patchless), 'tr');
    expect(en).toContain('patch not prepared'); expect(tr).toContain('yama hazırlanamadı');
    expect(detail(snapshotWith(patchless), 'en')).toContain("Accepted · patch not prepared: no retained patch exists for this Run's accepted work");
    expect(detail(snapshotWith(patchless), 'tr')).toContain('Kabul edildi · yama hazırlanamadı: bu Run');
    expect(detail(snapshotWith(patchless), 'en')).toContain('does not record why'); expect(detail(snapshotWith(patchless), 'en')).not.toMatch(/PATCH_LIMIT|artifacts\.maxBytes/);
    const summary = surface.buildMonitorView(snapshotWith(patchless), 'en', true).tabs.summary.filter(block => block.kind === 'line').map(block => block.line.map(item => item.text).join(''));
    expect(summary).toContain('! run-dt · accepted · patch not prepared');
  });
  it('words every other outlook, and a receipt always wins over the outlook', () => {
    for (const [outlook, en, tr] of [['none', 'no delivery', 'teslim yok'], ['awaiting-delivery', 'awaiting delivery', 'teslim bekliyor']] as const) {
      const run: MonitorRun = { ...base, runId: 'run-x', delivery: null, deliveryOutlook: outlook };
      expect(summaryText(snapshotWith(run), 'en')).toContain(en); expect(summaryText(snapshotWith(run), 'tr')).toContain(tr);
    }
    const delivered: MonitorRun = { ...base, runId: 'run-y', delivery: { state: 'adopted', commit: null }, deliveryOutlook: 'patch-not-prepared' };
    expect(surface.renderMonitorText(snapshotWith(delivered), { locale: 'en', width: 200, ascii: true })).toContain('adopted');
  });
  it('negative: a Run without an outlook (open, failed, or older reader) shows no delivery claim', () => {
    const plain: MonitorRun = { ...base, runId: 'run-z', delivery: undefined as never };
    const { deliveryOutlook, ...without } = plain as MonitorRun & { deliveryOutlook?: unknown }; void deliveryOutlook;
    const text = summaryText(snapshotWith(without as MonitorRun), 'en');
    expect(text).not.toContain('patch not prepared'); expect(text).not.toContain('awaiting delivery'); expect(text).not.toContain('no delivery');
  });
  it('run inspect / worker brief carries the same outlook and failed tests through the shared brief lines', () => {
    const result = { schemaVersion: 1 as const, attemptId: 'a', claimLabel: 'CLAIM' as const, report: null, evaluation: { verdict: 'accepted' as const }, runDelivery: null, openIssues: null,
      deliveryOutlook: 'patch-not-prepared' as const, failedTests: { count: 7, names: ['a.test.ts > one', 'b.test.ts > two'], truncated: true } };
    const en = renderBriefLines(undefined, result, 'en').join('\n'), tr = renderBriefLines(undefined, result, 'tr').join('\n');
    expect(en).toContain('Accepted · patch not prepared'); expect(tr).toContain('Kabul edildi · yama hazırlanamadı');
    expect(en).toContain('Failed tests: 7 (first 2): a.test.ts > one; b.test.ts > two'); expect(en).toContain('… 5 more not listed');
    expect(tr).toContain('Başarısız testler: 7 (ilk 2)');
    expect(renderBriefLines(undefined, { ...result, deliveryOutlook: undefined, failedTests: undefined }, 'en').join('\n')).toContain('Delivery/landing receipt: not recorded');
  });
});

describe('M2 worker narrative', () => {
  const task = base.tasks[0]!;
  const run = (over: Partial<NonNullable<typeof task.lastAttempt>>): MonitorRun => ({ ...base, tasks: [{ ...task, lastAttempt: { ...task.lastAttempt!, startedAtMs: OBSERVED_AT - 5 * MIN, endedAtMs: OBSERVED_AT - 4 * MIN, ...over } }] });
  it('tells provider/model, start, finish with duration, turns and close reason in EN and TR', () => {
    const closed = run({ provider: 'cli-a', model: 'model-q', exitCode: 0, closeReason: 'exit-ok', turns: 8, sessionOutcome: 'success', endedAtSource: 'sealed' });
    expect(detail(snapshotWith(closed), 'en')).toMatch(/worker cli-a\/model-q \| started \d\d:\d\d:\d\dZ \| finished \d\d:\d\d:\d\dZ \(1 min 0 s\) \| 8 turns \| closed: exited normally \| session: completed/);
    expect(detail(snapshotWith(closed), 'tr')).toMatch(/worker: cli-a\/model-q \| başladı \d\d:\d\d:\d\dZ \| bitti \d\d:\d\d:\d\dZ \(1 dk 0 sn\) \| 8 tur \| kapanış: normal çıkış \| oturum: tamamlandı/);
    expect(detail(snapshotWith(run({ closeReason: 'exit-error', exitCode: 2 })), 'en')).toContain('closed: exited with code 2');
    expect(detail(snapshotWith(run({ closeReason: 'cancelled' })), 'en')).toContain('closed: cancelled');
  });
  it('negative: no proven times means no narrative, and an unproven end or missing turns is never invented', () => {
    const none = detail(snapshotWith(run({ startedAtMs: null, endedAtMs: null })), 'en');
    expect(none).not.toContain('worker claude/'); expect(none).not.toMatch(/\bturns\b/);
    const open = detail(snapshotWith(run({ endedAtMs: null })), 'en');
    expect(open).toContain('end not proven'); expect(open).not.toContain('turns'); expect(open).not.toContain('closed:');
  });
});

describe('M3 failed tests on a failed verification Run', () => {
  const failed = fullSnapshot.installs[0]!.runs.find(run => run.state === 'failed')!;
  const withTests = (failedTests: NonNullable<NonNullable<MonitorRun['tasks'][number]['lastAttempt']>['failedTests']>): MonitorRun => ({ ...failed,
    tasks: failed.tasks.map(task => task.phase === 'failed' ? { ...task, lastAttempt: { ...task.lastAttempt!, failedTests } } : task) });
  it('shows the true count and only the first names, in the detail and the summary (EN + TR)', () => {
    const run = withTests({ count: 22, names: ['tests/a.test.ts > one', 'tests/b.test.ts > two'], truncated: true });
    const en = detail(snapshotWith(run), 'en'), tr = detail(snapshotWith(run), 'tr');
    expect(en).toContain('failed tests: 22 (showing 2)'); expect(en).toContain('x tests/a.test.ts > one'); expect(en).toContain('… 20 more not listed');
    expect(tr).toContain('başarısız test: 22 (2 tanesi gösteriliyor)'); expect(tr).toContain('… 20 test daha listelenmedi');
    expect(summaryText(snapshotWith(run), 'en')).toContain('22 failed tests, first: tests/a.test.ts > one');
    expect(summaryText(snapshotWith(run), 'tr')).toContain('22 test başarısız, ilki: tests/a.test.ts > one');
    expect(en).not.toContain('tests/c.test.ts');
  });
  it('a partial recorded output says the list may be incomplete; no failed tests means no such lines', () => {
    expect(detail(snapshotWith(withTests({ count: 1, names: ['t > x'], truncated: true })), 'en')).toContain('the recorded output is partial');
    expect(detail(snapshotWith(failed), 'en')).not.toContain('failed tests:');
  });
});

describe('M2 blocker detail for exited work without a patch', () => {
  it('words patch-missing in EN and TR instead of the raw code', () => {
    const waiting: MonitorRun = { ...base, runId: 'run-w', state: 'waiting', delivery: null, blocker: { code: 'worker-exited-unevaluated', taskId: 'build', sinceMs: OBSERVED_AT - 3 * MIN, detail: 'patch-missing' } };
    expect(detail(snapshotWith(waiting), 'en')).toContain('worker exited, not evaluated (no patch prepared yet)');
    expect(detail(snapshotWith(waiting), 'tr')).toContain('yama henüz hazırlanmadı'); expect(detail(snapshotWith(waiting), 'en')).not.toContain('patch-missing');
  });
});
