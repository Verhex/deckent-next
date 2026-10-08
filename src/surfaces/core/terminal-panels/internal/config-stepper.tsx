import { useRef, useState } from 'react';
import { configNumberText, stepConfigNumber, type ConfigStepper } from '#platform/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';

/** Digit keys have no action. Only a bounded arrow/+/- step changes the proposed number. */
export function ConfigNumberWindow({ title, stepper, hints, position, onSubmit, onCancel }: { readonly title: string; readonly stepper: ConfigStepper;
  readonly hints: string; readonly position: string; readonly onSubmit: (value: number) => void; readonly onCancel: () => void }) {
  const [value, setValue] = useState(stepper.current), live = useRef(value), submitted = useRef(false);
  live.current = value;
  return <Window title={[span(title, { bold: true })]} hints={hints} position={position} onClose={onCancel}
    body={[{ spans: [span(configNumberText(value, stepper.unit), { bold: true, role: 'accent' })] },
      { spans: [span(`${configNumberText(stepper.min, stepper.unit)} … ${configNumberText(stepper.max, stepper.unit)}`, { role: 'muted' })] }]}
    onInput={(input, key) => {
      if (submitted.current) return true;
      if (key.escape || key.ctrl && input === 'c') { onCancel(); return true; }
      if (key.return) { submitted.current = true; onSubmit(live.current); return true; }
      const direction = key.leftArrow || input === '-' ? -1 : key.rightArrow || input === '+' ? 1 : null;
      if (direction) { live.current = stepConfigNumber(stepper, live.current, direction); setValue(live.current); }
      return true;
    }} />;
}
