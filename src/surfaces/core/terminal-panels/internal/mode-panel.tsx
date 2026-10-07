import { useEffect, useRef, useState } from 'react';
import { PERMISSION_MODES, type PermissionModeView } from '#domain/index.js';
import { fillTemplate, span, type PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, pickerView, PICKER_INITIAL, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import type { ModePanelLabels, ModePanelPort, PanelLabels } from './contract.js';
import { usePickerRoom } from './lines.js';

const STOPS: readonly PermissionModeStop[] = ['standart', 'ask-edits', 'full-auto', 'full-access'];
/** The focused mode's sentence: the body rows the window keeps for it (a longer one scrolls). */
const MODE_BODY_ROWS = 2;

/** Why a stop cannot be taken here, from the service's own view (the service decides again on the set). */
function blockedReason(stop: PermissionModeStop, view: PermissionModeView, current: PermissionModeStop | null, labels: ModePanelLabels): string | null {
  if (!view.supported) return fillTemplate(labels.unsupported, { mode: PERMISSION_MODES.includes(view.mode) ? view.mode : '-' });
  if (stop === 'full-access' && !view.fullAccess && current !== 'full-access') return labels.fullAccessGrant;
  if (stop === 'full-auto' && view.fullAuto === false) return labels.fullAutoOff;
  return null;
}

/** `/mode` as a list (Shift+Tab's panel form): every mode with what it does; the ones this person may not take are shown locked, with why. */
export function modePanelTree(view: PermissionModeView, current: PermissionModeStop | null, labels: ModePanelLabels): PickerTree {
  return { title: labels.title, items: STOPS.map(stop => {
    const blocked = blockedReason(stop, view, current, labels);
    return { id: stop, label: stop === current ? `${labels.stops[stop]} · ${labels.current}` : labels.stops[stop], keywords: [stop],
      ...(blocked ? { blocked: { reason: blocked } } : {}) };
  }) };
}

export function ModePanel({ port, labels, onError, onClose }: { readonly port: ModePanelPort; readonly labels: PanelLabels;
  readonly onError: (error: unknown) => void; readonly onClose: () => void }) {
  const [view, setView] = useState<PermissionModeView | null>(null);
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => {
    let live = true;
    port.inspect().then(value => { if (live) setView(value); }, error => { if (live) { exits.current.onError(error); exits.current.onClose(); } });
    return () => { live = false; };
  }, [port]);
  const words = labels.mode, room = usePickerRoom(MODE_BODY_ROWS);
  if (!view) return <Window title={[span(words.title)]} body={[{ spans: [span(labels.loading)] }]} hints={words.hints} position={labels.position} onClose={onClose} />;
  const current = port.current(), tree = modePanelTree(view, current, words);
  const shown = pickerView(tree, state), focused = shown.rows[shown.pos];
  // A locked row's reason stands under the list; its effect sentence would only push the window past a short terminal.
  const stop = focused?.blocked ? undefined : STOPS.find(item => item === focused?.id);
  return <Window title={[span(words.title)]} body={stop ? [{ spans: [span(words.effect[stop])] }] : []} hints={words.hints} position={labels.position}
    footerRows={room.footerRows} onInput={() => true}
    footer={focusedWindow => <ListPicker tree={tree} labels={labels.picker} active={focusedWindow} initial={state} onState={setState} maxRows={room.rows}
      onResult={result => {
        const chosen = result.kind === 'selected' ? STOPS.find(item => item === result.id) : undefined;
        onClose();
        if (chosen && chosen !== current) void port.select(chosen);
      }} />} />;
}
