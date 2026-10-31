import { colorCapability, loadConfigTerminalLaunch } from '#platform/index.js';
import { terminalPalette, TERMINAL_THEME_SETTINGS } from '#surfaces/core/terminal-kit/index.js';
import { prefersAsciiGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { SettingsPanel } from '#surfaces/core/terminal-provider/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import type { ConfigPanelOpener } from '#surfaces/core/config/index.js';

import { openTerminalHost } from '#surfaces/core/terminal-host/index.js';

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
  const presentation = await loadConfigTerminalLaunch(process.cwd(), { env: io.env }).catch(() => null);
  if (io.signal?.aborted) return pushed;
  const setting = TERMINAL_THEME_SETTINGS.find(value => value === presentation?.terminal['theme']) ?? TERMINAL_THEME_SETTINGS[0];
  const theme = { setting, capability: colorCapability({ env: io.env, isTTY: true, argv: process.argv }), colorfgbg: io.env['COLORFGBG'] };
  let close = () => {};
  const host = await openTerminalHost({ palette: terminalPalette(setting, theme.capability, theme.colorfgbg), theme, stdout: io.stdout, stdin: io.stdin,
    ...(io.signal ? { signal: io.signal } : {}), ascii: prefersAsciiGlyphs(io.env), clearScreen: false, fullscreen: false,
    view: () =>
    <WindowStackProvider reservedRows={1}>
      <SettingsPanel kind="config" ports={{ config: port }} labels={terminalPanelLabels(io.locale)} push={notices => { pushed.push(...notices.map(notice => notice.text)); }}
        onError={error => { failure ??= error; close(); }} errorText={error => String((error as { message?: unknown } | null)?.message ?? error)}
        openApproval={() => { /* The write's own lines name the approval and the command that applies it (printed after close). */ }} onClose={() => close()} />
    </WindowStackProvider>
  });
  close = () => { void host.close(); };
  try { await host.wait(); } finally { await host.close(); }
  if (failure !== null) throw failure;
  return pushed;
};
