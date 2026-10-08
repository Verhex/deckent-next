import { useRef, useState } from 'react';
import { span, useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { Window } from './window.js';
import { INFO_GLYPHS_ASCII, INFO_GLYPHS_UNICODE, infoChoices, infoWindowLines, type InfoWindowLabelsShape, type InfoWindowModel } from './info-model.js';

export type InfoWindowLabels = InfoWindowLabelsShape;

/**
 * A legible information window (SW-1): the typed model drawn on the shared `Window` — title, chips, sections of aligned key/value rows with
 * bold keys, coloured chips with a word and a shape, muted shortened identities, lists, tables and a scrollable body. Esc, Enter or q
 * closes it (`onClose(null)`). With choices, ↑↓ move the highlight (the body follows it) and Enter answers the highlighted `id`.
 */
export function InfoWindow({ model, labels, onClose, priority }: { readonly model: InfoWindowModel; readonly labels: InfoWindowLabels;
  readonly onClose: (choice: string | null) => void; readonly priority?: number }) {
  const glyphs = useRenderGlyphs();
  const info = glyphs.ascii ? INFO_GLYPHS_ASCII : INFO_GLYPHS_UNICODE;
  const choices = infoChoices(model);
  const [selected, setSelected] = useState(0);
  const closed = useRef(false);
  const at = choices.length ? Math.min(selected, choices.length - 1) : null;
  const layout = infoWindowLines(model, at, info);
  const close = (choice: string | null) => { if (closed.current) return; closed.current = true; onClose(choice); };
  return (
    <Window title={[span(model.title)]} body={layout.lines} hints={choices.length ? labels.pickHints : labels.hints} position={labels.position}
      {...(priority === undefined ? {} : { priority })} {...(at === null ? {} : { reveal: layout.choiceLines[at]! })}
      onClose={() => close(null)}
      onInput={(input, key) => {
        const plain = !key.ctrl && !key.meta && !key.shift;
        if (choices.length && plain && (key.upArrow || key.downArrow)) {
          setSelected(value => (Math.min(value, choices.length - 1) + (key.upArrow ? choices.length - 1 : 1)) % choices.length);
          return true;
        }
        if (key.return) { close(at === null ? null : choices[at]!.id); return true; }
        if (plain && input === 'q') { close(null); return true; }
        return false;
      }} />
  );
}
