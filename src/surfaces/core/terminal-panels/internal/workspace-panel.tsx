import { useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { QuestionWindow } from './lines.js';
import { PickerWindow } from './picker-window.js';
import type { PanelLabels, PanelNotice, WorkspacePanelPort } from './contract.js';

/** The note row and its wrap on a narrow terminal: the body rows the window keeps. */
const BODY_ROWS = 2;

/** The workspace is a discovered list choice, confirmed before the governed profile write. */
export function WorkspaceWindow({ port, profiles, labels, push, openApproval, onError, onDone }: {
  port: WorkspacePanelPort; profiles: readonly Readonly<{ id: string; label: string; detail: string }>[]; labels: PanelLabels;
  push: (notices: readonly PanelNotice[]) => void; openApproval: (id: string) => void; onError: (error: unknown) => void; onDone: () => void;
}) {
  const words = labels.workspace!;
  const [profile, setProfile] = useState<string | null>(null), [choices, setChoices] = useState<readonly Readonly<{ id: string; name: string }>[] | null>(null);
  const [selected, setSelected] = useState<Readonly<{ id: string; name: string }> | null>(null), [busy, setBusy] = useState(false);
  const fail = (error: unknown) => { onError(error); onDone(); };
  if (busy) return <PickerWindow title={[span(words.title)]} body={[{ spans: [span(labels.loading)] }]} bodyRows={BODY_ROWS} tree={null} labels={labels.picker} listHints={labels.cache.hints}
    position={labels.position} onResult={() => undefined} />;
  if (profile && selected) return <QuestionWindow title={words.title} lines={[{ label: '', text: fillTemplate(words.confirm, { name: selected.name, id: selected.id }) }]}
    hints={words.hints} position={labels.position} onAnswer={answer => {
      if (!answer) { onDone(); return; }
      setBusy(true); port.apply(profile, selected.id).then(result => {
        push([{ level: result.status === 'applied' ? 'info' : 'warning', text: result.lines.join('\n') }]); onDone();
        if (result.status === 'approval-pending' && result.approvalId) openApproval(result.approvalId);
      }, fail);
    }} />;
  const items = choices ? choices.map(row => ({ id: row.id, label: row.name, detail: row.id })) : profiles;
  return <PickerWindow title={[span(words.title)]} body={[{ spans: [span(items.length ? words.note : words.empty)] }]} bodyRows={BODY_ROWS} tree={{ title: words.title, items }}
    labels={labels.picker} listHints={labels.cache.hints} position={labels.position} pickerKey={choices ? 'workspaces' : 'profiles'}
      onResult={result => {
        if (result.kind !== 'selected') { onDone(); return; }
        if (choices) { setSelected(choices.find(row => row.id === result.id) ?? null); return; }
        setBusy(true); setProfile(result.id);
        port.list(result.id).then(rows => { setChoices(rows); setBusy(false); }, fail);
      }} />;
}
