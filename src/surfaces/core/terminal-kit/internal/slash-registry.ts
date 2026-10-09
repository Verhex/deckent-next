/** Slash command registry — behavior contract; full catalog ports from legacy repl incrementally. */
export interface SlashCommand {
  readonly name: string;
  readonly descriptionKey: string;
  /** Help group (`SLASH_GROUPS`); a command without one is listed last under the "other" heading. */
  readonly group?: SlashGroupId;
  /** Catalog key of the argument hint; set only for commands that take an argument. Enter on such a palette row completes
   * `/name ` and waits for the argument; a command without one runs at once. */
  readonly argumentKey?: string;
}

/** The groups `/help` lists commands under, in display order; each heading is a catalog text (`labelKey`). */
export const SLASH_GROUPS = Object.freeze([
  { id: 'info', labelKey: 'terminal.slash.group.info' }, { id: 'work', labelKey: 'terminal.slash.group.work' }, { id: 'approvals', labelKey: 'terminal.slash.group.approvals' },
  { id: 'settings', labelKey: 'terminal.slash.group.settings' }, { id: 'session', labelKey: 'terminal.slash.group.session' }, { id: 'other', labelKey: 'terminal.slash.group.other' },
] as const);
export type SlashGroupId = typeof SLASH_GROUPS[number]['id'];

export const WORKLINE_SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: 'status', group: 'info', descriptionKey: 'terminal.slash.status' },
  { name: 'workers', group: 'work', descriptionKey: 'terminal.slash.workers' },
  { name: 'watch-workers', group: 'work', descriptionKey: 'terminal.slash.watchWorkers' },
  { name: 'watch-runs', group: 'work', descriptionKey: 'terminal.slash.watchRuns' },
  { name: 'watch-stop', group: 'work', descriptionKey: 'terminal.slash.watchStop' },
  // T3 L5: one window over the observed workers and runs (read-only; stopping a Run stays `/cancel`'s confirmation window).
  { name: 'tasks', group: 'work', descriptionKey: 'terminal.slash.tasks' },
  { name: 'run', group: 'work', descriptionKey: 'terminal.slash.run', argumentKey: 'terminal.slash.runArgument' },
  { name: 'runs', group: 'work', descriptionKey: 'terminal.slash.runs' },
  { name: 'transcript', group: 'work', descriptionKey: 'terminal.slash.transcript', argumentKey: 'terminal.slash.transcriptArgument' },
  { name: 'approvals', group: 'approvals', descriptionKey: 'terminal.slash.approvals', argumentKey: 'terminal.slash.approvalsArgument' },
  { name: 'cancel', group: 'work', descriptionKey: 'terminal.slash.cancel', argumentKey: 'terminal.slash.cancelArgument' },
  { name: 'service-restart', group: 'settings', descriptionKey: 'terminal.slash.serviceRestart' },
  { name: 'context', group: 'info', descriptionKey: 'terminal.slash.context' },
  { name: 'resume', group: 'session', descriptionKey: 'terminal.slash.resume', argumentKey: 'terminal.slash.resumeArgument' },
  { name: 'clear', group: 'session', descriptionKey: 'terminal.slash.clear' },
  { name: 'mode', group: 'settings', descriptionKey: 'terminal.slash.mode', argumentKey: 'terminal.slash.modeArgument' },
  // TL-A D6: shows or hides the reasoning preview (toggle, or `on`/`off`); runs at once from the palette.
  { name: 'reasoning', group: 'settings', descriptionKey: 'terminal.slash.reasoning' },
  // SCR-A: lists the conversation's scratch area (`/scratch path`, `/scratch clear` typed); runs at once from the palette.
  { name: 'scratch', group: 'session', descriptionKey: 'terminal.slash.scratch' },
  // MCP-CLIENT: the project's MCP servers (`/mcp approve|reconnect|remove <name>` typed); runs at once from the palette.
  { name: 'mcp', group: 'settings', descriptionKey: 'terminal.slash.mcp' },
  // MONITOR: the monitor's text snapshot (Runs, blockers, workers, approvals, pools, installs); `deckent monitor` is the fullscreen view.
  { name: 'config', group: 'settings', descriptionKey: 'config.surface.slashDescription' },
  // T4 PROVIDER-CONNECT: connect a provider (masked key, free check, secret store) or disconnect it; a window only.
  { name: 'provider', group: 'settings', descriptionKey: 'terminal.slash.provider' },
  { name: 'monitor', group: 'info', descriptionKey: 'terminal.slash.monitor' },
  // TERMINAL-CLOSE S09 (read-only management): each runs at once from the palette and reads a typed query on every call.
  { name: 'model', group: 'info', descriptionKey: 'terminal.slash.model' },
  { name: 'usage', group: 'info', descriptionKey: 'terminal.slash.usage' },
  { name: 'doctor', group: 'info', descriptionKey: 'terminal.slash.doctor' },
  { name: 'scope', group: 'info', descriptionKey: 'terminal.slash.scope' },
  { name: 'exit', group: 'session', descriptionKey: 'terminal.slash.exit' },
  { name: 'quit', group: 'session', descriptionKey: 'terminal.slash.exit' },
  { name: 'help', group: 'info', descriptionKey: 'terminal.slash.help' },
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
  readonly reasoningUnmeasured: number; readonly cache?: SessionCacheUsage;
  readonly models?: readonly Readonly<{ model: string; provider: string; reports: number; promptTokens: number; completionTokens: number }>[] }
/** CACHE-SLICE1: raw cache classes summed over the measured reports, and the same-request net benefit (USD x 1e10) over the reports that carried
 * one (`benefitReports`); an unknown benefit is never counted as zero. */
