import { useCallback, useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, PICKER_INITIAL, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { EntryWindow } from './entry.js';
import { LinesWindow, QuestionWindow, panelWindowLines, usePickerRoom } from './lines.js';
import type { PanelLabels, PanelLine, PanelNotice, ProviderConnectOutcome, ProviderPanelKind, ProviderPanelLabels, ProviderPanelPort, ProviderPanelView } from './contract.js';

/** `/provider` as a list (T4 PROVIDER-CONNECT): each kind with its state and stored key name; connect (or replace the key) and disconnect. */
export function providerPanelTree(view: ProviderPanelView, labels: ProviderPanelLabels): PickerTree {
  return { title: view.title, items: view.kinds.map((kind): PickerNode => ({ id: kind.id, label: kind.label, detail: kind.detail, keywords: [kind.id, ...(kind.keyName ? [kind.keyName] : [])],
    ...(kind.blocked ? { blocked: { reason: kind.blocked } } : { childTitle: kind.label, children: [{ id: 'connect', label: kind.keyStored ? labels.actions.replace : labels.actions.connect },
      ...(kind.keyStored ? [{ id: 'disconnect', label: labels.actions.disconnect }] : [])] }) })) };
}

type Step = Readonly<{ kind: 'list' } | { kind: 'endpoint'; target: ProviderPanelKind } | { kind: 'key'; target: ProviderPanelKind; endpoint: string | null }
  | { kind: 'busy' } | { kind: 'result'; outcome: ProviderConnectOutcome } | { kind: 'confirm'; target: ProviderPanelKind }>;

/**
 * `/provider` as a window: connect a kind (its endpoint when it takes one, then the key — masked, with how it is kept — then the free check and
 * its typed result; only a passing check stores the key, through the runtime service), or disconnect it (the stored key is removed). The key
 * lives only in the entry and the one connect call: it is never drawn, pushed to scrollback or kept by this window.
 */
export function ProviderPanel({ port, labels, push, onError, onClose }: { readonly port: ProviderPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly onError: (error: unknown) => void; readonly onClose: () => void }) {
  const words = labels.provider;
  const [view, setView] = useState<ProviderPanelView | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [generation, setGeneration] = useState(0);
  const room = usePickerRoom(1);
  const reload = useCallback(async () => { setView(await port.inspect()); }, [port]);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => { reload().catch(error => { exits.current.onError(error); exits.current.onClose(); }); }, [reload]);
  const back = () => { setGeneration(value => value + 1); setStep({ kind: 'list' }); reload().catch(error => onError(error)); };
  if (!view || step.kind === 'busy') return <Window title={[span(words.title)]} body={[{ spans: [span(view ? words.checking : labels.loading)] }]} hints={words.hints} position={labels.position} />;
  if (step.kind === 'result') return <LinesWindow title={step.outcome.title} lines={step.outcome.lines} hints={words.resultHints} position={labels.position} onClose={back} />;
  if (step.kind === 'confirm') return <QuestionWindow title={fillTemplate(words.disconnectTitle, { kind: step.target.label })} lines={[]} hints={words.disconnectKeys} position={labels.position}
    onAnswer={answer => {
      if (!answer) { back(); return; }
      setStep({ kind: 'busy' });
      port.disconnect(step.target.id).then(lines => { push([{ level: 'info', text: lines.join('\n') }]); back(); }, error => { onError(error); back(); });
    }} />;
  // Each entry step is its own window instance (key): an accepted entry stays deaf, and the key step never inherits the endpoint's text.
  if (step.kind === 'endpoint') return <EntryWindow key="endpoint" title={`${step.target.label} · ${words.endpointTitle}`} hints={words.endpointHint} position={labels.position}
    initial={step.target.endpointDefault ?? ''} onCancel={back}
    onSubmit={text => { const refused = port.endpoint(step.target.id, text); if (refused) return refused; setStep({ kind: 'key', target: step.target, endpoint: text.trim() }); return null; }} />;
  if (step.kind === 'key') {
    const { target, endpoint } = step;
    return <EntryWindow key="key" title={fillTemplate(words.keyTitle, { kind: target.label })} body={panelWindowLines(port.transparency)} masked
      hints={target.keyRequired ? words.keyHint : words.keyOptionalHint} position={labels.position} onCancel={back}
      onSubmit={text => {
        if (target.keyRequired && !text) return words.keyRequired;
        setStep({ kind: 'busy' });
        port.connect({ kind: target.id, endpoint, key: text === '' ? null : text }).then(outcome => {
          // Scrollback gets the result's words only (the same rows the window shows); the key was never in them.
          push([{ level: outcome.stored ? 'info' : 'warning', text: providerOutcomeText(outcome) }]);
          setStep({ kind: 'result', outcome });
        }, error => { onError(error); back(); });
        return null;
      }} />;
  }
  const chosen = (result: PickerResult, at: PickerState) => {
    if (result.kind !== 'selected') { onClose(); return; }
    const [id, action] = result.path, target = view.kinds.find(kind => kind.id === id);
    if (!target || !action) { setState(at); back(); return; }
    setState({ ...PICKER_INITIAL, pos: at.trail[0]?.pos ?? 0 });
    if (action === 'disconnect') { setStep({ kind: 'confirm', target }); return; }
    setStep(target.endpointEditable ? { kind: 'endpoint', target } : { kind: 'key', target, endpoint: null });
  };
  const body = [...(view.kinds.length ? [] : [{ spans: [span(words.empty, { role: 'muted' as const })] }]),
    ...view.notes.map(note => ({ spans: [span(note, { role: 'warning' as const })] }))];
  return <Window title={[span(view.title)]} body={body} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker key={generation} tree={providerPanelTree(view, words)} labels={labels.picker} active={focused} initial={state} onState={setState}
      maxRows={room.rows} onResult={result => chosen(result, state)} />} />;
}

/** The labelled rows of a result as plain text lines (scrollback form), for callers that print them elsewhere. */
export const providerOutcomeText = (outcome: ProviderConnectOutcome): string => [outcome.title, ...outcome.lines.map((line: PanelLine) => line.label ? `${line.label}: ${line.text}` : line.text)].join('\n');
