import { render } from 'ink';
import { colorCapability } from '#platform/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, prefersAsciiGlyphs, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { SettingsPanel } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import type { ConfigPanelOpener } from '#surfaces/core/config/index.js';

/**
 * `deckent config` on a person's terminal: the same `SettingsPanel` (kind `config`) the terminal opens for `/config`, with the same port
 * (`configPanelPort`: registry keys, schema choices, policy locks, the principal'd approval-aware write). It resolves with the one-line
 * summaries the window pushed; a port failure closes the window and rejects (the command fails with that typed error, nothing more is
 * written); a cancellation of the command closes it with no answer.
 */
export const mountConfigPanel: ConfigPanelOpener = async (port, io) => {
  const pushed: string[] = [];
  let failure: unknown = null;
  if (io.signal?.aborted) return pushed;
  const palette = resolveWorklinePalette(colorCapability({ env: io.env, isTTY: true, argv: [] }));
  let close = () => {};
  const view = render(<WorklinePaletteProvider palette={palette}><RenderGlyphsContext.Provider value={resolveRenderGlyphs(prefersAsciiGlyphs(io.env))}>
    <WindowStackProvider reservedRows={1}>
      <SettingsPanel kind="config" ports={{ config: port }} labels={terminalPanelLabels(io.locale)} push={notices => { pushed.push(...notices.map(notice => notice.text)); }}
        onError={error => { failure ??= error; close(); }} errorText={error => String((error as { message?: unknown } | null)?.message ?? error)}
        openApproval={() => { /* The write's own lines name the approval and the command that applies it (printed after close). */ }} onClose={() => close()} />
    </WindowStackProvider>
  </RenderGlyphsContext.Provider></WorklinePaletteProvider>, { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  close = () => view.unmount();
  const abort = () => view.unmount();
  io.signal?.addEventListener('abort', abort, { once: true });
  if (io.signal?.aborted) abort();
  try { await view.waitUntilExit(); } finally { io.signal?.removeEventListener('abort', abort); view.unmount(); }
  if (failure !== null) throw failure;
  return pushed;
};