export interface SessionCacheUsage { readonly reports: number; readonly readTokens: number; readonly writeTokens: number; readonly promptTokens: number;
  readonly write5mTokens: number; readonly write1hTokens: number; readonly netBenefitUsdE10: number; readonly benefitReports: number }
type ReportCache = Readonly<{ readTokens: number; writeTokens: number; promptTokens: number; write5mTokens?: number; write1hTokens?: number; netBenefitUsdE10?: number | null }>;
export const EMPTY_SESSION_USAGE: SessionUsageView = Object.freeze({ reports: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, reasoningUnmeasured: 0 });
export function addSessionUsage(total: SessionUsageView, report: Readonly<{ promptTokens: number; completionTokens: number; reasoningTokens: number | null; cache?: ReportCache;
  identity?: Readonly<{ model: string; provider: string }> | undefined }>): SessionUsageView {
  const cache = report.cache, benefit = typeof cache?.netBenefitUsdE10 === 'number' ? cache.netBenefitUsdE10 : null;
  const models = [...(total.models ?? [])], identity = report.identity;
  if (identity) {
    const at = models.findIndex(row => row.model === identity.model && row.provider === identity.provider);
    const previous = models[at];
    const row = Object.freeze({ ...identity, reports: (previous?.reports ?? 0) + 1,
      promptTokens: (previous?.promptTokens ?? 0) + report.promptTokens, completionTokens: (previous?.completionTokens ?? 0) + report.completionTokens });
    if (at < 0) models.push(row); else models[at] = row;
  }
  return Object.freeze({ reports: total.reports + 1, promptTokens: total.promptTokens + report.promptTokens, completionTokens: total.completionTokens + report.completionTokens,
    ...(models.length ? { models: Object.freeze(models) } : {}),
    reasoningTokens: total.reasoningTokens + (report.reasoningTokens ?? 0), reasoningUnmeasured: total.reasoningUnmeasured + (report.reasoningTokens === null ? 1 : 0),
    cache: { reports: (total.cache?.reports ?? 0) + (cache ? 1 : 0), readTokens: (total.cache?.readTokens ?? 0) + (cache?.readTokens ?? 0),
      writeTokens: (total.cache?.writeTokens ?? 0) + (cache?.writeTokens ?? 0), promptTokens: (total.cache?.promptTokens ?? 0) + (cache?.promptTokens ?? 0),
      write5mTokens: (total.cache?.write5mTokens ?? 0) + (cache?.write5mTokens ?? 0), write1hTokens: (total.cache?.write1hTokens ?? 0) + (cache?.write1hTokens ?? 0),
      netBenefitUsdE10: (total.cache?.netBenefitUsdE10 ?? 0) + (benefit ?? 0), benefitReports: (total.cache?.benefitReports ?? 0) + (benefit === null ? 0 : 1) } });
}
/** `/status` without a fresh port keeps the launch-time line; with one, a failed read shows its typed error, never that old line. */
/** `sessionFullAccess` (Astra 2431 P2): this session holds full access (launched so, or switched into for this session only). */
export type InspectSlashPort = (args: string, view: Readonly<{ usage: SessionUsageView; sessionFullAccess?: boolean }>) => Promise<readonly string[]>;
export type InspectSlashPorts = Readonly<Partial<Record<InspectSlashCommand, InspectSlashPort>>>;
/** The ports as plain `(args)` commands, each given the usage the terminal measured at call time. */
export function bindInspectPorts(ports: InspectSlashPorts | undefined, usage: () => SessionUsageView, sessionFullAccess: () => boolean = () => false):
  Readonly<Record<string, (args: string) => Promise<readonly string[]>>> {
  return Object.fromEntries(Object.entries(ports ?? {}).map(([name, port]) => [name, (args: string) => port(args, { usage: usage(), sessionFullAccess: sessionFullAccess() })]));
}

/** Display labels only; the original registry name and argument metadata still own completion/dispatch. */
export function slashCommandRow(command: SlashCommand, labels: Readonly<Record<string, string>>): Readonly<{ name: string; detail: string }> {
  const argument = command.argumentKey ? labels[command.argumentKey] : undefined;
  return { name: `/${command.name}${argument ? ` ${argument}` : ''}`, detail: labels[command.descriptionKey] ?? '' };
}

/** The catalog key of the first `/help` line (a title, so a level word such as `Info:` never sits in front of a group heading). */
export const SLASH_HELP_TITLE_KEY = 'terminal.slash.helpTitle';

/** `/help`: a title, then the registry rows under their group headings (one line per command), so the palette and the help share the same row text. */
export function slashHelpText(labels: Readonly<Record<string, string>>, commands: readonly SlashCommand[] = WORKLINE_SLASH_COMMANDS): string {
  const groups = SLASH_GROUPS.flatMap(group => {
    const members = commands.filter(command => (command.group ?? 'other') === group.id);
    if (members.length === 0) return [];
    const rows = members.map(command => { const row = slashCommandRow(command, labels); return `  ${row.name}${row.detail ? `  ${row.detail}` : ''}`; });
    return [[labels[group.labelKey] ?? group.id, ...rows].join('\n')];
  }).join('\n\n');
  return labels[SLASH_HELP_TITLE_KEY] ? `${labels[SLASH_HELP_TITLE_KEY]}\n${groups}` : groups;
}

export function parseSlashLine(line: string): { command: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(' ');
  if (space < 0) return { command: body.toLowerCase(), args: '' };
  return { command: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() };
}
