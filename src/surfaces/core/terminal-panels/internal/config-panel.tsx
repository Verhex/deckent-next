import { useCallback, useEffect, useRef, useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, pickerView, PICKER_INITIAL, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { configEntryAllowed } from '#platform/index.js';
import { ConfigRecordWindow } from './config-records.js';
import { ConfigNumberWindow } from './config-stepper.js';
import { EntryWindow } from './entry.js';
import { usePickerRoom } from './lines.js';
import type { ConfigPanelField, ConfigPanelLabels, ConfigPanelLayer, ConfigPanelPort, ConfigPanelView, PanelLabels, PanelNotice } from './contract.js';

/** Value-level row ids that are not schema choices (a schema choice id never starts with `:`). */
const RECORDS = ':records', FREE = ':entry', UNSET = ':unset', STEPPER = ':stepper', REGENERATE = ':regenerate';
const LAYERS: readonly ConfigPanelLayer[] = ['project', 'global'];
/** The focused key's rows: description, facts, what it takes. */
const FOCUS_ROWS = 4;

/** A key row's facts: its value, the layer it comes from and whether it applies live or on restart. */
const rowFacts = (field: ConfigPanelField) => [field.value, field.source, field.apply].join(' · ');
const sectionOf = (key: string, general: string) => key.includes('.') ? key.slice(0, key.indexOf('.')) : general;

/** The panel's levels: sections → keys (value, source, apply; locked with the policy's reason when no layer may be written) → values. */
export function configPanelTree(view: ConfigPanelView, labels: ConfigPanelLabels, focusedKey: string | null): PickerTree {
  const sections = new Map<string, PickerNode[]>();
  for (const field of view.fields) {
    const section = sectionOf(field.key, labels.general), list = sections.get(section) ?? [];
    const blocked = LAYERS.every(layer => field.locks[layer].blocked) ? field.locks.project.blocked : null;
    const values: PickerNode[] = [...(field.records ? [{ id: RECORDS, label: labels.records.edit }] : []),...field.choices.map(choice => ({ id: choice.id, label: choice.label === field.value ? `${choice.label} · ${labels.current}` : choice.label, ...(choice.detail ? { detail: choice.detail.length > 28 ? choice.detail.slice(0, 25) + '…' : choice.detail, keywords: [choice.detail] } : {}) })),
      ...(field.free && configEntryAllowed(field.key, field.sensitive) ? [{ id: FREE, label: labels.freeEntry }] : []),
      ...(field.stepper ? [{ id: STEPPER, label: labels.stepper }] : []), ...(field.generated ? [{ id: REGENERATE, label: labels.regenerate }] : []), ...(field.unsettable && !field.records ? [{ id: UNSET, label: labels.unset }] : [])];
    list.push({ id: field.key, label: section === labels.general ? field.key : field.key.slice(section.length + 1),
      detail: rowFacts(field), keywords: [field.key, field.description],
      ...(blocked || field.readOnly ? { blocked: { reason: blocked ?? field.readOnly! } } : {}), childTitle: field.key, children: values });
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
    { spans: [span(fillTemplate(labels.expected, { expected: field.expected }), { role: 'muted' })] },
    ...(field.choiceNotice ? [{ spans: [span(field.choiceNotice, { role: 'warning' })] }] : [])];
}

type Step = Readonly<{ kind: 'pick' } | { kind: 'entry' | 'number' | 'records'; field: ConfigPanelField; layer: ConfigPanelLayer } | { kind: 'preview'; field: ConfigPanelField; layer: ConfigPanelLayer; value: unknown }>;

/**
 * `/config` as a window: sections → key → value, then the layer (project or user) with each layer's policy lock. Choosing writes through the
 * L2 port only; a write the policy sends to approval writes nothing and opens the approval window. Finished lines go to scrollback.
 */
export function ConfigPanel({ port, labels, push, openApproval, onError, onClose }: { readonly port: ConfigPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval: (approvalId: string) => void; readonly onError: (error: unknown) => void;
  readonly onClose: () => void }) {
  const words = labels.config;
  const busy = useRef(false);
  const [view, setView] = useState<ConfigPanelView | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [generation, setGeneration] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const room = usePickerRoom(FOCUS_ROWS);
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
    if (busy.current) return;
    busy.current = true;
    try {
      const outcome = await port.write(request);
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: fillTemplate(words.summary, { text: outcome.lines[0] ?? view.title }) }]);
      if (outcome.status === 'approval-pending' && outcome.approvalId) { onClose(); openApproval(outcome.approvalId); return; }
      await reload();
    } catch (error) { onError(error); } finally { busy.current = false; }
    setState(backToKeys(at)); setGeneration(value => value + 1); setStep({ kind: 'pick' });
  };
  const chosen = (result: PickerResult, at: PickerState) => {
    if (result.kind !== 'selected') { onClose(); return; }
    const [, key, value] = result.path, target = view.fields.find(item => item.key === key), layer = LAYERS.find(item => item === result.scope) ?? 'project';
    if (!target) { onClose(); return; }
    if (value === RECORDS && port.records) { setStep({ kind: 'records', field: target, layer }); return; }
    if (value === REGENERATE) { void reload().catch(onError); return; }
    if (value === STEPPER && target.stepper) { setStep({ kind: 'number', field: target, layer }); return; }
    if (value === FREE && configEntryAllowed(target.key, target.sensitive)) { setStep({ kind: 'entry', field: target, layer }); return; }
    if (value === UNSET) { void write({ action: 'unset', keyPath: target.key, layer }, at); return; }
    const choice = target.choices.find(item => item.id === value);
    if (choice) void write({ action: 'set', keyPath: target.key, value: choice.value, layer }, at);
  };
  const cancelStep = () => { setState(backToKeys(state)); setGeneration(value => value + 1); setStep({ kind: 'pick' }); };
  if (step.kind === 'records' && port.records) return <ConfigRecordWindow port={port.records} keyPath={step.field.key} title={step.field.description} layer={step.layer} labels={labels}
    onClose={cancelStep} onError={onError} onResult={outcome => {
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: fillTemplate(words.summary, { text: outcome.lines[0] ?? view.title }) }]);
      if (outcome.status === 'approval-pending' && outcome.approvalId) { onClose(); openApproval(outcome.approvalId); return; }
      void reload().catch(onError); cancelStep();
    }} />;
  if (step.kind === 'number' && step.field.stepper) return <ConfigNumberWindow title={step.field.key} stepper={step.field.stepper} hints={words.stepperHint}
    position={labels.position} onCancel={cancelStep} onSubmit={value => { void write({ action: 'set', keyPath: step.field.key, value, layer: step.layer }, state); }} />;
  if (step.kind === 'preview') return <Window title={[span(words.preview, { bold: true })]} body={[...focusLines(step.field, words),
    { spans: [span(step.field.sensitive ? step.field.value : JSON.stringify(step.value), { bold: true })] }]} hints={words.previewHint} position={labels.position} onClose={cancelStep}
    onInput={(input, key) => { if (key.escape || key.ctrl && input === 'c') cancelStep(); else if (key.return) void write({ action: 'set', keyPath: step.field.key, value: step.value, layer: step.layer }, state); return true; }} />;
  if (step.kind === 'entry') {
    const at = state;
    return <EntryWindow title={fillTemplate(words.entryTitle, { key: step.field.key, expected: step.field.expected })} body={focusLines(step.field, words)}
      hints={fillTemplate(words.entryHint, { expected: step.field.expected })} position={labels.position} masked={step.field.sensitive}
      onCancel={() => { setState(backToKeys(at)); setGeneration(value => value + 1); setStep({ kind: 'pick' }); }}
      onSubmit={text => {
        const parsed = port.parse(step.field.key, text);
        if (!parsed.ok) return parsed.reason;
        setStep({ kind: 'preview', field: step.field, layer: step.layer, value: parsed.value });
        return null;
      }} />;
  }
  const body = [...focusLines(field, words), ...(state.trail.length ? [] : view.notes.map(note => ({ spans: [span(note, { role: 'warning' })] })))];
  return <Window title={[span(view.title)]} body={body}
    hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focusedWindow => <ListPicker key={generation} tree={tree} labels={labels.picker} active={focusedWindow} initial={state} onState={setState} maxRows={room.rows}
      onResult={result => chosen(result, state)} />} />;
}
