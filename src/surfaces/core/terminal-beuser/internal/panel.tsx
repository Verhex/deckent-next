import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '#platform/index.js';
import type { BeuserLimits, BeuserReport } from '#engine/index.js';
import { Window, QuestionWindow } from '#surfaces/core/terminal-window/index.js';
import { span, useHumanTextSecrets } from '#surfaces/core/terminal-render-ink/index.js';
import { panelWindowLines, PickerWindow, type ConfigPanelOutcome, type PanelLabels, type PanelNotice, type PanelLine } from '#surfaces/core/terminal-panels/index.js';

type Model = { readonly channelId: string; readonly modelId: string };
const MS_PER_SECOND = 1000;
export interface BeuserMonitorView {
  readonly reason?: string | null; readonly runId: string; readonly journey: string; readonly state: string; readonly elapsedMs: number | null;
  readonly walkers: readonly { readonly id: string; readonly walker: Model; readonly judge: Model; readonly phase: string; readonly limits: BeuserLimits | null }[];
  readonly report: BeuserReport | null;
}
export type BeuserLimitKey = 'maxWallMs' | 'maxReruns' | 'maxSteps' | 'maxCost';
interface BeuserLimitConfig {
  readonly root: string; readonly expect: string | null; readonly values: Readonly<Record<BeuserLimitKey, number>>;
  readonly currency: string; readonly source: 'code' | 'config'; readonly revision: string; readonly presets: readonly { readonly key: BeuserLimitKey; readonly value: number }[];
}
interface BeuserPanelSource {
  inspect(): Promise<BeuserMonitorView | null>;
  limitConfig?(): Promise<BeuserLimitConfig | null>;
  writeLimit?(key: BeuserLimitKey, value: number, expect: string | null): Promise<ConfigPanelOutcome>;
}
export function beuserMonitorLines(view: BeuserMonitorView | null, locale: Locale): PanelLine[] {
  if (!view) return [{ label: '', text: t('beuser.monitor.empty', {}, locale) }];
  const report = view.report, name = (model: Model) => `${model.channelId} / ${model.modelId}`;
  const rows: PanelLine[] = [{ label: t('beuser.monitor.status', {}, locale), text: `${view.state} · ${view.journey} · ${view.runId}` },
    { label: t('beuser.monitor.progress', {}, locale), text: report ? `${report.counts.walked}/${report.counts.selected}` : t('beuser.monitor.pending', {}, locale) },
    { label: t('beuser.monitor.elapsed', {}, locale), text: view.elapsedMs === null ? '?' : `${Math.floor(view.elapsedMs / MS_PER_SECOND)} s` },
    { label: '', text: t('beuser.monitor.observation', {}, locale), tone: 'muted' }];
  if (view.reason) rows.push({ label: t('beuser.monitor.status', {}, locale), text: view.reason, tone: 'warning' });
  for (const walker of view.walkers) {
    rows.push({ label: t('beuser.monitor.walker', {}, locale), text: `${walker.id}: ${name(walker.walker)} · ${walker.phase}` },
      { label: t('beuser.monitor.judge', {}, locale), text: `${name(walker.judge)} · ${report?.segments.find(segment => segment.segment === walker.id)?.verdict?.outcome ?? 'unknown'}` });
    const limit = walker.limits;
    if (limit) rows.push({ label: t('beuser.monitor.limits', {}, locale), text: t('beuser.monitor.limitValues', { time: limit.maxWallMs, retries: limit.maxReruns,
      steps: limit.maxSteps, cost: limit.maxCost, currency: limit.currency, source: `${limit.source} / ${limit.revision}` }, locale) });
  }
  for (const reason of [...(report?.unknown ?? []), ...(report?.unwalked ?? []), ...(report?.findings ?? []).map(row => ({ branch: row.branch, reason: row.reason }))]) {
    rows.push({ label: reason.branch, text: reason.reason, tone: 'warning' });
  }
  return rows;
}
type Actions = { readonly labels: PanelLabels; readonly push: (notices: readonly PanelNotice[]) => void;
  readonly openApproval: (approvalId: string) => void; readonly onError: (error: unknown) => void; readonly onClose: () => void };
