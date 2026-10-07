import type { Locale } from '#platform/index.js';
import { createWorklineLedgerPorts as createLedgerPorts, launchTerminal } from '#surfaces/core/cli-terminal/index.js';
import { mcpSlash } from './mcp.js';
import { renderRunCancellation } from './run.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';

/**
 * `deckent terminal …` and bare `deckent` on a TTY: the terminal lives in `cli-terminal` (TERMINAL-LAUNCH); this host binds the commands it
 * needs from the CLI — `doctor`, `/mcp` (only when MCP commands are wired) and the `run cancel` text — over the same command context.
 */
export async function terminalCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  await launchTerminal(argv, context, {
    runKernelCommand: (args, overrides) => runKernelCommand(args, { ...context, ...overrides }),
    ...(context.runMcpCommand ? { mcpSlash: (root: string, args: string, options: Parameters<typeof mcpSlash>[3], locale: Locale) => mcpSlash(root, args, context, options, locale) } : {}),
    renderRunCancellation,
  });
}

/** Terminal ports over the same handlers as the CLI commands, with the CLI's `run cancel` text (the tests' and callers' existing entry). */
export function createWorklineLedgerPorts(input: Omit<Parameters<typeof createLedgerPorts>[0], 'renderRunCancellation'>): ReturnType<typeof createLedgerPorts> {
  return createLedgerPorts({ ...input, renderRunCancellation });
}
