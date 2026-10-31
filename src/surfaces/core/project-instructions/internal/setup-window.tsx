import { useRef, useState } from 'react';
import { Text, useApp, useWindowSize } from 'ink';
import { colorCapability, loadConfigTerminalLaunch } from '#platform/index.js';
import { QuestionRows, Window, WindowStackProvider, questionStep, type QuestionOption, type QuestionState } from '#surfaces/core/terminal-window/index.js';
import { prefersAsciiGlyphs, span, truncateEnd, useSpinnerGlyph, wrapCells } from '#surfaces/core/terminal-render/index.js';
import { terminalPalette, TERMINAL_THEME_SETTINGS } from '#surfaces/core/terminal-kit/index.js';

import { runTerminalHost } from '#surfaces/core/terminal-host/index.js';

/** One step of the guided `deckent init` window (I-S4): the setup controller (surfaces/core/setup) decides every row and answer; this view
 * only draws them. `rows`, `heights` and `optionRows` are constant across steps, so the window keeps one height and its bottom row never moves:
 * row `i` fills exactly `heights[i]` display rows (default 1, R05). `initial` is the highlighted option (the recommended answer; Enter accepts it).
 * An option's yes/no `role` makes the shared question contract show and take (y)/(n) on it. While an answer is applied the hint row says
 * `applying` (with `busyKey` once a key was pressed then): keys are visibly not used, and the next step's window re-arms (walk19R). */
export type SetupWindowModel = Readonly<{ title: string; rows: readonly string[]; heights?: readonly number[]; options: readonly QuestionOption[];
  optionRows: number; initial: number; hints: string; applying: string; busyKey: string; position: string; reveal: number }>;
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
  const [turn, setTurn] = useState(0), [applying, setApplying] = useState(false), [refused, setRefused] = useState(false), spinner = useSpinnerGlyph(applying);
  const answer = (id: string) => {
    busy.current = true; setApplying(true);
    step(id).then(next => {
      busy.current = false; setApplying(false); setRefused(false);
      if (next === null) exit(); else { setModel(next); setChoice({ at: next.initial, ticked: [] }); setTurn(value => value + 1); }
    }, error => { failed(error); exit(); });
  };
  const padding = Math.max(0, model.optionRows - model.options.length), width = Math.max(8, (useWindowSize().columns || 80) - 4);
  // A plain row is cut to the width; a text row fills its rows and wraps further only when the terminal is too narrow for the whole text.
  const lines = model.rows.flatMap((row, index) => fitRows(row, model.heights?.[index] ?? 1, width));
  // Each step is a new question: the window mounts again and re-arms (arming.ts), so a key typed for the last answer ("1" then Enter) never answers this one.
  return <Window key={turn} title={[span(model.title)]} body={lines.map(text => ({ spans: [span(text)], exact: true }))} reveal={model.reveal}
    hints={applying ? `${spinner} ${model.applying}${refused ? ` · ${model.busyKey}` : ''}` : model.hints} position={model.position} footerRows={model.options.length + padding} decision
    footer={owns => <><QuestionRows kind="single" options={model.options} state={choice} focused={owns} />{Array.from({ length: padding }, (_, index) => <Text key={index}> </Text>)}</>}
    onInput={(input, key, meta) => {
      // An answer being applied takes no second one, and says so; a burst read is never an answer.
      if (busy.current) { setRefused(true); return true; }
      if (meta?.burst) return true;
      const next = questionStep('single', model.options, choice, input, key);
      if (next.kind === 'move') { setChoice(next.state); return true; }
      if (next.kind === 'cancel') { answer('close'); return true; }
      if (next.kind === 'submit' && next.ids[0]) { answer(next.ids[0]); return true; }
      return key.tab;
    }} onClose={() => answer('close')} />;
}

/** Mounts the window on the person's terminal and resolves when a step returns null (closed). Ink loads only through this lazy module. */
export async function mountSetupWindow(initial: SetupWindowModel, step: SetupWindowStep, io: Readonly<{ stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; env: NodeJS.ProcessEnv; root?: string }>) {
  let failure: unknown = null;
  const presentation = await loadConfigTerminalLaunch(io.root ?? process.cwd(), { env: io.env }).catch(() => null);
  const setting = TERMINAL_THEME_SETTINGS.find(value => value === presentation?.terminal['theme']) ?? TERMINAL_THEME_SETTINGS[0];
  const theme = { setting, capability: colorCapability({ env: io.env, isTTY: true, argv: process.argv }), colorfgbg: io.env['COLORFGBG'] };
  await runTerminalHost({ palette: terminalPalette(setting, theme.capability, theme.colorfgbg), theme, stdout: io.stdout, stdin: io.stdin,
    ascii: prefersAsciiGlyphs(io.env), clearScreen: false, fullscreen: false,
    view: () => <WindowStackProvider reservedRows={1}><SetupWindow initial={initial} step={step} failed={error => { failure = error; }} /></WindowStackProvider> });
  if (failure !== null) throw failure;
}
