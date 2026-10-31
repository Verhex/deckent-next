import { render, type Instance } from 'ink';
import { createElement, type ReactElement } from 'react';
import { terminalPalette, WorklinePaletteProvider, type ColorTier, type TerminalThemeSetting, type WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import type { TerminalHandover } from './handoff.js';
import { createClipboardWriter, type ClipboardResult } from './clipboard.js';
import { mainScreenOutput, mouseFilteredInput, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON, osc52Copy, PALETTE_NOTICES_OFF, PALETTE_NOTICES_ON,
  type PointerSource, type WheelSource } from '#surfaces/core/terminal-window/index.js';
import LIMITS from './host-limits.json' with { type: 'json' };

/** The terminal bell: audible or a taskbar/tab flash by the terminal's own setting; the one signal every terminal and multiplexer passes through. */
const ATTENTION_BELL = '\u0007';

/** The person's `terminal.theme`, what the terminal can draw (`colorCapability`) and its `COLORFGBG`: the host draws `terminalPalette` of them. */
export interface TerminalThemeRequest { readonly setting: TerminalThemeSetting; readonly capability: ColorTier; readonly colorfgbg?: string | undefined }
let reported: string | null | undefined;
/** What this process's one background probe found: `#RRGGBB`, null when the terminal did not answer, undefined before any probe. */
export function reportedTerminalBackground(): string | null | undefined { return reported; }

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
  /** T1 `/copy`: the clipboard request writer (OSC 52, tmux-wrapped, byte-capped); present on every real TTY, not only in the full window. */
  readonly clipboard?: (text: string) => ClipboardResult;
  /** T4: present while the host takes mouse or focus reports. Switches them off while a child process (the editor) owns the terminal and on again after. */
  readonly handover?: TerminalHandover;
  /** TEMA-OKUNURLUK: the reported background (`#RRGGBB` or null) and the one theme setter (`/theme`, `/config`): the setting is drawn at once and
   * against later DEC 2031 answers. Without a theme request `apply` keeps the given palette. */
  readonly theme: Readonly<{ background: () => string | null; apply: (setting: TerminalThemeSetting) => void }>;
}

export interface TerminalHostOptions {
  readonly palette: WorklineInkPalette;
  /** TEMA-OKUNURLUK: draw `terminalPalette` of this request (`palette` is then unused). On a TTY that draws colour the host asks the background once per
   * process before the first frame (OSC 11 + DA1, at most `backgroundProbeMs`) and again on each DEC 2031 notice; every later answer is taken out of the input. */
  readonly theme?: TerminalThemeRequest;
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
  /** Runs once before the first frame when the layout is not full window (the inline start-up banner), with the palette the host chose. */
  readonly inlineStartup?: (out: NodeJS.WriteStream, palette: WorklineInkPalette) => void;
  /** Attention notices (T2): ask the terminal for focus reports and ring BEL when something needs the person while the window is in the background. Default off here; the setting turns it on. */
  readonly attention?: boolean;
}

/**
 * The terminal host: start-up, mouse reporting, OSC 52 copy, the alternate screen and the restore of the terminal on every exit path this process controls.
 * It knows no conversation; the view comes from the caller.
 * Ctrl+C is handled by the composer (cancel a running turn, clear a draft, or exit on a second press); the outer signal unmounts the view.
 */
export async function runTerminalHost(options: TerminalHostOptions): Promise<void> { await (await openTerminalHost(options)).wait(); }
/** alpha.60 C: one open host whose view can be replaced (the launch shell, then the Workline) under the same input owner, alternate screen,
 * mouse and focus reports and terminal restore. `close` leaves the alternate screen and restores the terminal (idempotent, as `wait`). */
