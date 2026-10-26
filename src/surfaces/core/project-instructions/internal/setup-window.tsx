import { useRef, useState } from 'react';
import { Text, render, useApp, useWindowSize } from 'ink';
import { colorCapability } from '#platform/index.js';
import { QuestionRows, Window, WindowStackProvider, questionStep, type QuestionState } from '#surfaces/core/terminal-window/index.js';
import { RenderGlyphsContext, prefersAsciiGlyphs, resolveRenderGlyphs, span, truncateEnd, wrapCells } from '#surfaces/core/terminal-render/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';

/** One step of the guided `deckent init` window (I-S4): the setup controller (surfaces/core/setup) decides every row and answer; this view
 * only draws them. `rows`, `heights` and `optionRows` are constant across steps, so the window keeps one height and its bottom row never moves:
 * row `i` fills exactly `heights[i]` display rows (default 1, R05). `initial` is the highlighted option (the recommended answer; Enter accepts it). */
export type SetupWindowModel = Readonly<{ title: string; rows: readonly string[]; heights?: readonly number[]; options: readonly Readonly<{ id: string; label: string }>[];
  optionRows: number; initial: number; hints: string; position: string; reveal: number }>;
/** A text row in at least `rows` display rows: wrapped by words and never cut (FIX9: a narrower terminal shows the whole reason, the window scrolls),
 * blank rows after a short one; a one-row line (a stage, the command) is cut with "…". */
const fitRows = (text: string, rows: number, width: number): readonly string[] => {
  if (rows <= 1) return [truncateEnd(text, width, '…')];
  const wrapped = wrapCells(text, width);
  return [...wrapped, ...Array.from({ length: Math.max(0, rows - wrapped.length) }, () => '')];
};
/** The answer to one step: the next model, or null to close. A rejection closes the window and rejects `mountSetupWindow`. */
export type SetupWindowStep = (id: string) => Promise<SetupWindowModel | null>;

function SetupWindow({ initial, step, failed }: Readonly<{ initial: SetupWindowModel; step: SetupWindowStep; failed: (error: unknown) => void }>) {
  const { exit } = useApp(), [model, setModel] = useState(initial), [choice, setChoice] = useState<QuestionState>({ at: initial.initial, ticked: [] }), busy = useRef(false);
  const answer = (id: string) => {
    busy.current = true;
    step(id).then(next => {
      busy.current = false;
      if (next === null) exit(); else { setModel(next); setChoice({ at: next.initial, ticked: [] }); }
    }, error => { failed(error); exit(); });
  };
  const padding = Math.max(0, model.optionRows - model.options.length), width = Math.max(8, (useWindowSize().columns || 80) - 4);
  // A plain row is cut to the width; a text row fills its rows and wraps further only when the terminal is too narrow for the whole text.
  const lines = model.rows.flatMap((row, index) => fitRows(row, model.heights?.[index] ?? 1, width));
  return <Window title={[span(model.title)]} body={lines.map(text => ({ spans: [span(text)], exact: true }))} reveal={model.reveal}
    hints={model.hints} position={model.position} footerRows={model.options.length + padding} decision
    footer={owns => <><QuestionRows kind="single" options={model.options} state={choice} focused={owns} />{Array.from({ length: padding }, (_, index) => <Text key={index}> </Text>)}</>}
    onInput={(input, key, meta) => {
      // A burst read is never an answer; an answer being applied takes no second one.
      if (busy.current || meta?.burst) return true;
      const next = questionStep('single', model.options, choice, input, key);
      if (next.kind === 'move') { setChoice(next.state); return true; }
      if (next.kind === 'cancel') { answer('close'); return true; }
      if (next.kind === 'submit' && next.ids[0]) { answer(next.ids[0]); return true; }
      return key.tab;
    }} onClose={() => answer('close')} />;
}

/** Mounts the window on the person's terminal and resolves when a step returns null (closed). Ink loads only through this lazy module. */
export async function mountSetupWindow(initial: SetupWindowModel, step: SetupWindowStep, io: Readonly<{ stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; env: NodeJS.ProcessEnv }>) {
  let failure: unknown = null;
  const palette = resolveWorklinePalette(colorCapability({ env: io.env, isTTY: true, argv: [] }));
  const view = render(<WorklinePaletteProvider palette={palette}><RenderGlyphsContext.Provider value={resolveRenderGlyphs(prefersAsciiGlyphs(io.env))}>
    <WindowStackProvider reservedRows={1}><SetupWindow initial={initial} step={step} failed={error => { failure = error; }} /></WindowStackProvider>
  </RenderGlyphsContext.Provider></WorklinePaletteProvider>, { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try { await view.waitUntilExit(); } finally { view.unmount(); }
  if (failure !== null) throw failure;
}
