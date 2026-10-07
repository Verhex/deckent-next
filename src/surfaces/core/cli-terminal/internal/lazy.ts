import type { TerminalLaunchContext, TerminalLaunchPorts } from './context.js';

/**
 * The interactive terminal and its line mode (`deckent`, `deckent terminal …`). The launch module reaches the Ink workline, so it loads
 * only here (STARTUP-COST): this unit's barrel stays on every command's static path for the ledger ports and the handler types.
 */
export async function launchTerminal(argv: readonly string[], context: TerminalLaunchContext, ports: TerminalLaunchPorts): Promise<void> {
  await (await import('./terminal.js')).terminalCommand(argv, context, ports);
}
