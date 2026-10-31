import { useEffect, useState } from 'react';
import { t, type Locale } from '#platform/index.js';
import type { BeuserLimits, BeuserReport } from '#engine/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { span, useHumanTextSecrets } from '#surfaces/core/terminal-render/index.js';
import { panelWindowLines, type PanelLabels, type PanelNotice, type PanelLine } from '#surfaces/core/terminal-panels/index.js';

type Model = { readonly channelId: string; readonly modelId: string };
const MS_PER_SECOND = 1000;
export interface BeuserMonitorView {
  readonly runId: string; readonly journey: string; readonly state: string; readonly elapsedMs: number | null;
  readonly walkers: readonly { readonly id: string; readonly walker: Model; readonly judge: Model; readonly phase: string; readonly limits: BeuserLimits | null }[];
  readonly report: BeuserReport | null;
}
export interface BeuserPanelSource { inspect(): Promise<BeuserMonitorView | null> }
export function beuserMonitorLines(view: BeuserMonitorView | null, locale: Locale): PanelLine[] {
  if (!view) return [{ label: '', text: t('beuser.monitor.empty', {}, locale) }];
  const report = view.report, name = (model: Model) => `${model.channelId} / ${model.modelId}`;
  const rows: PanelLine[] = [{ label: t('beuser.monitor.status', {}, locale), text: `${view.state} · ${view.journey} · ${view.runId}` },
    { label: t('beuser.monitor.progress', {}, locale), text: report ? `${report.counts.walked}/${report.counts.selected}` : t('beuser.monitor.pending', {}, locale) },
    { label: t('beuser.monitor.elapsed', {}, locale), text: view.elapsedMs === null ? '?' : `${Math.floor(view.elapsedMs / MS_PER_SECOND)} s` },
    { label: '', text: t('beuser.monitor.observation', {}, locale), tone: 'muted' }];
  for (const walker of view.walkers) {
    rows.push({ label: t('beuser.monitor.walker', {}, locale), text: `${walker.id}: ${name(walker.walker)} · ${walker.phase}` },
      { label: t('beuser.monitor.judge', {}, locale), text: `${name(walker.judge)} · ${report?.segments.find(segment => segment.segment === walker.id)?.verdict?.outcome ?? 'unknown'}` });
    const limit = walker.limits;
    if (limit) rows.push({ label: t('beuser.monitor.limits', {}, locale), text: t('beuser.monitor.limitValues', { time: limit.maxWallMs, retries: limit.maxReruns,
      steps: limit.maxSteps, cost: limit.maxCost, currency: limit.currency, source: limit.revision }, locale) });
  }
  for (const reason of [...(report?.unknown ?? []), ...(report?.unwalked ?? []), ...(report?.findings ?? []).map(row => ({ branch: row.branch, reason: row.reason }))]) {
    rows.push({ label: reason.branch, text: reason.reason, tone: 'warning' });
  }
  return rows;
}
type Actions = { readonly labels: PanelLabels; readonly push: (notices: readonly PanelNotice[]) => void; readonly onError: (error: unknown) => void; readonly onClose: () => void };
/** Snapshot projection; `r` re-reads authority, Esc closes only this window. No field edits or write port. */
export function BeuserPanel({ source, locale, labels, onError, onClose }: Actions & { readonly source: BeuserPanelSource; readonly locale: Locale }) {
  const known = useHumanTextSecrets();
  const [lines, setLines] = useState<PanelLine[]>([{ label: '', text: labels.loading }]);
  const [generation, refresh] = useState(0);
  useEffect(() => {
    let current = true;
    void source.inspect().then(view => { if (current) setLines(beuserMonitorLines(view, locale)); }, error => { if (current) onError(error); });
    return () => { current = false; };
  }, [source, locale, generation, onError]);
  return <Window title={[span(t('beuser.monitor.title', {}, locale))]} body={panelWindowLines(lines, known)} hints={t('beuser.monitor.hints', {}, locale)}
    position={labels.position} onClose={onClose} onInput={(input, key) => { if (input === 'r' && !key.ctrl && !key.meta) { refresh(value => value + 1); return true; } return false; }} />;
}
export function beuserPanelPort(source: BeuserPanelSource, locale: Locale) {
  return { render: (actions: Actions) => <BeuserPanel {...actions} source={source} locale={locale} /> };
}
