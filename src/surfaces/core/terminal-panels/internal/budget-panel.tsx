import { useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, type PickerResult, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { ConfigNumberWindow } from './config-stepper.js';
import { usePickerRoom } from './lines.js';
import type { BudgetPanelLabels, BudgetPanelPort, BudgetPanelView, PanelLabels, PanelNotice } from './contract.js';

const OTHER = ':other', CONFIRM = 'confirm', UNFREEZE = 'unfreeze';
/** The list row that opens the budget window (stage 1), or null when the window offers no action here. */
export function budgetEntry(view: BudgetPanelView | null, words: BudgetPanelLabels): Readonly<{ label: string; detail: string }> | null {
  if (!view?.action) return null;
  return view.action === 'create' ? { label: words.create, detail: view.note ?? '' } : { label: words.change, detail: fillTemplate(words.changeDetail, { current: view.current ?? '-' }) };
}
/** The amount list: the presets, then the bounded arrow-key step (no free entry anywhere). */
export function budgetAmountTree(view: BudgetPanelView, words: BudgetPanelLabels): PickerTree {
  return { title: view.action === 'change' ? fillTemplate(words.changeDetail, { current: view.current ?? '-' }) : words.create,
    items: [...view.presets.map(usd => ({ id: `usd:${usd}`, label: fillTemplate(words.preset, { usd }) })), { id: OTHER, label: words.other }] };
}
/** The confirm list: send (and, for a frozen account, send and lift the freeze), or cancel. */
export function budgetConfirmTree(view: BudgetPanelView, usd: number, words: BudgetPanelLabels): PickerTree {
  return { title: fillTemplate(words.confirmTitle, { usd }), items: [{ id: CONFIRM, label: words.confirm },
    ...(view.action === 'change' && view.frozen ? [{ id: UNFREEZE, label: words.confirmUnfreeze }] : []), { id: 'cancel', label: words.cancel }] };
}

/**
 * Stage 1 budget window (owner 2026-10-08): amount from presets or the bounded stepper, a confirm step, then the governed spend command through
 * the port; the outcome is one system line and the window closes. Nothing is typed and nothing is sent before the confirm answer.
 */
export function BudgetWindow({ port, view, labels, push, onDone }: { readonly port: BudgetPanelPort; readonly view: BudgetPanelView; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly onDone: () => void }) {
  const words = labels.budget, room = usePickerRoom(1);
  const [step, setStep] = useState<Readonly<{ kind: 'amount' } | { kind: 'stepper' } | { kind: 'confirm'; usd: number } | { kind: 'busy' }>>({ kind: 'amount' });
  const action = view.action;
  if (!action) return null;
  const title = [span(action === 'create' ? words.create : words.change, { bold: true })];
  if (step.kind === 'busy') return <Window title={title} body={[{ spans: [span(labels.loading)] }]} hints={words.hints} position={labels.position} />;
  if (step.kind === 'stepper') {
    return <ConfigNumberWindow title={words.stepperTitle} hints={words.hints} position={labels.position} stepper={{ min: view.min, max: view.max, step: view.step, unit: 'count', current: view.start }}
      onCancel={() => setStep({ kind: 'amount' })} onSubmit={usd => setStep({ kind: 'confirm', usd })} />;
  }
  const answer = (result: PickerResult) => {
    if (step.kind === 'amount') {
      if (result.kind !== 'selected') { onDone(); return; }
      setStep(result.id === OTHER ? { kind: 'stepper' } : { kind: 'confirm', usd: Number(result.id.slice('usd:'.length)) });
      return;
    }
    if (result.kind !== 'selected' || (result.id !== CONFIRM && result.id !== UNFREEZE) || step.kind !== 'confirm') { setStep({ kind: 'amount' }); return; }
    const usd = step.usd;
    setStep({ kind: 'busy' });
    port.apply({ action, usd, unfreeze: result.id === UNFREEZE }).then(outcome => { push([{ level: outcome.ok ? 'info' : 'warning', text: outcome.line }]); onDone(); },
      error => { push([{ level: 'error', text: String((error as { message?: unknown })?.message ?? error) }]); onDone(); });
  };
  const tree = step.kind === 'amount' ? budgetAmountTree(view, words) : budgetConfirmTree(view, step.usd, words);
  const warning = step.kind === 'confirm' && view.settledUsd !== undefined && step.usd <= view.settledUsd && words.belowSettled
    ? [{ spans: [span(`! ${fillTemplate(words.belowSettled, { usd: step.usd, settled: view.settledUsd })}`, { role: 'warning' })] }] : [];
  return <Window title={title} body={[...(view.current ? [{ spans: [span(fillTemplate(words.changeDetail, { current: view.current }), { role: 'muted' })] }] : []), ...warning]} hints={words.hints}
    position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker key={step.kind} tree={tree} labels={labels.picker} active={focused} maxRows={room.rows} onResult={answer} />} />;
}
