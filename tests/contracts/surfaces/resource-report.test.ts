import { expect, it } from 'vitest';
import { summarizeWorkCosts } from '#domain/index.js';
import { renderCostReport, loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { main } from '#surfaces/index.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';
import { unavailableResourceView } from '#engine/index.js';
it.each(['en', 'tr'] as const)('renders unknown axes and partial evidence in a localized, cursor-free report (%s)', locale => {
  const report = summarizeWorkCosts({ scopeId: 's', runId: 'r', runRevision: 1, observedAtMs: 100, withheld: 0, attempts: [] });
  const text = renderCostReport(report, locale);
  expect(text).toContain(locale === 'tr' ? 'Maliyet kısmi' : 'Cost is partial');
  expect(text).toContain(locale === 'tr' ? 'bilinmiyor' : 'unknown'); expect(text).not.toContain('\u001b');
});
it('dispatches the report command through the same Run inspection result and returns stable JSON', async () => {
  const costReport = summarizeWorkCosts({ scopeId: 's', runId: 'r', runRevision: 1, observedAtMs: 100, withheld: 1, attempts: [] });
  let text = '', called = 0;
  const code = await main(['report', '--scope', 's', '--run', 'r', '--json'], { stdout: { write(value: string) { text += value; return true; } },
    async inspectRun(_root, query) { called++; expect(query).toEqual({ schemaVersion: 1, scopeId: 's', runId: 'r' }); return { schemaVersion: 1, run: { costReport } } as never; } });
  expect(code).toBe(0); expect(called).toBe(1); expect(JSON.parse(text)).toEqual(costReport);
});
it('keeps fresh/unknown resource values in narrow monitor detail without changing acceptance', async () => {
  const surface = await loadMonitorSurface(), source = fullSnapshot.installs[0]!;
  const worker = { ...source.workers[0]!, resources: { ...unavailableResourceView(), state: 'gap' as const, reason: 'unsupported' as const } };
  const snapshot = { ...fullSnapshot, installs: [{ ...source, workers: [worker] }] };
  const view = surface.buildMonitorView(snapshot, 'tr', true), block = view.tabs.workers[0]!;
  if (block.kind !== 'table') throw new Error('table');
  expect(block.rows[0]!.detail().flat().map(span => span.text).join('\n')).toContain('Bu ortamda desteklenmiyor');
  expect(snapshot.installs[0]!.runs).toEqual(source.runs);
});
