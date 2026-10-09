import { useState } from 'react';
import { span } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, type PickerResult, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { panelWindowLines, usePickerRoom } from './lines.js';
import type { CachePanelLabels, CachePanelPort, CachePanelView, PanelLabels, PanelNotice } from './contract.js';

const CONFIRM = 'confirm';
/** The list row that opens the cache window (CACHE-SLICE1), or null when no existing profile is offered the change. */
export function cacheEntry(view: CachePanelView | null, words: CachePanelLabels): Readonly<{ label: string; detail: string }> | null {
  return view ? { label: words.entry, detail: view.detail } : null;
}
export function cacheConfirmTree(words: CachePanelLabels): PickerTree {
  return { title: words.title, items: [{ id: CONFIRM, label: words.confirm }, { id: 'cancel', label: words.cancel }] };
}

/**
 * CACHE-SLICE1 (owner 2026-10-09): the one-step, visible migration of existing profiles to the 5-minute prompt cache. The body says what changes and
 * what it costs (each model's own write and read price against its input price, and after how many reuses within 5 minutes it pays back); nothing
 * is written before the answer, and the write is the governed `/config` writer's (a policy approval opens after the window closes).
 */
export function CacheWindow({ port, view, labels, words = labels.cache, push, openApproval, onError, onDone }: { readonly port: CachePanelPort; readonly view: CachePanelView; readonly labels: PanelLabels;
  readonly words?: CachePanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly openApproval?: (approvalId: string) => void; readonly onError: (error: unknown) => void; readonly onDone: () => void }) {
  const room = usePickerRoom(view.lines.length);
  const [busy, setBusy] = useState(false);
  const title = [span(words.title, { bold: true })];
  if (busy) return <Window title={title} body={[{ spans: [span(labels.loading)] }]} hints={words.hints} position={labels.position} />;
  const answer = (result: PickerResult) => {
    if (result.kind !== 'selected' || result.id !== CONFIRM) { onDone(); return; }
    setBusy(true);
    port.apply().then(outcome => {
      push([{ level: outcome.status === 'applied' ? 'info' : 'warning', text: outcome.lines.join('\n') }]);
      onDone();
      if (outcome.status === 'approval-pending' && outcome.approvalId && openApproval) openApproval(outcome.approvalId);
    }, error => { onError(error); onDone(); });
  };
  return <Window title={title} body={panelWindowLines(view.lines)} hints={words.hints} position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker tree={cacheConfirmTree(words)} labels={labels.picker} active={focused} maxRows={room.rows} onResult={answer} />} />;
}
