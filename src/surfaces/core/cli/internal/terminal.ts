import type { Locale } from '#platform/index.js';
import { launchTerminal } from '#surfaces/core/cli-terminal/index.js';
import { mcpSlash } from './mcp.js';
import { renderRunCancellation } from '#surfaces/core/cli-run/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';

/**
 * `deckent terminal …` and bare `deckent` on a TTY: the terminal lives in `cli-terminal` (TERMINAL-LAUNCH); this host binds the commands it
 * needs from the CLI — `doctor`, `/mcp` (only when MCP commands are wired) and the `run cancel` text — over the same command context.
 */
export async function terminalCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  await launchTerminal(argv, context, {
    runKernelCommand: (args, overrides) => runKernelCommand(args, { ...context, ...overrides }),
    ...(context.runMcpCommand ? { mcpSlash: (root: string, args: string, options: Parameters<typeof mcpSlash>[3], locale: Locale) => mcpSlash(root, args, context, options, locale),
      runMcp: context.runMcpCommand } : {}),
    foregroundSetup: async (root, stage, scopeId, locale) => (await import('#surfaces/core/setup/index.js')).runForegroundStage(context, root, stage, scopeId, locale),
    renderRunCancellation,
  });
}
