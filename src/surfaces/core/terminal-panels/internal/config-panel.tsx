import { useCallback, useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, pickerView, PICKER_INITIAL, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { EntryWindow } from './entry.js';
import type { ConfigPanelField, ConfigPanelLabels, ConfigPanelLayer, ConfigPanelPort, ConfigPanelView, PanelLabels, PanelNotice } from './contract.js';

/** Value-level row ids that are not schema choices (a schema choice id never starts with `:`). */
const FREE = ':entry', UNSET = ':unset';
const LAYERS: readonly ConfigPanelLayer[] = ['project', 'global'];

/** A key row's facts: its value, the layer it comes from and whether it applies live or on restart. */
const rowFacts = (field: ConfigPanelField) => [field.value, field.source, field.apply].join(' · ');
const sectionOf = (key: string, general: string) => key.includes('.') ? key.slice(0, key.indexOf('.')) : general;

/** The panel's levels: sections → keys (value, source, apply; locked with the policy's reason when no layer may be written) → values. */
export function configPanelTree(view: ConfigPanelView, labels: ConfigPanelLabels, focusedKey: string | null): PickerTree {
  const sections = new Map<string, PickerNode[]>();
  for (const field of view.fields) {
    const section = sectionOf(field.key, labels.general), list = sections.get(section) ?? [];
    const blocked = LAYERS.every(layer => field.locks[layer].blocked) ? field.locks.project.blocked : null;
    const values: PickerNode[] = [...field.choices.map(choice => ({ id: choice.id, label: choice.label === field.value ? `${choice.label} · ${labels.current}` : choice.label })),
      ...(field.free ? [{ id: FREE, label: labels.freeEntry }] : []), ...(field.unsettable ? [{ id: UNSET, label: labels.unset }] : [])];
    list.push({ id: field.key, label: section === labels.general ? field.key : field.key.slice(section.length + 1),
      detail: rowFacts(field), keywords: [field.key, field.description],
      ...(blocked ? { blocked: { reason: blocked } } : {}), childTitle: field.key, children: values });
    sections.set(section, list);
  }
  const field = focusedKey ? view.fields.find(item => item.key === focusedKey) : undefined;
  return { title: view.title, items: [...sections.entries()].map(([id, children]) => ({ id, label: id, detail: String(children.length), children })),
    scopes: LAYERS.map(layer => ({ id: layer, label: field?.locks[layer].note ? `${labels.scopes[layer]} · ${field.locks[layer].note}` : labels.scopes[layer],
      ...(field?.locks[layer].blocked ? { blocked: { reason: field.locks[layer].blocked } } : {}) })) };
}

/** The focused key's own words: its description, value/source/apply, what it takes, and each layer's note. */
function focusLines(field: ConfigPanelField | undefined, labels: ConfigPanelLabels): WindowLine[] {
  if (!field) return [];
  return [{ spans: [span(field.description)] }, { spans: [span(rowFacts(field), { role: 'muted' })] },
    { spans: [span(fillTemplate(labels.expected, { expected: field.expected }), { role: 'muted' })] }];
}

type Step = Readonly<{ kind: 'pick' } | { kind: 'entry'; field: ConfigPanelField; layer: ConfigPanelLayer }>;

/**
 * `/config` as a window: sections → key → value, then the layer (project or user) with each layer's policy lock. Choosing writes through the
 * L2 port only; a write the policy sends to approval writes nothing and opens the approval window. Finished lines go to scrollback.
 */
export function ConfigPanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ConfigPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval: (approvalId: string) => void; readonly onError: (error: unknown) => void;
  readonly onClose: () => void }) {
  const words = labels.config;
  const [view, setView] = useState<ConfigPanelView | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [generation, setGeneration] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const reload = useCallback(async () => { setView(await port.inspect()); }, [port]);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => { reload().catch(error => { exits.current.onError(error); exits.current.onClose(); }); }, [reload]);
  if (!view) return <Window title={[span(labels.loading)]} hints={words.hints} position={labels.position} onClose={onClose} />;
  const focusedKey = state.trail.length >= 2 ? state.trail[1]!.id : null;
  const tree = configPanelTree(view, words, focusedKey);
  const shown = pickerView(tree, state), row = shown.rows[shown.pos];
  const field = view.fields.find(item => item.key === (state.trail.length >= 2 ? focusedKey : state.trail.length === 1 ? row?.id : null));
  // Back where the person was: the key list of the section, on the key just written.
  const backToKeys = (at: PickerState): PickerState => ({ ...PICKER_INITIAL, trail: at.trail.slice(0, 1), pos: at.trail[1]?.pos ?? 0 });
  const write = async (request: Parameters<ConfigPanelPort['write']>[0], at: PickerState) => {
    try {
      const outcome = await port.write(request);
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: outcome.lines.join('\n') }]);
      if (outcome.status === 'approval-pending' && outcome.approvalId) { onClose(); openApproval(outcome.approvalId); return; }
      await reload();
    } catch (error) { onError(error); }
    setState(backToKeys(at)); setGeneration(value => value + 1); setStep({ kind: 'pick' });
  };
  const chosen = (result: PickerResult, at: PickerState) => {
    if (result.kind !== 'selected') { onClose(); return; }
    const [, key, value] = result.path, target = view.fields.find(item => item.key === key), layer = LAYERS.find(item => item === result.scope) ?? 'project';
    if (!target) { onClose(); return; }
    if (value === FREE) { setStep({ kind: 'entry', field: target, layer }); return; }
    if (value === UNSET) { void write({ action: 'unset', keyPath: target.key, layer }, at); return; }
    const choice = target.choices.find(item => item.id === value);
    if (choice) void write({ action: 'set', keyPath: target.key, value: choice.value, layer }, at);
  };
  if (step.kind === 'entry') {
    const at = state;
    return <EntryWindow title={fillTemplate(words.entryTitle, { key: step.field.key, expected: step.field.expected })} body={focusLines(step.field, words)}
      hints={fillTemplate(words.entryHint, { expected: step.field.expected })} position={labels.position} masked={step.field.sensitive}
      onCancel={() => { setState(backToKeys(at)); setGeneration(value => value + 1); setStep({ kind: 'pick' }); }}
      onSubmit={text => {
        const parsed = port.parse(step.field.key, text);
        if (!parsed.ok) return parsed.reason;
        void write({ action: 'set', keyPath: step.field.key, value: parsed.value, layer: step.layer }, at);
        return null;
      }} />;
  }
  return <Window title={[span(view.title)]} body={[...focusLines(field, words), ...(state.trail.length ? [] : view.notes.map(note => ({ spans: [span(note, { role: 'warning' })] })))]}
    hints={words.hints} position={labels.position} footerRows={12} onInput={() => true}
    footer={focusedWindow => <ListPicker key={generation} tree={tree} labels={labels.picker} active={focusedWindow} initial={state} onState={setState}
      onResult={result => chosen(result, state)} />} />;
}