type Selection = { readonly key: BeuserLimitKey; readonly value: number };
/** Snapshot projection; Esc closes only this window. Limit changes leave it for presets, preview and an armed person card. */
function BeuserPanel({ source, locale, labels, push, openApproval, onError, onClose }: Actions & { readonly source: BeuserPanelSource; readonly locale: Locale }) {
  const known = useHumanTextSecrets(), exits = useRef({ onError, onClose }); exits.current = { onError, onClose };
  const [lines, setLines] = useState<PanelLine[]>([{ label: '', text: labels.loading }]);
  const [settings, setSettings] = useState<BeuserLimitConfig | null>(null), busy = useRef(false);
  const [step, setStep] = useState<'monitor' | 'preset' | 'preview' | 'card'>('monitor'), [selected, setSelected] = useState<Selection | null>(null);
  const [generation, refresh] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.all([source.inspect(), source.limitConfig?.() ?? null]).then(([view, config]) => {
      if (current) { setLines(beuserMonitorLines(view, locale)); setSettings(config); }
    }, error => { if (current) { exits.current.onError(error); exits.current.onClose(); } });
    return () => { current = false; };
  }, [source, locale, generation]);
  const title = t('beuser.monitor.title', {}, locale), back = () => setStep('monitor');
  const valueText = (choice: Selection) => `${choice.key}: ${settings?.values[choice.key]} → ${choice.value}`;
  const commit = async () => {
    if (busy.current || !selected || !settings || !source.writeLimit) return;
    busy.current = true;
    try {
      const result = await source.writeLimit(selected.key, selected.value, settings.expect);
      const resultLines = result.status === 'approval-pending' ? [...result.lines.slice(0, 1), t('beuser.limits.pending', {}, locale)] : result.lines;
      push(resultLines.map(text => ({ level: result.status === 'applied' ? 'info' as const : 'warning' as const, text })));
      if (result.status === 'approval-pending' && result.approvalId) { onClose(); openApproval(result.approvalId); }
      else { refresh(value => value + 1); back(); }
    } catch (error) { onError(error); back(); } finally { busy.current = false; }
  };
  if (step === 'card' && selected) return <QuestionWindow title={`${t('beuser.limits.card', {}, locale)} · ${valueText(selected)}`} kind="single"
    options={[{ id: 'apply', label: t('beuser.setup.apply', {}, locale), role: 'yes' }, { id: 'cancel', label: t('beuser.setup.cancel', {}, locale), role: 'no' }]}
    hints={t('beuser.limits.cardHints', {}, locale)} position={labels.position} onAnswer={ids => { if (ids?.[0] === 'apply') void commit(); else back(); }} />;
  if (step === 'preview' && selected && settings) return <Window key="preview" title={[span(t('beuser.limits.preview', {}, locale))]}
    body={panelWindowLines([{ label: settings.root, text: valueText(selected) }, { label: '', text: t('beuser.limits.nextOnly', {}, locale) }], known)}
    hints={t('beuser.limits.previewHints', {}, locale)} position={labels.position} onClose={back}
    onInput={(_input, key) => { if (key.return) { setStep('card'); return true; } return false; }} />;
  if (step === 'preset' && settings) return <PickerWindow title={[span(t('beuser.limits.presets', {}, locale))]} bodyRows={2}
    body={panelWindowLines([{ label: '', text: t('beuser.limits.nextOnly', {}, locale) }], known)} position={labels.position} labels={labels.picker}
    tree={{ title, items: settings.presets.map((choice, index) => ({ id: String(index), label: valueText(choice) })) }} onClose={back}
    onResult={result => { const choice = result.kind === 'selected' ? settings.presets[Number(result.id)] : undefined;
      if (choice) { setSelected(choice); setStep('preview'); } else back(); }} />;
  const next = settings ? [{ label: t('beuser.limits.next', {}, locale), text: t('beuser.monitor.limitValues', { time: settings.values.maxWallMs,
    retries: settings.values.maxReruns, steps: settings.values.maxSteps, cost: settings.values.maxCost, currency: settings.currency,
    source: `${settings.source === 'config' ? t('beuser.limits.source.config', {}, locale) : t('beuser.limits.source.code', {}, locale)} / ${settings.revision}` }, locale) }] : [];
  return <Window key="monitor" title={[span(title)]} body={panelWindowLines([...next, ...lines], known)} hints={settings && source.writeLimit ? t('beuser.monitor.editHints', {}, locale) : t('beuser.monitor.hints', {}, locale)}
    position={labels.position} onClose={onClose} onInput={(input, key) => {
      if (key.ctrl || key.meta) return false;
      if (input === 'r') { refresh(value => value + 1); return true; }
      if (input === 'l' && settings && source.writeLimit) { setStep('preset'); return true; }
      return false;
    }} />;
}
export function beuserPanelPort(source: BeuserPanelSource, locale: Locale) {
  return { render: (actions: Actions) => <BeuserPanel {...actions} source={source} locale={locale} /> };
}
