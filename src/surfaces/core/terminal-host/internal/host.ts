import { render, type Instance } from 'ink';
import { createElement, type ReactElement } from 'react';
import { WorklinePaletteProvider, type WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { mainScreenOutput, mouseFilteredInput, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON, osc52Copy, type PointerSource, type WheelSource } from '#surfaces/core/terminal-window/index.js';

/** The terminal bell: audible or a taskbar/tab flash by the terminal's own setting; the one signal every terminal and multiplexer passes through. */
const ATTENTION_BELL = '\u0007';

/** What the host decided before the view exists: the view receives it and renders from it. */
export interface TerminalHostContext {
  /** Full-window layout (alternate screen, mouse reports taken out of the input). */
  readonly fullscreen: boolean;
  /** The view fills this with a function returning the conversation text; the host prints it to the main screen after the alternate screen is left. */
  readonly transcriptExit: { current: (() => string) | null };
  /** Present only in the full window on a real TTY. */
  readonly wheel?: WheelSource;
  readonly pointer?: PointerSource;
  readonly copyText?: (text: string) => void;
  /** Rings the terminal bell (BEL) only while the terminal has reported that its window lost focus; never when focus is unknown. Present only when attention notices are on. */
  readonly notify?: () => void;
}

export interface TerminalHostOptions {
  readonly palette: WorklineInkPalette;
  readonly view: (context: TerminalHostContext) => ReactElement;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly signal?: AbortSignal;
  /** ASCII decoration for terminals that cannot be assumed to draw Unicode. */
  readonly ascii?: boolean;
  /** `false` keeps the screen as it is (no clear, no full window). */
  readonly clearScreen?: boolean;
  /** `false` chooses the inline layout on a TTY. */
  readonly fullscreen?: boolean;
  /** Runs once before the first frame when the layout is not full window (the inline start-up banner). */
  readonly inlineStartup?: (out: NodeJS.WriteStream) => void;
  /** Attention notices (T2): ask the terminal for focus reports and ring BEL when something needs the person while the window is in the background. Default off here; the setting turns it on. */
  readonly attention?: boolean;
}

/**
 * The terminal host: start-up, mouse reporting, OSC 52 copy, the alternate screen and the restore of the terminal on every exit path this process controls.
 * It knows no conversation; the view comes from the caller.
 * Ctrl+C is handled by the composer (cancel a running turn, clear a draft, or exit on a second press); the outer signal unmounts the view.
 */
export async function runTerminalHost(options: TerminalHostOptions): Promise<void> {
  const { palette, stdin, stdout, signal, ascii } = options;
  const out = stdout ?? process.stdout;
  // TERMINAL-SABIT-DUZEN: a TTY that takes escape sequences gets the full-window layout unless the person chose `inline` (`fullscreen: false`).
  const fullscreen = out.isTTY === true && options.clearScreen !== false && options.fullscreen !== false;
  const transcriptExit: { current: (() => string) | null } = { current: null };
  if (!fullscreen) options.inlineStartup?.(out);
  // Full window on a real TTY: mouse reports are taken out of the input (wheel = scroll, left drag = select and copy, the rest dropped) and reporting is switched
  // off again on every exit path this process controls (unmount, abort, a thrown error, process exit).
  // Attention notices (T2) take focus reports out of the input the same way, in either layout.
  const attention = options.attention === true && out.isTTY === true && options.clearScreen !== false;
  const realInput = stdin ?? process.stdin, mouse = (fullscreen || attention) && realInput.isTTY === true ? mouseFilteredInput(realInput) : null;
  const reportingOff = () => { try { out.write(`${fullscreen ? MOUSE_REPORTING_OFF : ''}${attention ? FOCUS_REPORTING_OFF : ''}`); } catch { /* the terminal is gone */ } };
  const view = createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii === true) },
    options.view({ fullscreen, transcriptExit,
      ...(mouse && attention ? { notify: () => { if (mouse.focus.state() !== 'unfocused') return; try { out.write(ATTENTION_BELL); } catch { /* the terminal is gone */ } } } : {}),
      ...(mouse && fullscreen ? { wheel: mouse.wheel, pointer: mouse.pointer, copyText: (text: string) => { try { out.write(osc52Copy(text)); } catch { /* the terminal is gone */ } } } : {}) }));
  // Ink 7 treats CI env as non-interactive even on a TTY (ink.js resolveInteractiveOption); the workline runs on a TTY, so force it there.
  // Full window: Ink's alternate screen (left on exit, as vim/htop/the Claude Code fullscreen renderer do) with incremental line updates.
  const instance: Instance = render(createElement(WorklinePaletteProvider, { palette, children: view }),
    { exitOnCtrlC: false, patchConsole: false, ...(out.isTTY === true ? { interactive: true } : {}), ...(mouse ? { stdin: mouse.input } : stdin ? { stdin } : {}),
      ...(fullscreen ? { alternateScreen: true, incrementalRendering: true } : {}),
      stdout: options.clearScreen === false ? out : mainScreenOutput(out) });
  const stop = () => instance.unmount();
  signal?.addEventListener('abort', stop, { once: true });
  if (mouse) { out.write(`${fullscreen ? MOUSE_REPORTING_ON : ''}${attention ? FOCUS_REPORTING_ON : ''}`); process.once('exit', reportingOff); }
  try { await instance.waitUntilExit(); }
  finally {
    signal?.removeEventListener('abort', stop);
    if (mouse) { reportingOff(); process.off('exit', reportingOff); mouse.close(); }
    // The conversation goes to the main screen after the alternate screen is left, so it stays in the terminal's own scrollback.
    if (fullscreen) { try { const text = transcriptExit.current?.(); if (text) out.write(`${text}\n`); } catch { /* the view is gone; nothing to restore */ } }
    const input = stdin ?? process.stdin;
    try { if (input.isTTY && input.isRaw) input.setRawMode(false); } catch { /* already restored */ }
    input.unref?.();
  }
}
