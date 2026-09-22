/** Slash command registry — behavior contract; full catalog ports from legacy repl incrementally. */
export interface SlashCommand {
  readonly name: string;
  readonly descriptionKey: string;
  readonly requiresInference?: boolean;
}

export const WORKLINE_SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: 'status', descriptionKey: 'terminal.slash.status', requiresInference: true },
  { name: 'chat-backend', descriptionKey: 'terminal.slash.chatBackend' },
  { name: 'workers', descriptionKey: 'terminal.slash.workers' },
  { name: 'watch-workers', descriptionKey: 'terminal.slash.watchWorkers' },
  { name: 'watch-runs', descriptionKey: 'terminal.slash.watchRuns' },
  { name: 'watch-stop', descriptionKey: 'terminal.slash.watchStop' },
  { name: 'run', descriptionKey: 'terminal.slash.run' },
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
