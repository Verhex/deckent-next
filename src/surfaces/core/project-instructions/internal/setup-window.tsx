import { useRef, useState } from 'react';
import { Text, render, useApp, useWindowSize } from 'ink';
import { colorCapability } from '#platform/index.js';
import { QuestionRows, Window, WindowStackProvider, questionStep, type QuestionState } from '#surfaces/core/terminal-window/index.js';
import { RenderGlyphsContext, prefersAsciiGlyphs, resolveRenderGlyphs, span, truncateEnd } from '#surfaces/core/terminal-render/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';

/** One step of the guided `deckent init` window (I-S4): the setup controller (surfaces/core/setup) decides every row and answer; this view
 * only draws them. `rows` and `optionRows` are constant across steps, so the window keeps one height and its bottom row never moves. */
export type SetupWindowModel = Readonly<{ title: string; rows: readonly string[]; options: readonly Readonly<{ id: string; label: string }>[]; optionRows: number;
  hints: string; position: string; reveal: number }>;
/** The answer to one step: the next model, or null to close. A rejection closes the window and rejects `mountSetupWindow`. */
export type SetupWindowStep = (id: string) => Promise<SetupWindowModel | null>;

function SetupWindow({ initial, step, failed }: Readonly<{ initial: SetupWindowModel; step: SetupWindowStep; failed: (error: unknown) => void }>) {
  const { exit } = useApp(), [model, setModel] = useState(initial), [choice, setChoice] = useState<QuestionState>({ at: -1, ticked: [] }), busy = useRef(false);
  const answer = (id: string) => {
    busy.current = true;
    step(id).then(next => {
      busy.current = false;
      if (next === null) exit(); else { setModel(next); setChoice({ at: -1, ticked: [] }); }
    }, error => { failed(error); exit(); });
  };
  const padding = Math.max(0, model.optionRows - model.options.length), width = Math.max(8, (useWindowSize().columns || 80) - 4);
  // Every row is cut to the width (never wrapped), so a longer reason or command never makes the window taller.
  return <Window title={[span(model.title)]} body={model.rows.map(text => ({ spans: [span(truncateEnd(text, width, '…'))], exact: true }))} reveal={model.reveal}
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
