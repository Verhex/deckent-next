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
  { name: 'approvals', descriptionKey: 'terminal.slash.approvals', argumentKey: 'terminal.slash.approvalsArgument' },
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
  // TERMINAL-CLOSE S09 (read-only management): each runs at once from the palette and reads a typed query on every call.
  { name: 'model', descriptionKey: 'terminal.slash.model' },
  { name: 'usage', descriptionKey: 'terminal.slash.usage' },
  { name: 'doctor', descriptionKey: 'terminal.slash.doctor' },
  { name: 'scope', descriptionKey: 'terminal.slash.scope' },
  { name: 'exit', descriptionKey: 'terminal.slash.exit' },
  { name: 'quit', descriptionKey: 'terminal.slash.exit' },
  { name: 'help', descriptionKey: 'terminal.slash.help' },
]);

/** Read-only inspect commands (S09). Each is answered by an optional port that re-reads a typed query per call; `status` keeps its static line without one. */
export const INSPECT_SLASH_COMMANDS = Object.freeze(['status', 'model', 'usage', 'doctor', 'scope'] as const);
export type InspectSlashCommand = typeof INSPECT_SLASH_COMMANDS[number];
export function isInspectSlashCommand(command: string): command is InspectSlashCommand {
  return (INSPECT_SLASH_COMMANDS as readonly string[]).includes(command);
}
/** What this terminal itself measured for the open conversation (typed `usage` stream events); not a billing statement.
 * `reasoningTokens` sums only the reports that carried a reasoning count; `reasoningUnmeasured` counts the reports that did not, so an
 * unreported value stays unknown instead of reading as zero (P2-3a). */
export interface SessionUsageView { readonly reports: number; readonly promptTokens: number; readonly completionTokens: number; readonly reasoningTokens: number;
  readonly reasoningUnmeasured: number }
export const EMPTY_SESSION_USAGE: SessionUsageView = Object.freeze({ reports: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, reasoningUnmeasured: 0 });
export function addSessionUsage(total: SessionUsageView, report: Readonly<{ promptTokens: number; completionTokens: number; reasoningTokens: number | null }>): SessionUsageView {
  return Object.freeze({ reports: total.reports + 1, promptTokens: total.promptTokens + report.promptTokens, completionTokens: total.completionTokens + report.completionTokens,
    reasoningTokens: total.reasoningTokens + (report.reasoningTokens ?? 0), reasoningUnmeasured: total.reasoningUnmeasured + (report.reasoningTokens === null ? 1 : 0) });
}
/** `/status` without a fresh port keeps the launch-time line; with one, a failed read shows its typed error, never that old line. */
export type InspectSlashPort = (args: string, view: Readonly<{ usage: SessionUsageView }>) => Promise<readonly string[]>;
export type InspectSlashPorts = Readonly<Partial<Record<InspectSlashCommand, InspectSlashPort>>>;
/** The ports as plain `(args)` commands, each given the usage the terminal measured at call time. */
export function bindInspectPorts(ports: InspectSlashPorts | undefined, usage: () => SessionUsageView): Readonly<Record<string, (args: string) => Promise<readonly string[]>>> {
  return Object.fromEntries(Object.entries(ports ?? {}).map(([name, port]) => [name, (args: string) => port(args, { usage: usage() })]));
}

/** Display labels only; the original registry name and argument metadata still own completion/dispatch. */
export function slashCommandRow(command: SlashCommand, labels: Readonly<Record<string, string>>): Readonly<{ name: string; detail: string }> {
  const argument = command.argumentKey ? labels[command.argumentKey] : undefined;
  return { name: `/${command.name}${argument ? ` ${argument}` : ''}`, detail: labels[command.descriptionKey] ?? '' };
}

export function slashHelpText(labels: Readonly<Record<string, string>>, commands: readonly SlashCommand[] = WORKLINE_SLASH_COMMANDS): string {
  return commands.map(command => {
    const row = slashCommandRow(command, labels);
    return `${row.name}${row.detail ? `  ${row.detail}` : ''}`;
  }).join('\n');
}

export function parseSlashLine(line: string): { command: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(' ');
  if (space < 0) return { command: body.toLowerCase(), args: '' };
  return { command: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() };
}
