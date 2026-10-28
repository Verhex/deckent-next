import { useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { PICKER_INITIAL, pickerView, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { PickerWindow, useLoadingText } from './picker-window.js';
import { ProviderPanel } from './provider-panel.js';
import { BudgetWindow, budgetEntry } from './budget-panel.js';
import { WorkspaceWindow } from './workspace-panel.js';
import { CacheWindow, cacheEntry } from './cache-panel.js';
import type { BudgetPanelView, CachePanelView, ModelPanelChoice, ModelPanelLabels, ModelPanelPort, ModelPanelReference, ModelPanelView, PanelLabels, PanelNotice } from './contract.js';

const SESSION = 'session', DEFAULT = 'default', CONNECT = ':connect', BUDGET = ':budget', CACHE = ':cache', PROTOCOL = ':protocol', WORKSPACE = ':workspace', FRESH = 'fresh', FRESH_DEFAULT = 'fresh-default';
/** Body: the focused model's exact reference and, for a locked one, the command that fixes it (both dimmed). */
const BODY_ROWS = 2;
const keyOf = (reference: ModelPanelReference) => `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
const same = (left: ModelPanelReference | null, right: ModelPanelReference) => left !== null && keyOf(left) === keyOf(right);

/**
 * `/model` as a list (T4 MODEL-SWITCH): the connected providers' catalog models, grouped by provider when there is more than one, each with what
 * it is and its state; a model that cannot be used now is listed with its reason and is never pickable. Choosing a model asks its scope: this
 * session (pinned for the next turn), or this session and the user default (the governed `/config` writer; locked with its reason when not offered).
 */
export function modelPanelTree(view: ModelPanelView, pinned: ModelPanelReference | null, labels: ModelPanelLabels, title: string, defaultOffered: boolean, largeContext = false): PickerTree {
  const node = (choice: ModelPanelChoice): PickerNode => {
    const marks = [...(same(pinned, choice.reference) ? [labels.pinnedMark] : []), ...(choice.configured ? [labels.configuredMark] : [])];
    const provider = choice.providerLabel ?? choice.group, label = `${choice.label} (${provider})`;
    const fixes = (choice.fixes ?? []).map(fix => ({ id: `:fix:${fix.id}:${keyOf(choice.reference)}`, label: fix.label, unscoped: true }));
    return { ...(fixes.length ? { children: [...(choice.blocked ? [] : [{ id: keyOf(choice.reference), label }]), ...fixes] } : {}), id: keyOf(choice.reference), label: marks.length ? `${label} · ${marks.join(' · ')}` : label, identity: { model: choice.label, provider }, detail: choice.detail,
      keywords: [choice.reference.modelId, choice.reference.providerId, choice.group], ...(choice.blocked && !fixes.length ? { blocked: { reason: choice.blocked } } : {}) };
  };
  const groups = [...new Set(view.choices.map(choice => choice.group))];
  const items: PickerNode[] = groups.length > 1
    ? groups.map(group => { const children = view.choices.filter(choice => choice.group === group).map(node);
      return { id: `group:${group}`, label: group, detail: String(children.length), childTitle: group, children }; })
    : view.choices.map(node);
  const blocked = defaultOffered && view.defaultBlocked === null ? {} : { blocked: { reason: view.defaultBlocked ?? labels.sessionAndDefault } };
  return { title, items, scopes: [{ id: SESSION, label: largeContext ? `${labels.session} · ${labels.switch.keep}` : labels.session },
    { id: DEFAULT, label: largeContext ? `${labels.sessionAndDefault} · ${labels.switch.keep}` : labels.sessionAndDefault, ...blocked },
    ...(largeContext ? [{ id: FRESH, label: `${labels.session} · ${labels.switch.fresh}` }, { id: FRESH_DEFAULT, label: `${labels.sessionAndDefault} · ${labels.switch.fresh}`, ...blocked }] : [])] };
}

export function ModelPanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ModelPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval: (approvalId: string) => void; readonly onError: (error: unknown) => void;
  readonly onClose: () => void }) {
  const words = labels.model;
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<NonNullable<ModelPanelPort['workspace']>['inspect']>>>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [view, setView] = useState<ModelPanelView | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [shadow, setShadow] = useState<Readonly<{ choice: ModelPanelChoice; projectModel: string; first: readonly string[] }> | null>(null);
  // Stage 1: the scope budget row (create / change) and its window; a budget read failure only hides the row.
  const [providerOpen, setProviderOpen] = useState(false);
  const [fix, setFix] = useState<{ choice: ModelPanelChoice; action: 'activate' | 'deactivate' | 'reconcile' } | null>(null);
  const [budget, setBudget] = useState<BudgetPanelView | null>(null), [budgetOpen, setBudgetOpen] = useState(false);
  // CACHE-SLICE1: the cache migration row (existing profiles without a cache choice) and the model-switch question over a large context.
  const [cache, setCache] = useState<CachePanelView | null>(null), [cacheOpen, setCacheOpen] = useState(false);
  const [protocol, setProtocol] = useState<CachePanelView | null>(null), [protocolOpen, setProtocolOpen] = useState(false);
  const [preparing, setPreparing] = useState(false), preparingRef = useRef(false);
  const mounted = useRef(true);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => {
    mounted.current = true;
    let live = true;
    port.inspect().then(value => { if (live) setView(value); }, error => { if (live) { exits.current.onError(error); exits.current.onClose(); } });
    port.budget?.inspect().then(value => { if (live) setBudget(value); }, () => undefined);
    port.cache?.inspect().then(value => { if (live) setCache(value); }, () => undefined);
    port.workspace?.inspect().then(value => { if (live) setWorkspaces(value); }, () => undefined);
    port.protocol?.inspect().then(value => { if (live) setProtocol(value); }, () => undefined);
    return () => { live = false; mounted.current = false; };
  }, [port]);
  const loading = useLoadingText(labels, !view || preparing);
  if (!view) return <PickerWindow title={[span(loading)]} bodyRows={BODY_ROWS} tree={null} labels={labels.picker} listHints={words.hints} position={labels.position}
    onClose={onClose} onResult={onClose} />;
  if (providerOpen && port.provider) return <ProviderPanel port={port.provider} labels={labels} push={push} openApproval={openApproval} onError={onError} onClose={() => { setProviderOpen(false); void port.inspect().then(setView, onError); }} />;
  if (budgetOpen && budget && port.budget) return <BudgetWindow port={port.budget} view={budget} labels={labels} push={push} onDone={onClose} />;
  if (cacheOpen && cache && port.cache) return <CacheWindow port={port.cache} view={cache} labels={labels} push={push} openApproval={openApproval} onError={onError} onDone={onClose} />;
  if (workspaceOpen && port.workspace && labels.workspace) return <WorkspaceWindow port={port.workspace} profiles={workspaces} labels={labels} push={push} openApproval={openApproval} onError={onError} onDone={onClose} />;
  const tokens = port.largeContext?.() ?? null;
  if (protocolOpen && protocol && port.protocol && labels.protocol) return <CacheWindow port={port.protocol} view={protocol} words={labels.protocol} labels={labels}
    push={push} openApproval={openApproval} onError={onError} onDone={onClose} />;
  const entry = budgetEntry(budget, labels.budget), cacheRow = cacheEntry(cache, labels.cache), listed = modelPanelTree(view, port.pinned(), words, view.title, Boolean(port.makeDefault), tokens !== null);
  // BeUser alpha.56.1 (3t): with nothing to pick, the first row is the way to connect a model (the same `/provider` flow), like an empty state's action.
  const connect = !view.choices.length && port.provider && words.connect ? [{ id: CONNECT, label: words.connect, unscoped: true }] : [];
  const tree: PickerTree = { ...listed, items: [...connect, ...(entry ? [{ id: BUDGET, label: entry.label, detail: entry.detail, unscoped: true }] : []),
    ...(workspaces.length && labels.workspace ? [{ id: WORKSPACE, label: labels.workspace.entry, unscoped: true }] : []),
    ...(protocol && labels.protocol ? [{ id: PROTOCOL, label: labels.protocol.entry, detail: protocol.detail, unscoped: true }] : []),
    ...(cacheRow ? [{ id: CACHE, label: cacheRow.label, detail: cacheRow.detail, unscoped: true }] : []), ...listed.items] };
  const chosen = (result: PickerResult) => {
    if (result.kind === 'selected' && result.id === CONNECT) { setProviderOpen(true); return; }
    if (result.kind === 'selected' && result.id === BUDGET) { setBudgetOpen(true); return; }
    if (result.kind === 'selected' && result.id === CACHE) { setCacheOpen(true); return; }
    if (result.kind === 'selected' && result.id === WORKSPACE) { setWorkspaceOpen(true); return; }
    if (result.kind === 'selected' && result.id === PROTOCOL) { setProtocolOpen(true); return; }
    if (result.kind === 'selected' && result.id.startsWith(':fix:')) {
      const [, , action, ...parts] = result.id.split(':');
      const choice = view.choices.find(choice => keyOf(choice.reference) === parts.join(':'));
      if (action === 'provider') { setProviderOpen(true); return; }
      if (action === 'budget') { setBudgetOpen(true); return; }
      if (choice && port.fix && ['activate', 'deactivate', 'reconcile'].includes(action!)) setFix({ choice, action: action as 'activate' | 'deactivate' | 'reconcile' });
      return;
    }
    const choice = result.kind === 'selected' ? view.choices.find(item => keyOf(item.reference) === result.id && item.blocked === null) : undefined;
    if (!choice) { onClose(); return; }
    // Scope and context are one confirmation: a large history is continued or replaced only by the selected answer.
    const fresh = result.kind === 'selected' && (result.scope === FRESH || result.scope === FRESH_DEFAULT);
    if (preparingRef.current) return;
    preparingRef.current = true; setPreparing(true);
    // Recheck at confirmation; only a successful governed preparation can change the session pin.
    Promise.resolve().then(() => port.prepare?.(choice, port.reasoning?.())).then(async () => {
      if (!mounted.current) return;
      port.pin(choice, fresh === true);
      push([{ level: 'info', text: fillTemplate(words.pinned, { model: choice.label, provider: choice.providerLabel ?? choice.group }),
        identity: { model: choice.label, provider: choice.providerLabel ?? choice.group } },
        ...(tokens === null ? [] : [{ level: 'info' as const, text: fillTemplate(fresh ? words.switch.freshDone : words.switch.keepDone, { model: choice.label }) }])]);
      if (result.kind !== 'selected' || (result.scope !== DEFAULT && result.scope !== FRESH_DEFAULT) || !port.makeDefault) { onClose(); return; }
      const outcome = await port.makeDefault(choice);
      // A project model that keeps winning: the same window asks how to resolve it (two governed writes, or keep it) before the one summary line.
      if (outcome.status === 'applied' && outcome.shadow && port.resolveShadow) { setShadow({ choice, projectModel: outcome.shadow.projectModel, first: outcome.lines }); return; }
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: outcome.lines.join('\n') }]);
      onClose();
      if (outcome.status === 'approval-pending' && outcome.approvalId) openApproval(outcome.approvalId);
    }).catch(error => { if (mounted.current) { onError(error); onClose(); } }).finally(() => { preparingRef.current = false; if (mounted.current) setPreparing(false); });
  };
  if (fix) return <PickerWindow pickerKey={`fix:${keyOf(fix.choice.reference)}:${fix.action}`} title={[span(fix.choice.label)]} bodyRows={BODY_ROWS} labels={labels.picker} listHints={words.hints} position={labels.position}
    tree={{ title: fix.choice.label, items: [{ id: 'apply', label: view.fixApply ?? fix.choice.fixes?.find(row => row.id === fix.action)?.label ?? fix.action, unscoped: true },
      { id: 'keep', label: view.fixKeep ?? words.shadowKeep, unscoped: true }] }} body={[{ spans: [span(fix.choice.detail)] }, { spans: [span(fix.choice.exact)] }]}
    onResult={result => { if (result.kind !== 'selected' || result.id !== 'apply') { setFix(null); return; }
      setPreparing(true); const selected = fix; setFix(null);
      port.fix!(selected.choice, selected.action).then(() => port.inspect()).then(setView, onError).finally(() => setPreparing(false)); }} />;
  if (preparing) return <PickerWindow title={[span(loading)]} bodyRows={BODY_ROWS} tree={null} labels={labels.picker} listHints={words.hints} position={labels.position}
    onClose={() => { mounted.current = false; onClose(); }} onResult={() => undefined} />;
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
    return <PickerWindow title={[span(tree.title, { bold: true })]} bodyRows={BODY_ROWS} tree={tree} labels={labels.picker} listHints={words.hints} position={labels.position}
      pickerKey="shadow" onResult={answer} />;
  }
  const shown = pickerView(tree, state), focused = shown.stage === 'list' ? view.choices.find(item => keyOf(item.reference) === shown.rows[shown.pos]?.id) : undefined;
  const body = [...view.notes.map(note => ({ spans: [span(note, { role: 'warning' as const })] })),
    ...(tokens !== null && focused ? [{ spans: [span(fillTemplate(words.switch.title, { model: focused.label, tokens }), { role: 'warning' as const })] }] : []),
    ...(focused ? [{ spans: [span(focused.exact, { role: 'muted' as const })] }, ...(focused.command ? [{ spans: [span(focused.command, { role: 'muted' as const })] }] : [])] : [])];
  return <PickerWindow title={[span(view.title, { bold: true })]} body={body} bodyRows={BODY_ROWS} tree={tree} labels={labels.picker} position={labels.position}
    initial={state} onState={setState} onResult={result => chosen(result)} />;
}
