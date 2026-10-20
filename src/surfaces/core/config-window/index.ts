import type { ConfigPanelOpener } from '#surfaces/core/config/index.js';
/**
 * C-SETUP: the terminal's `/config` window mounted on its own for `deckent config` on a person's terminal (one implementation, owner
 * 2026-10-19). The view (Ink) loads only here, after the TTY decision: the CLI start never reaches Ink (startup-graph test).
 */
export const openConfigWindow: ConfigPanelOpener = async (port, io) => (await import('./internal/window.js')).mountConfigPanel(port, io);
