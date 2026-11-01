import { useRef, useState } from 'react';
import { useApp } from 'ink';
import { colorCapability, loadConfigTerminalLaunch, terminalSafeText, type KnownSecretSnapshot, type Locale } from '#platform/index.js';
import { terminalPalette, TERMINAL_THEME_SETTINGS } from '#surfaces/core/terminal-kit/index.js';
import { humanRecordText, prefersAsciiGlyphs, span } from '#surfaces/core/terminal-render/index.js';
import { CardCopyContext, QuestionRows, Window, WindowStackProvider, WINDOW_PRIORITY, questionStep, type QuestionState } from '#surfaces/core/terminal-window/index.js';
import { openTerminalHost, streamCardCopy } from '#surfaces/core/terminal-host/index.js';
import { cardCopyLabels, type CliCardRequest } from './card.js';

/** The card body: the terminal's bounded window and question rows, answered once; Esc, Ctrl+C or the window's close give no answer. */
function CliCard({ request, hints, known, finish }: { readonly request: CliCardRequest; readonly hints: string; readonly known?: KnownSecretSnapshot | undefined;
  readonly finish: (id: string | null) => void }) {
  const { exit } = useApp(), done = useRef(false);
  const [state, setState] = useState<QuestionState>({ at: request.options.findIndex(option => option.id === request.initial), ticked: [] });
  const current = useRef(state); current.current = state;
  const answer = (id: string | null) => { if (done.current) return; done.current = true; finish(id); exit(); };
  // J2e (lead, C-APPROVE note): option labels are drawn through the terminal-safe text rule like the title and body, so a label built from a stored
  // record (a server, Run or approval name) can never carry a control sequence onto the person's terminal, whatever the caller did.
  const options = request.options.map(option => ({ ...option, label: terminalSafeText(option.label) }));
  return <Window title={[span(humanRecordText(request.title, known))]} body={(request.body ?? []).map(line => ({ spans: [span(humanRecordText(line, known))] }))}
    hints={hints} position="{from}-{to}/{total}" decision priority={WINDOW_PRIORITY.approval} footerRows={request.options.length}
    footer={owns => <QuestionRows kind="single" options={options} state={state} focused={owns} />} onClose={() => answer(null)}
    onInput={(input, key, meta) => {
      // A burst read (several key events at once) is never an answer, as on the terminal's decision cards.
      if (done.current || meta?.burst) return true;
      const step = questionStep('single', request.options, current.current, input, key);
      if (step.kind === 'move') { current.current = step.state; setState(step.state); return true; }
      if (step.kind === 'submit' || step.kind === 'cancel') { answer(step.kind === 'submit' ? step.ids[0] ?? null : null); return true; }
      return key.tab;
    }} />;
}

export async function mountCliCard(request: CliCardRequest, io: Readonly<{ stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; env: NodeJS.ProcessEnv;
  root?: string; locale: Locale; hints: string; signal?: AbortSignal; known?: KnownSecretSnapshot }>): Promise<string | null> {
  let chosen: string | null = null;
  // An abort event fires once: a signal already aborted at mount is never heard by a later listener, so exit before drawing (Astra 2661 P2).
  if (io.signal?.aborted) return null;
  const presentation = await loadConfigTerminalLaunch(io.root ?? process.cwd(), { env: io.env }).catch(() => null);
  if (io.signal?.aborted) return null;
  const setting = TERMINAL_THEME_SETTINGS.find(value => value === presentation?.terminal['theme']) ?? TERMINAL_THEME_SETTINGS[0];
  const theme = { setting, capability: colorCapability({ env: io.env, isTTY: true, argv: process.argv }), colorfgbg: io.env['COLORFGBG'] };
  const host = await openTerminalHost({ palette: terminalPalette(setting, theme.capability, theme.colorfgbg), theme, stdout: io.stdout, stdin: io.stdin,
    ...(io.signal ? { signal: io.signal } : {}), ascii: prefersAsciiGlyphs(io.env), clearScreen: false, fullscreen: false,
    view: () => <CardCopyContext.Provider value={streamCardCopy(io.stdout, cardCopyLabels(io.locale), io.env)}>
      <WindowStackProvider><CliCard request={request} hints={io.hints} known={io.known} finish={id => { chosen = id; }} /></WindowStackProvider>
    </CardCopyContext.Provider> });
  try { await host.wait(); } finally { await host.close(); }
  return io.signal?.aborted ? null : chosen;
}
