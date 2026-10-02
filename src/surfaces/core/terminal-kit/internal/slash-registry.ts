/** Slash command registry — behavior contract; full catalog ports from legacy repl incrementally. */
export interface SlashCommand {
  readonly name: string;
  readonly descriptionKey: string;
  /** Catalog key of the argument hint; set only for commands that take an argument. Enter on such a palette row completes
   * `/name ` and waits for the argument; a command without one runs at once. */
  readonly argumentKey?: string;
}

export const WORKLINE_SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: 'status', descriptionKey: 'terminal.slash.status' },
  { name: 'workers', descriptionKey: 'terminal.slash.workers' },
  { name: 'watch-workers', descriptionKey: 'terminal.slash.watchWorkers' },
  { name: 'watch-runs', descriptionKey: 'terminal.slash.watchRuns' },
  { name: 'watch-stop', descriptionKey: 'terminal.slash.watchStop' },
  { name: 'run', descriptionKey: 'terminal.slash.run', argumentKey: 'terminal.slash.runArgument' },
  { name: 'runs', descriptionKey: 'terminal.slash.runs' },
  { name: 'transcript', descriptionKey: 'terminal.slash.transcript', argumentKey: 'terminal.slash.transcriptArgument' },
  { name: 'approvals', descriptionKey: 'terminal.slash.approvals' },
  { name: 'cancel', descriptionKey: 'terminal.slash.cancel', argumentKey: 'terminal.slash.cancelArgument' },
  { name: 'service-restart', descriptionKey: 'terminal.slash.serviceRestart' },
  { name: 'context', descriptionKey: 'terminal.slash.context' },
  { name: 'resume', descriptionKey: 'terminal.slash.resume', argumentKey: 'terminal.slash.resumeArgument' },
  { name: 'clear', descriptionKey: 'terminal.slash.clear' },
  { name: 'mode', descriptionKey: 'terminal.slash.mode', argumentKey: 'terminal.slash.modeArgument' },
  // TL-A D6: shows or hides the reasoning preview (toggle, or `on`/`off`); runs at once from the palette.
  { name: 'reasoning', descriptionKey: 'terminal.slash.reasoning' },
  // SCR-A: lists the conversation's scratch area (`/scratch path`, `/scratch clear` typed); runs at once from the palette.
  { name: 'scratch', descriptionKey: 'terminal.slash.scratch' },
  // MCP-CLIENT: the project's MCP servers (`/mcp approve|reconnect|remove <name>` typed); runs at once from the palette.
  { name: 'mcp', descriptionKey: 'terminal.slash.mcp' },
  // MONITOR: the monitor's text snapshot (Runs, blockers, workers, approvals, pools, installs); `deckent monitor` is the fullscreen view.
  { name: 'config', descriptionKey: 'config.surface.slashDescription' },
  { name: 'monitor', descriptionKey: 'terminal.slash.monitor' },
  { name: 'exit', descriptionKey: 'terminal.slash.exit' },
  { name: 'quit', descriptionKey: 'terminal.slash.exit' },
  { name: 'help', descriptionKey: 'terminal.slash.help' },
]);

export function parseSlashLine(line: string): { command: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(' ');
  if (space < 0) return { command: body.toLowerCase(), args: '' };
  return { command: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() };
}
