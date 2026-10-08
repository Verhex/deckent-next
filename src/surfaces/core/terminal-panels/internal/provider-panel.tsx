import { useCallback, useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, PICKER_INITIAL, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { EntryWindow } from './entry.js';
import { LinesWindow, QuestionWindow, panelWindowLines, usePickerRoom } from './lines.js';
import { BudgetWindow, budgetEntry } from './budget-panel.js';
import type { BudgetPanelView, PanelLabels, PanelNotice, ProviderConnectOutcome, ProviderModelOutcome, ProviderPanelKind, ProviderPanelLabels, ProviderPanelPort, ProviderPanelView } from './contract.js';

/** `/provider` as a list (T4 PROVIDER-CONNECT): each kind with its state and stored key name; connect (or replace the key) and disconnect. */
export function providerPanelTree(view: ProviderPanelView, labels: ProviderPanelLabels, models = false): PickerTree {
  return { title: view.title, items: view.kinds.map((kind): PickerNode => ({ id: kind.id, label: kind.label, detail: kind.pendingNote ? `${kind.pendingNote} · ${kind.detail}` : kind.detail, keywords: [kind.id, ...(kind.keyName ? [kind.keyName] : [])],
    ...(kind.blocked ? { blocked: { reason: kind.blocked } } : kind.legacy ? { childTitle: kind.label, children: [{ id: 'disconnect', label: labels.actions.disconnect }] }
      : { childTitle: kind.label, children: [{ id: 'connect', label: kind.keyStored ? labels.actions.replace : labels.actions.connect },
      // T4-B: connect one of the kind's models (governed models.connect), offered where the host binds it and the kind lists models.
      ...(models && kind.models.length ? [{ id: 'model', label: labels.actions.model, ...(kind.modelBlocked ? { blocked: { reason: kind.modelBlocked } } : {}) }] : []),
      ...(kind.keyStored ? [{ id: 'disconnect', label: labels.actions.disconnect }] : [])] }) })) };
}
/** T4-B: the kind's models as a list (labels first; the exact id is the dimmed detail). */
export function providerModelTree(kind: ProviderPanelKind, labels: ProviderPanelLabels): PickerTree {
  return { title: fillTemplate(labels.modelTitle, { kind: kind.label }), items: kind.models.map(model => ({ id: model.id, label: model.label, detail: model.detail, keywords: [model.detail],
    ...(model.blocked ? { blocked: { reason: model.blocked } } : {}) })) };
}

const OTHER = ':other';
/** The address list of a kind (owner 2026-10-08, D3): the known addresses, then "a new address…" as the last row (the narrow typed exception). */
export function providerEndpointTree(kind: ProviderPanelKind, labels: ProviderPanelLabels): PickerTree {
  return { title: `${kind.label} · ${labels.endpointTitle}`, items: [...kind.endpointChoices.map(choice => ({ id: choice.id, label: choice.label, detail: choice.url })),
    { id: OTHER, label: labels.endpointOther }] };
}

/** `forModel` (T4-B): the address is chosen for a model connection, not for storing a key. */
type Step = Readonly<{ kind: 'list' } | { kind: 'endpoint'; target: ProviderPanelKind; forModel?: true } | { kind: 'address'; target: ProviderPanelKind; text: string; problem: string | null; forModel?: true }
  | { kind: 'preview'; target: ProviderPanelKind; text: string; base: string; check: string; forModel?: true } | { kind: 'key'; target: ProviderPanelKind; endpoint: string | null }
  | { kind: 'busy' } | { kind: 'result'; outcome: ProviderConnectOutcome } | { kind: 'confirm'; target: ProviderPanelKind }
  | { kind: 'model'; target: ProviderPanelKind; endpoint: string | null } | { kind: 'connected'; outcome: ProviderModelOutcome } | { kind: 'budget' }>;
const BUDGET = ':budget';

/**
 * `/provider` as a window: connect a kind (its address chosen from a list when it takes one — a typed address only as the list's last row,
 * checked and previewed — then the key, masked, with how it is kept, then the free check and its typed result; only a passing check stores the
 * key, through the runtime service), or disconnect it (the stored key is removed). Results stay in the window (owner 2026-10-08: slash output
 * only in a window); the key lives only in the entry and the one connect call: it is never drawn, pushed to scrollback or kept here.
 */
export function ProviderPanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ProviderPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval?: (approvalId: string) => void; readonly onError: (error: unknown) => void;
  readonly onClose: () => void }) {
  const words = labels.provider;
  const [view, setView] = useState<ProviderPanelView | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [generation, setGeneration] = useState(0);
  const room = usePickerRoom(1);
  // Stage 1: the scope budget row (create / change) above the kinds; a budget read failure only hides the row.
  const [budget, setBudget] = useState<BudgetPanelView | null>(null);
  const reload = useCallback(async () => { setView(await port.inspect()); setBudget(port.budget ? await port.budget.inspect().catch(() => null) : null); }, [port]);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => { reload().catch(error => { exits.current.onError(error); exits.current.onClose(); }); }, [reload]);
  const back = () => { setGeneration(value => value + 1); setStep({ kind: 'list' }); reload().catch(error => onError(error)); };
  const title = (text: string) => [span(text, { bold: true })];
  if (!view || step.kind === 'busy') return <Window title={title(words.title)} body={[{ spans: [span(view ? words.checking : labels.loading)] }]} hints={words.hints} position={labels.position} />;
  if (step.kind === 'budget' && budget && port.budget) return <BudgetWindow port={port.budget} view={budget} labels={labels} push={push} onDone={back} />;
  if (step.kind === 'result') return <LinesWindow title={step.outcome.title} lines={step.outcome.lines} hints={words.resultHints} position={labels.position} onClose={back} />;
  // T4-B: a model connection's result; closing it leaves its one system summary line (and opens the approval card policy asked for).
  if (step.kind === 'connected') return <LinesWindow title={step.outcome.title} lines={step.outcome.lines} hints={words.resultHints} position={labels.position} onClose={() => {
    push([{ level: step.outcome.connected ? 'info' : 'warning', text: step.outcome.summary }]);
    if (step.outcome.approvalId && openApproval) { openApproval(step.outcome.approvalId); onClose(); return; }
    back();
  }} />;
  if (step.kind === 'model') {
    const { target, endpoint } = step, connectModel = port.connectModel;
    return <Window title={title(fillTemplate(words.modelTitle, { kind: target.label }))} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
      body={target.models.length ? [] : [{ spans: [span(words.modelEmpty, { role: 'muted' })] }]}
      footer={focused => <ListPicker tree={providerModelTree(target, words)} labels={labels.picker} active={focused} maxRows={room.rows} onResult={result => {
        if (result.kind !== 'selected' || !connectModel) { back(); return; }
        setStep({ kind: 'busy' });
        connectModel({ kind: target.id, endpoint, model: result.id }).then(outcome => setStep({ kind: 'connected', outcome }), error => { onError(error); back(); });
      }} />} />;
  }
  if (step.kind === 'confirm') return <QuestionWindow title={fillTemplate(words.disconnectTitle, { kind: step.target.label })} lines={[]} hints={words.disconnectKeys} position={labels.position}
    onAnswer={answer => {
      if (!answer) { back(); return; }
      setStep({ kind: 'busy' });
      // The answer stays in the window too (no scrollback line).
      port.disconnect(step.target.id).then(lines => setStep({ kind: 'result', outcome: { stored: false, title: step.target.label, lines: lines.map(text => ({ label: '', text })) } }),
        error => { onError(error); back(); });
    }} />;
  if (step.kind === 'endpoint') {
    const target = step.target;
    return <Window title={title(`${target.label} · ${words.endpointTitle}`)} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
      footer={focused => <ListPicker tree={providerEndpointTree(target, words)} labels={labels.picker} active={focused} maxRows={room.rows} onResult={result => {
        if (result.kind !== 'selected') { back(); return; }
        const choice = target.endpointChoices.find(item => item.id === result.id);
        setStep(choice ? (step.forModel ? { kind: 'model', target, endpoint: choice.url } : { kind: 'key', target, endpoint: choice.url })
          : { kind: 'address', target, text: '', problem: null, ...(step.forModel ? { forModel: true } : {}) });
      }} />} />;
  }
  // Each entry step is its own window instance (key): an accepted entry stays deaf, and the key step never inherits the address's text.
  if (step.kind === 'address') return <EntryWindow key="address" title={`${step.target.label} · ${words.endpointOther}`} hints={words.endpointHint} position={labels.position}
    initial={step.text} problem={step.problem} onCancel={() => setStep({ kind: 'endpoint', target: step.target, ...(step.forModel ? { forModel: true } : {}) })}
    onSubmit={text => {
      const checked = port.endpoint(step.target.id, text);
      if (!checked.ok) return checked.reason;
      setStep({ kind: 'preview', target: step.target, text: text.trim(), base: checked.base, check: checked.check, ...(step.forModel ? { forModel: true } : {}) });
      return null;
    }} />;
  if (step.kind === 'preview') return <QuestionWindow title={words.previewTitle} hints={words.previewKeys} position={labels.position}
    lines={[{ label: words.previewAddress, text: step.base }, ...(step.forModel ? [] : [{ label: words.previewCheck, text: `GET ${step.check}`, tone: 'muted' as const }]),
      // T4-B (Jev da5312fb): the key name this address gets is shown before anything is saved.
      ...((name => name ? [{ label: words.keyName, text: name }] : [])(port.keyName?.(step.target.id, step.base) ?? null))]}
    onAnswer={answer => setStep(answer ? (step.forModel ? { kind: 'model', target: step.target, endpoint: step.base } : { kind: 'key', target: step.target, endpoint: step.base })
      : { kind: 'address', target: step.target, text: step.text, problem: null, ...(step.forModel ? { forModel: true } : {}) })} />;
  if (step.kind === 'key') {
    const { target, endpoint } = step;
    const keyName = port.keyName?.(target.id, endpoint) ?? null;
    return <EntryWindow key="key" title={fillTemplate(words.keyTitle, { kind: target.label })} body={panelWindowLines([...(keyName ? [{ label: words.keyName, text: keyName }] : []),
      ...port.transparency])} masked
      hints={target.keyRequired ? words.keyHint : words.keyOptionalHint} position={labels.position} onCancel={back}
      onSubmit={text => {
        if (target.keyRequired && !text) return words.keyRequired;
        setStep({ kind: 'busy' });
        port.connect({ kind: target.id, endpoint, key: text === '' ? null : text }).then(outcome => setStep({ kind: 'result', outcome }), error => { onError(error); back(); });
        return null;
      }} />;
  }
  const chosen = (result: PickerResult, at: PickerState) => {
    if (result.kind !== 'selected') { onClose(); return; }
    if (result.id === BUDGET) { setState(at); setStep({ kind: 'budget' }); return; }
    const [id, action] = result.path, target = view.kinds.find(kind => kind.id === id);
    if (!target || !action) { setState(at); back(); return; }
    setState({ ...PICKER_INITIAL, pos: at.trail[0]?.pos ?? 0 });
    if (action === 'disconnect') { setStep({ kind: 'confirm', target }); return; }
    if (action === 'model') { setStep(target.endpointEditable ? { kind: 'endpoint', target, forModel: true } : { kind: 'model', target, endpoint: null }); return; }
    setStep(target.endpointEditable ? { kind: 'endpoint', target } : { kind: 'key', target, endpoint: null });
  };
  const body = [...(view.kinds.length ? [] : [{ spans: [span(words.empty, { role: 'muted' as const })] }]),
    ...view.notes.map(note => ({ spans: [span(note, { role: 'warning' as const })] })),
    // K6: a key-only kind says so in the window body too (a narrow terminal may cut the row's detail).
    ...view.kinds.filter(kind => kind.pendingNote).map(kind => ({ spans: [span(`${kind.label}: `, { bold: true }), span(kind.pendingNote!, { role: 'muted' as const })] }))];
  return <Window title={title(view.title)} body={body} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker key={generation} tree={withBudgetRow(providerPanelTree(view, words, Boolean(port.connectModel)), budgetEntry(budget, labels.budget))} labels={labels.picker} active={focused} initial={state} onState={setState}
      maxRows={room.rows} onResult={result => chosen(result, state)} />} />;
}
/** Stage 1: the budget row first, when the window offers a budget action. */
function withBudgetRow(tree: PickerTree, entry: ReturnType<typeof budgetEntry>): PickerTree {
  return entry ? { ...tree, items: [{ id: BUDGET, label: entry.label, detail: entry.detail }, ...tree.items] } : tree;
}
