import { useEffect, useRef, useState } from 'react';
import type { ConfigRecordDraft, ConfigRecordField, ConfigRecordPort, ConfigRecordPreview, ConfigRecordView, ConfigFileChoice } from '#surfaces/core/config/index.js';
import { CONFIG_IMPORT_KEYS } from '#surfaces/core/config/index.js';
import { ListPicker, type PickerNode, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { ConfigNumberWindow } from './config-stepper.js';
import { usePickerRoom } from './lines.js';
import type { ConfigPanelLayer, ConfigPanelOutcome, PanelLabels } from './contract.js';

type Step = { kind: 'members' } | { kind: 'form'; member: string | null; draft: ConfigRecordDraft }
  | { kind: 'choices' | 'number'; member: string | null; draft: ConfigRecordDraft; field: ConfigRecordField }
  | { kind: 'files'; entries: readonly ConfigFileChoice[]; form: Extract<Step, { kind: 'form' }> | null }
  | { kind: 'preview'; preview: ConfigRecordPreview };
/** Only selection and bounded stepping. The port validates a complete proposal before the confirmation window can open. */
export function ConfigRecordWindow({ port, keyPath, title, layer, labels, onResult, onError, onClose }: {
  readonly port: ConfigRecordPort; readonly keyPath: string; readonly title: string; readonly layer: ConfigPanelLayer; readonly labels: PanelLabels;
  readonly onResult: (outcome: ConfigPanelOutcome) => void; readonly onError: (error: unknown) => void; readonly onClose: () => void;
}) {
  const [view, setView] = useState<ConfigRecordView | null>(null), [step, setStep] = useState<Step>({ kind: 'members' }), [generation, setGeneration] = useState(0);
  const busy = useRef(false), room = usePickerRoom(1), words = labels.config.records;
  const callbacks = useRef({ onError, onClose }); callbacks.current = { onError, onClose };
  useEffect(() => { let live = true;
    port.open(keyPath, layer).then(value => { if (live) setView(value); }).catch(error => { if (live) { callbacks.current.onError(error); callbacks.current.onClose(); } });
    return () => { live = false; };
  }, [port, keyPath, layer]);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return; busy.current = true;
    try { await action(); } catch (error) { onError(error); } finally { busy.current = false; setGeneration(value => value + 1); }
  };
  const form = (member: string | null) => void run(async () => { const draft = await port.draft(member); setStep({ kind: 'form', member, draft }); });
  const preview = (member: string | null, values: Readonly<Record<string, unknown>> | null) => void run(async () => { setStep({ kind: 'preview', preview: await port.preview(member, values) }); });
  const browse = (directory?: string, from: Extract<Step, { kind: 'form' }> | null = null) => void run(async () => { setStep({ kind: 'files', entries: await port.browse(directory), form: from }); });
  const choose = (at: Extract<Step, { kind: 'choices' | 'number' }>, value: unknown) => {
    void run(async () => { const draft = await port.draft(at.member, { ...at.draft.values, [at.field.id]: value }); setStep({ kind: 'form', member: at.member, draft }); });
  };
  if (step.kind === 'number' && step.field.stepper) return <ConfigNumberWindow title={step.field.label} stepper={{ ...step.field.stepper,
    current: typeof step.draft.values[step.field.id] === 'number' ? step.draft.values[step.field.id] as number : step.field.stepper.current }}
    hints={labels.config.stepperHint} position={labels.position} onSubmit={value => choose(step, value)} onCancel={() => setStep({ kind: 'form', member: step.member, draft: step.draft })} />;
  if (step.kind === 'preview') return <Window title={[span(labels.config.preview, { bold: true })]} status={[span(labels.config.scopes[layer], { role: 'muted' })]}
    body={[{ spans: [span(title, { bold: true })] }, ...(view?.note ? [{ spans: [span(view.note, { role: 'warning' })] }] : []), { label: [span(`− ${words.before}`, { bold: true, role: 'warning' })], spans: [span(step.preview.before, { role: 'muted' })], exact: true },
      { label: [span(`+ ${words.after}`, { bold: true, role: 'success' })], spans: [span(step.preview.after)], exact: true }]}
    hints={labels.config.previewHint} position={labels.position} onClose={() => { setStep({ kind: 'members' }); setGeneration(n => n + 1); }}
    onInput={(input, key) => { if (key.return) { void run(async () => onResult(await port.commit(step.preview.token))); return true; }
      if (key.escape || key.ctrl && input === 'c') { setStep({ kind: 'members' }); setGeneration(n => n + 1); return true; } return undefined; }} />;
  let items: PickerNode[] = [], selected: (path: readonly string[]) => void = () => undefined;
  if (view && step.kind === 'members') {
    if ((CONFIG_IMPORT_KEYS as readonly string[]).includes(keyPath)) {
      items = [{ id: ':import', label: words.import }]; selected = () => browse();
    } else {
      items = [{ id: ':add', label: words.add }, ...view.members.map(member => ({ id: member.id, label: member.label, detail: member.detail,
        children: [{ id: ':edit', label: words.edit }, { id: ':remove', label: words.remove }] }))];
      selected = path => { if (path[0] === ':add') form(null); else if (path[1] === ':remove') preview(path[0]!, null); else form(path[0]!); };
    }
  } else if (step.kind === 'form') {
    items = [...step.draft.fields.map(field => ({ id: field.id, label: field.label, detail: String(step.draft.values[field.id] ?? words.empty) })),
      { id: ':save', label: words.save, ...(step.draft.fields.some(field => step.draft.values[field.id] === undefined) ? { blocked: { reason: words.empty } } : {}) }];
    selected = path => { if (path[0] === ':save') preview(step.member, step.draft.values);
      else { const field = step.draft.fields.find(item => item.id === path[0]); if (field) setStep({ kind: 'choices', member: step.member, draft: step.draft, field }); } };
  } else if (step.kind === 'choices') {
    items = [...step.field.choices.map(choice => ({ id: choice.id, label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}) })),
      ...(step.field.stepper ? [{ id: ':number', label: labels.config.stepper }] : []), ...(step.field.id === 'path' ? [{ id: ':browse', label: words.browse }] : [])];
    selected = path => { if (path[0] === ':number') setStep({ ...step, kind: 'number' });
      else if (path[0] === ':browse') browse(undefined, { kind: 'form', member: step.member, draft: step.draft });
      else { const choice = step.field.choices.find(item => item.id === path[0]); if (choice) choose(step, choice.value); } };
  } else if (step.kind === 'files') {
    items = step.entries.flatMap((entry, i) => entry.kind === 'directory' ? [
      ...(step.form && i === 0 ? [{ id: ':select', label: words.select, detail: entry.path }] : []), { id: String(i), label: entry.label, detail: words.browse }]
      : step.form && !step.form.draft.fields.some(field => field.id === 'path' && field.fileSystem === 'any') ? [] : [{ id: String(i), label: entry.label, detail: words.import }]);
    selected = path => {
      if (path[0] === ':select' && step.form) { const from = step.form; void run(async () => { setStep({ ...from, draft: await port.draft(from.member, { ...from.draft.values, path: step.entries[0]!.path }) }); }); return; }
      const entry = step.entries[Number(path[0])]; if (!entry) return;
      if (entry.kind === 'directory') browse(entry.path, step.form);
      else if (step.form) { const from = step.form; void run(async () => { setStep({ ...from, draft: await port.draft(from.member, { ...from.draft.values, path: entry.path }) }); }); }
      else void run(async () => { setStep({ kind: 'preview', preview: await port.importFile(entry.path) }); });
    };
  }
  const tree: PickerTree = { title, items };
  const close = () => { if (step.kind === 'members') onClose(); else { setStep({ kind: 'members' }); setGeneration(n => n + 1); } };
  return <Window title={[span(view ? title : labels.loading, { bold: true })]} status={[span(labels.config.scopes[layer], { role: 'muted' })]}
    body={[{ spans: [span(view?.note ?? keyPath, { role: view?.note ? 'warning' : 'muted' })] }]} hints={labels.config.hints} position={labels.position} onClose={close} onInput={() => true}
    footerRows={room.footerRows} footer={focused => <ListPicker key={`${step.kind}-${generation}`} tree={tree} labels={labels.picker} active={focused && !busy.current}
      maxRows={room.rows} onResult={result => { if (result.kind === 'selected') { selected(result.path); setGeneration(n => n + 1); } else close(); }} />} />;
}
