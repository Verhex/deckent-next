import { useState } from 'react';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { QuestionWindow, usePickerRoom } from './lines.js';
import type { PanelLabels, PanelNotice, WorkspacePanelPort } from './contract.js';

/** The workspace is a discovered list choice, confirmed before the governed profile write. */
export function WorkspaceWindow({ port, profiles, labels, push, openApproval, onError, onDone }: {
  port: WorkspacePanelPort; profiles: readonly Readonly<{ id: string; label: string; detail: string }>[]; labels: PanelLabels;
  push: (notices: readonly PanelNotice[]) => void; openApproval: (id: string) => void; onError: (error: unknown) => void; onDone: () => void;
}) {
  const words = labels.workspace!, room = usePickerRoom(2);
  const [profile, setProfile] = useState<string | null>(null), [choices, setChoices] = useState<readonly Readonly<{ id: string; name: string }>[] | null>(null);
  const [selected, setSelected] = useState<Readonly<{ id: string; name: string }> | null>(null), [busy, setBusy] = useState(false);
  const fail = (error: unknown) => { onError(error); onDone(); };
  if (busy) return <Window title={[span(words.title)]} body={[{ spans: [span(labels.loading)] }]} hints={labels.cache.hints} position={labels.position} />;
  if (profile && selected) return <QuestionWindow title={words.title} lines={[{ label: '', text: fillTemplate(words.confirm, { name: selected.name, id: selected.id }) }]}
    hints={words.hints} position={labels.position} onAnswer={answer => {
      if (!answer) { onDone(); return; }
      setBusy(true); port.apply(profile, selected.id).then(result => {
        push([{ level: result.status === 'applied' ? 'info' : 'warning', text: result.lines.join('\n') }]); onDone();
        if (result.status === 'approval-pending' && result.approvalId) openApproval(result.approvalId);
      }, fail);
    }} />;
  const items = choices ? choices.map(row => ({ id: row.id, label: row.name, detail: row.id })) : profiles;
  return <Window title={[span(words.title)]} body={[{ spans: [span(items.length ? words.note : words.empty)] }]} hints={labels.cache.hints} position={labels.position}
    footerRows={room.footerRows} onInput={() => true} footer={focused => <ListPicker tree={{ title: words.title, items }} labels={labels.picker} active={focused} maxRows={room.rows}
      onResult={result => {
        if (result.kind !== 'selected') { onDone(); return; }
        if (choices) { setSelected(choices.find(row => row.id === result.id) ?? null); return; }
        setBusy(true); setProfile(result.id);
        port.list(result.id).then(rows => { setChoices(rows); setBusy(false); }, fail);
      }} />} />;
}