export interface TerminalHostHandle {
  readonly context: TerminalHostContext; readonly palette: WorklineInkPalette;
  setView(view: TerminalHostOptions['view'], palette?: WorklineInkPalette): void;
  /** Resolves when the frame drawn so far has been written to the terminal. */ flushed(): Promise<void>;
  wait(): Promise<void>; close(): Promise<void>; readonly open: () => boolean;
}
export async function openTerminalHost(options: TerminalHostOptions): Promise<TerminalHostHandle> {
  const { stdin, stdout, signal, ascii } = options;
  const out = stdout ?? process.stdout;
  // TERMINAL-SABIT-DUZEN: a TTY that takes escape sequences gets the full-window layout unless the person chose `inline` (`fullscreen: false`).
  const fullscreen = out.isTTY === true && options.clearScreen !== false && options.fullscreen !== false;
  const transcriptExit: { current: (() => string) | null } = { current: null };
  // Full window on a real TTY: mouse reports are taken out of the input (wheel = scroll, left drag = select and copy, the rest dropped) and reporting is switched
  // off again on every exit path this process controls (unmount, abort, a thrown error, process exit).
  // Attention notices (T2) take focus reports out of the input the same way, in either layout; so does the background probe (`theme`).
  const attention = options.attention === true && out.isTTY === true && options.clearScreen !== false;
  const realInput = stdin ?? process.stdin, request = options.theme;
  const probing = request !== undefined && request.capability !== 'none' && out.isTTY === true && realInput.isTTY === true;
  const mouse = (fullscreen || attention || probing) && realInput.isTTY === true ? mouseFilteredInput(realInput) : null;
  // The probe reads the answer in raw mode (no echo, no line buffering); keys typed meanwhile wait in order for Ink, Ctrl+C ends the wait.
  const ask = () => mouse!.background.ask(query => { try { out.write(query); } catch { /* the terminal is gone */ } }, LIMITS.backgroundProbeMs);
  if (probing && reported === undefined) { try { realInput.setRawMode(true); } catch { /* not a raw-capable TTY */ } reported = await ask(); }
  // Ink asks a TTY for the kitty keyboard protocol as it renders (owner S5); raw mode first, so the terminal's answer is never echoed on screen.
  if (out.isTTY === true && realInput.isTTY === true) try { realInput.setRawMode(true); } catch { /* not a raw-capable TTY */ }
  let setting = request?.setting;
  const drawn = () => request && setting ? terminalPalette(setting, request.capability, request.colorfgbg, reported) : options.palette;
  let palette = drawn();
  if (!fullscreen) options.inlineStartup?.(out, palette);
  const modes = (mouseMode: string, focusMode: string, noticeMode: string) => `${fullscreen ? mouseMode : ''}${attention ? focusMode : ''}${probing ? noticeMode : ''}`;
  const reportingOff = () => { try { out.write(modes(MOUSE_REPORTING_OFF, FOCUS_REPORTING_OFF, PALETTE_NOTICES_OFF)); } catch { /* the terminal is gone */ } };
  const reportingOn = () => { try { out.write(modes(MOUSE_REPORTING_ON, FOCUS_REPORTING_ON, PALETTE_NOTICES_ON)); } catch { /* the terminal is gone */ } };
  // T4: Ink's own suspension hands back raw mode, bracketed paste and the alternate screen; mouse and focus reports are the host's to switch off and on.
  const handover: TerminalHandover | undefined = mouse ? { release: () => { reportingOff(); mouse.hold(true); }, reclaim: () => { mouse.hold(false); reportingOn(); } } : undefined;
  let view = options.view;
  const repaint = () => { if (request) palette = drawn(); if (open) instance.rerender(tree(view, palette)); };
  const theme: TerminalHostContext['theme'] = { background: () => reported ?? null, apply: next => { setting = next; repaint(); } };
  const context: TerminalHostContext = { fullscreen, transcriptExit, theme, ...(handover ? { handover } : {}), ...(out.isTTY === true ? { clipboard: createClipboardWriter(out) } : {}),
    ...(mouse && attention ? { notify: () => { if (mouse.focus.state() !== 'unfocused') return; try { out.write(ATTENTION_BELL); } catch { /* the terminal is gone */ } } } : {}),
    ...(mouse && fullscreen ? { wheel: mouse.wheel, pointer: mouse.pointer, copyText: (text: string) => { try { out.write(osc52Copy(text)); } catch { /* the terminal is gone */ } } } : {}) };
  const tree = (view: TerminalHostOptions['view'], colors: WorklineInkPalette) => createElement(WorklinePaletteProvider, { palette: colors,
    children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii === true) }, view(context)) });
  // Ink 7 treats CI env as non-interactive even on a TTY (ink.js resolveInteractiveOption); the workline runs on a TTY, so force it there.
  // Full window: Ink's alternate screen (left on exit, as vim/htop/the Claude Code fullscreen renderer do) with incremental line updates.
  const instance: Instance = render(tree(view, palette),
    // Owner S5 (alpha.60 WL): the kitty keyboard protocol where the terminal answers Ink's query (`CSI ? u`), so Ctrl+Enter is a key of its own;
    // a terminal without it keeps its keys and Alt+Enter stands in. Ink switches the mode off on unmount and around a suspension (the editor).
    { exitOnCtrlC: false, patchConsole: false, ...(out.isTTY === true ? { interactive: true, kittyKeyboard: { mode: 'auto' as const } } : {}), ...(mouse ? { stdin: mouse.input } : stdin ? { stdin } : {}),
      ...(fullscreen ? { alternateScreen: true, incrementalRendering: true } : {}),
      stdout: options.clearScreen === false ? out : mainScreenOutput(out) });
  const stop = () => instance.unmount();
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true }); // aborted during the probe: nothing stays open
  if (mouse) { reportingOn(); process.once('exit', reportingOff); }
  // S8 c: a terminal that reports a scheme change (DEC 2031) is asked again; a terminal without the mode keeps the start-up answer.
  if (probing) mouse!.background.onPaletteNotice(() => { void ask().then(color => { if (color === null) return; reported = color; repaint(); }); });
  // FIX8a R27: Node prints a process warning straight to stderr, over the view; it is held while the view is mounted and emitted after it
  // (the first `heldWarningsMax` of registry `host-limits.json`; a flood is cut, never buffered without bound).
  const warningListeners = process.listeners('warning'), held: Error[] = [];
  const hold = (warning: Error) => { if (held.length < LIMITS.heldWarningsMax) held.push(warning); };
  process.removeAllListeners('warning'); process.on('warning', hold);
  let open = true;
  const done = (async () => { try { await instance.waitUntilExit(); }
  finally { open = false;
    process.off('warning', hold); for (const listener of warningListeners) process.on('warning', listener);
    for (const warning of held) process.emitWarning(warning);
    signal?.removeEventListener('abort', stop);
    if (mouse) { reportingOff(); process.off('exit', reportingOff); mouse.close(); }
    // The conversation goes to the main screen after the alternate screen is left, so it stays in the terminal's own scrollback.
    if (fullscreen) { try { const text = transcriptExit.current?.(); if (text) out.write(`${text}\n`); } catch { /* the view is gone; nothing to restore */ } }
    const input = stdin ?? process.stdin;
    try { if (input.isTTY && input.isRaw) input.setRawMode(false); } catch { /* already restored */ }
    input.unref?.();
  } })();
  return { context, get palette() { return palette; }, open: () => open, flushed: () => instance.waitUntilRenderFlush(), wait: () => done,
    setView: (next, colors) => { view = next; if (colors) palette = colors; if (open) instance.rerender(tree(view, palette)); }, close: () => { if (open) instance.unmount(); return done; } };
}
