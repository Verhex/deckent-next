import { useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, PICKER_INITIAL, pickerView, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { usePickerRoom } from './lines.js';
import { BudgetWindow, budgetEntry } from './budget-panel.js';
import { CacheWindow, cacheEntry } from './cache-panel.js';
import type { BudgetPanelView, CachePanelView, ModelPanelChoice, ModelPanelLabels, ModelPanelPort, ModelPanelReference, ModelPanelView, PanelLabels, PanelNotice } from './contract.js';

const SESSION = 'session', DEFAULT = 'default', BUDGET = ':budget', CACHE = ':cache', FRESH = 'fresh', KEEP = 'keep';
const keyOf = (reference: ModelPanelReference) => `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
const same = (left: ModelPanelReference | null, right: ModelPanelReference) => left !== null && keyOf(left) === keyOf(right);

/**
 * `/model` as a list (T4 MODEL-SWITCH): the connected providers' catalog models, grouped by provider when there is more than one, each with what
 * it is and its state; a model that cannot be used now is listed with its reason and is never pickable. Choosing a model asks its scope: this
 * session (pinned for the next turn), or this session and the user default (the governed `/config` writer; locked with its reason when not offered).
 */
export function modelPanelTree(view: ModelPanelView, pinned: ModelPanelReference | null, labels: ModelPanelLabels, title: string, defaultOffered: boolean): PickerTree {
  const node = (choice: ModelPanelChoice): PickerNode => {
    const marks = [...(same(pinned, choice.reference) ? [labels.pinnedMark] : []), ...(choice.configured ? [labels.configuredMark] : [])];
    return { id: keyOf(choice.reference), label: marks.length ? `${choice.label} · ${marks.join(' · ')}` : choice.label, detail: choice.detail,
      keywords: [choice.reference.modelId, choice.reference.providerId, choice.group], ...(choice.blocked ? { blocked: { reason: choice.blocked } } : {}) };
  };
  const groups = [...new Set(view.choices.map(choice => choice.group))];
  const items: PickerNode[] = groups.length > 1
    ? groups.map(group => { const children = view.choices.filter(choice => choice.group === group).map(node);
      return { id: `group:${group}`, label: group, detail: String(children.length), childTitle: group, children }; })
    : view.choices.map(node);
  return { title, items, scopes: [{ id: SESSION, label: labels.session },
    { id: DEFAULT, label: labels.sessionAndDefault, ...(defaultOffered && view.defaultBlocked === null ? {} : { blocked: { reason: view.defaultBlocked ?? labels.sessionAndDefault } }) }] };
}

export function ModelPanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ModelPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval: (approvalId: string) => void; readonly onError: (error: unknown) => void;
  readonly onClose: () => void }) {
  const words = labels.model;
  const [view, setView] = useState<ModelPanelView | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [shadow, setShadow] = useState<Readonly<{ choice: ModelPanelChoice; projectModel: string; first: readonly string[] }> | null>(null);
  // Stage 1: the scope budget row (create / change) and its window; a budget read failure only hides the row.
  const [budget, setBudget] = useState<BudgetPanelView | null>(null), [budgetOpen, setBudgetOpen] = useState(false);
  // CACHE-SLICE1: the cache migration row (existing profiles without a cache choice) and the model-switch question over a large context.
  const [cache, setCache] = useState<CachePanelView | null>(null), [cacheOpen, setCacheOpen] = useState(false);
  const [switching, setSwitching] = useState<Readonly<{ choice: ModelPanelChoice; result: PickerResult; tokens: number }> | null>(null);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  // Body: the focused model's exact reference and, for a locked one, the command that fixes it (both dimmed).
  const room = usePickerRoom(2);
  useEffect(() => {
    let live = true;
    port.inspect().then(value => { if (live) setView(value); }, error => { if (live) { exits.current.onError(error); exits.current.onClose(); } });
    port.budget?.inspect().then(value => { if (live) setBudget(value); }, () => undefined);
    port.cache?.inspect().then(value => { if (live) setCache(value); }, () => undefined);
    return () => { live = false; };
  }, [port]);
  if (!view) return <Window title={[span(labels.loading)]} hints={words.hints} position={labels.position} onClose={onClose} />;
  if (budgetOpen && budget && port.budget) return <BudgetWindow port={port.budget} view={budget} labels={labels} push={push} onDone={onClose} />;
  if (cacheOpen && cache && port.cache) return <CacheWindow port={port.cache} view={cache} labels={labels} push={push} openApproval={openApproval} onError={onError} onDone={onClose} />;
  const entry = budgetEntry(budget, labels.budget), cacheRow = cacheEntry(cache, labels.cache), listed = modelPanelTree(view, port.pinned(), words, view.title, Boolean(port.makeDefault));
  const tree: PickerTree = { ...listed, items: [...(entry ? [{ id: BUDGET, label: entry.label, detail: entry.detail, unscoped: true }] : []),
    ...(cacheRow ? [{ id: CACHE, label: cacheRow.label, detail: cacheRow.detail, unscoped: true }] : []), ...listed.items] };
  const chosen = (result: PickerResult, fresh?: boolean) => {
    if (result.kind === 'selected' && result.id === BUDGET) { setBudgetOpen(true); return; }
    if (result.kind === 'selected' && result.id === CACHE) { setCacheOpen(true); return; }
    const choice = result.kind === 'selected' ? view.choices.find(item => keyOf(item.reference) === result.id && item.blocked === null) : undefined;
    if (!choice) { onClose(); return; }
    // A switch to another model over a large context never resets or carries it silently: the person answers "new context / continue" first.
    const current = port.pinned() ?? view.choices.find(item => item.configured)?.reference ?? null, tokens = port.largeContext?.() ?? null;
    if (fresh === undefined && tokens !== null && !same(current, choice.reference)) { setSwitching({ choice, result, tokens }); return; }
    // The session pin first: the next turn carries it whatever the default write answers (the service uses it exactly or refuses).
    port.pin(choice, fresh === true);
    push([{ level: 'info', text: fillTemplate(words.pinned, { model: choice.label }) },
      ...(fresh === undefined ? [] : [{ level: 'info' as const, text: fillTemplate(fresh ? words.switch.freshDone : words.switch.keepDone, { model: choice.label }) }])]);
    if (result.kind !== 'selected' || result.scope !== DEFAULT || !port.makeDefault) { onClose(); return; }
    port.makeDefault(choice).then(outcome => {
      // A project model that keeps winning: the same window asks how to resolve it (two governed writes, or keep it) before the one summary line.
      if (outcome.status === 'applied' && outcome.shadow && port.resolveShadow) { setShadow({ choice, projectModel: outcome.shadow.projectModel, first: outcome.lines }); return; }
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: outcome.lines.join('\n') }]);
      onClose();
      if (outcome.status === 'approval-pending' && outcome.approvalId) openApproval(outcome.approvalId);
    }, error => { onError(error); onClose(); });
  };
  if (switching) {
    const ask: PickerTree = { title: fillTemplate(words.switch.title, { model: switching.choice.label, tokens: switching.tokens }),
      items: [{ id: FRESH, label: words.switch.fresh }, { id: KEEP, label: words.switch.keep }] };
    const answer = (result: PickerResult) => {
      // Esc: no switch at all (nothing pinned, the context untouched).
      if (result.kind !== 'selected') { setSwitching(null); return; }
      setSwitching(null); chosen(switching.result, result.id === FRESH);
    };
    return <Window title={[span(ask.title, { bold: true })]} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
      footer={focused => <ListPicker key="switch" tree={ask} labels={labels.picker} active={focused} maxRows={room.rows} onResult={answer} />} />;
  }
  if (shadow) {
    const tree: PickerTree = { title: fillTemplate(words.shadowTitle, { model: shadow.projectModel }), items: [{ id: 'remove', label: words.shadowRemove },
      { id: 'align', label: words.shadowAlign }, { id: 'keep', label: words.shadowKeep }] };
    const answer = (result: PickerResult) => {
      const action = result.kind === 'selected' ? result.id : 'keep';
      if (action !== 'remove' && action !== 'align') { push([{ level: 'info', text: shadow.first.join('\n') }]); onClose(); return; }
      port.resolveShadow!(shadow.choice, action).then(outcome => {
        push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: outcome.lines.join('\n') }]);
        onClose();
        if (outcome.status === 'approval-pending' && outcome.approvalId) openApproval(outcome.approvalId);
      }, error => { onError(error); onClose(); });
    };
    return <Window title={[span(tree.title, { bold: true })]} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
      footer={focused => <ListPicker key="shadow" tree={tree} labels={labels.picker} active={focused} maxRows={room.rows} onResult={answer} />} />;
  }
  const shown = pickerView(tree, state), focused = shown.stage === 'list' ? view.choices.find(item => keyOf(item.reference) === shown.rows[shown.pos]?.id) : undefined;
  const body = [...view.notes.map(note => ({ spans: [span(note, { role: 'warning' as const })] })),
    ...(focused ? [{ spans: [span(focused.exact, { role: 'muted' as const })] }, ...(focused.command ? [{ spans: [span(focused.command, { role: 'muted' as const })] }] : [])] : [])];
  return <Window title={[span(view.title, { bold: true })]} body={body} hints={words.hints} position={labels.position}
    footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker tree={tree} labels={labels.picker} active={focused} initial={state} onState={setState} maxRows={room.rows} onResult={result => chosen(result)} />} />;
}
