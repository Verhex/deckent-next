import { expect, it } from 'vitest';
import { renderWorkerModelLine } from '#surfaces/core/monitor/index.js';
import { readWorkerModelPin, viewWorkerModels } from '#domain/index.js';
const pin = { channelId: 'fixture', modelId: 'exact', auxiliaryModelIds: [] };
it.each(['en', 'tr'] as const)('projects the frozen effort and localized source in shared inspect/monitor detail (%s)', locale => {
  const pinned = readWorkerModelPin({ nativeSubscription: { provider: 'codex', model: pin,
    reasoningEffort: { schemaVersion: 1, level: 'xhigh', source: 'policy-default', status: 'selected', workClass: 'feature', policyRevision: 'r' } } });
  const view = viewWorkerModels({ ...pinned!, summary: null, evidence: 'none' });
  expect(view).toMatchObject({ reasoningEffort: { level: 'xhigh', source: 'policy-default' } });
  const text = renderWorkerModelLine(view, locale);
  expect(text).toContain('xhigh'); expect(text).toContain(locale === 'en' ? 'policy default' : 'politika varsayılanı');
});
it.each(['en', 'tr'] as const)('makes unsupported visible (%s)', locale => {
  const pinned = readWorkerModelPin({ nativeSubscription: { provider: 'cursor', model: pin,
    reasoningEffort: { schemaVersion: 1, level: null, source: 'cli-default', status: 'unsupported' } } });
  const view = viewWorkerModels({ ...pinned!, summary: null, evidence: 'none' });
  expect(renderWorkerModelLine(view, locale)).toContain(locale === 'en' ? 'unsupported' : 'desteklenmiyor');
});

it.each((['en', 'tr'] as const).flatMap(locale => [false, true].map(ultraBoundary => ({ locale, ultraBoundary }))))('monitor worker detail shows the same immutable selection ($locale, Ultra boundary=$ultraBoundary)', async ({ locale, ultraBoundary }) => {
  const { loadMonitorSurface } = await import('#surfaces/core/monitor/index.js');
  const { fullSnapshot } = await import('../../fixtures/monitor/snapshots.js');
  const surface = await loadMonitorSurface();
  const snapshot = structuredClone(fullSnapshot);
  const pinned = readWorkerModelPin({ nativeSubscription: { provider: 'codex', model: pin,
    reasoningEffort: ultraBoundary
      ? { schemaVersion: 1, level: null, source: 'cli-default', status: 'ultra-opt-in-required', workClass: 'architecture', policyRevision: 'r', target: 'max' }
      : { schemaVersion: 1, level: 'max', source: 'policy-default', status: 'selected', workClass: 'architecture', policyRevision: 'r' } } });
  snapshot.installs[0]!.workers[0]!.model = viewWorkerModels({ ...pinned!, summary: null, evidence: 'none' });
  const view = surface.buildMonitorView(snapshot, locale, true);
  const rows = view.tabs.workers.filter(block => block.kind === 'table').flatMap(block => block.rows);
  const detail = rows.flatMap(row => row.detail().flat().map(cell => cell.text)).join(' ');
  if (ultraBoundary) {
    expect(detail).toContain(locale === 'en' ? 'Ultra requires explicit effort or an Ultra registry target' : 'Ultra için açık efor isteği veya Ultra registry hedefi gerekir');
    expect(detail).toContain(locale === 'en' ? 'CLI default' : 'CLI varsayılanı');
  } else expect(detail).toContain(locale === 'en' ? 'Reasoning effort: max (policy default' : 'Muhakeme eforu: max (politika varsayılanı');
});
