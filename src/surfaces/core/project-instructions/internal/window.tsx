import { useRef, useState } from 'react';
import { Text } from 'ink';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { projectHumanText, span } from '#surfaces/core/terminal-render/index.js';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import type { ProjectInstructionLabels } from './labels.js';

/** A single bounded window/focus owner; Up/Down choose, paging reads the preview, Esc declines. */
export function InstructionChoiceWindow(props: { readonly title: string; readonly body: readonly string[]; readonly choices: readonly string[];
  readonly labels: ProjectInstructionLabels; readonly onChoice: (index: number | null) => void }) {
  const [selected, setSelected] = useState(0), selectedRef = useRef(0), closed = useRef(false), palette = useWorklinePalette();
  const finish = (value: number | null) => { if (!closed.current) { closed.current = true; props.onChoice(value); } };
  return <Window title={[span(props.title)]} body={props.body.map(text => ({ spans: projectHumanText(text, 'prose').spans, exact: true }))}
    hints={props.labels.hints} position={props.labels.position} footerRows={props.choices.length}
    footer={() => props.choices.map((choice, index) => <Text key={index} {...(selected === index ? palette.selection : palette.muted)}>{`${selected === index ? '>' : ' '} ${choice}`}</Text>)}
    onInput={(input, key) => {
      if (key.upArrow || key.downArrow) {
        selectedRef.current = (selectedRef.current + (key.upArrow ? -1 : 1) + props.choices.length) % props.choices.length;
        setSelected(selectedRef.current); return true;
      }
      if (key.return) { finish(selectedRef.current); return true; }
      if (key.ctrl && input === 'c') { finish(null); return true; }
      return false;
    }} onClose={() => finish(null)} />;
}
