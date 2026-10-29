import { emit, getConfigFieldDefault, loadConfig, t, terminalSafeText, type Locale } from '#platform/index.js';
import { askCliCard, cliTableStyle, orderPendingFirst, renderCliTable, type CliCardOption, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { mcpServerStateWord, mcpTrustQuestion } from '#surfaces/core/cli-terminal/index.js';
import type { CommandContext } from './kernel-commands.js';

/** One server as `mcp list` returns it (adapter summary + health); only the fields a person reads. */
export type McpListedServer = Readonly<{ name: string; scope: string; status: string; reason?: string; realm?: string | null; transport?: string; command?: string;
  args?: readonly string[]; envNames?: readonly string[]; headerNames?: readonly string[]; pinnedTools?: number; health?: string; failure?: string;
  lastStart?: Readonly<{ text?: string }>; definitionDigest?: string }>;
type Problem = Readonly<{ name: string | null; scope: string; reason: string }>;

/** Display text of a registry value: escapes inert, line breaks shown as `\n` (SEC-2 F3: a repository writes these values). */
export const mcpSafe = (text: unknown): string => terminalSafeText(String(text ?? '')).replace(/\n/gu, '\\n');
export const mcpScopeWord = (scope: string, locale: Locale): string => scope === 'local' ? t('terminal.mcp.scope.local', {}, locale)
  : scope === 'project' ? t('terminal.mcp.scope.project', {}, locale) : scope === 'user' ? t('terminal.mcp.scope.user', {}, locale) : mcpSafe(scope);
const waiting = (server: McpListedServer) => server.status !== 'trusted';
/** A server's state in words: the one renderer shared with the `/mcp` window (`mcpServerStateWord`), terminal-safe. */
export const mcpStateWord = (server: McpListedServer, locale: Locale): string => mcpSafe(mcpServerStateWord(server, locale));
/** The connection column: only `--check` starts anything, and only trusted servers (owner review: a deliberate difference from Claude Code). */
function connectionWord(server: McpListedServer, checked: boolean, locale: Locale): string {
  if (!checked) return t('climodels.mcp.connection.unchecked', {}, locale);
  if (server.health === 'connected') return t('climodels.mcp.connection.connected', {}, locale);
  if (server.health === 'tools-changed') return t('climodels.mcp.connection.toolsChanged', {}, locale);
  if (server.health === 'failed') return t('climodels.mcp.connection.failed', { reason: mcpSafe(server.failure ?? '-') }, locale);
  return waiting(server) && server.status !== 'invalid-launch' ? t('climodels.mcp.connection.untrusted', {}, locale) : t('climodels.mcp.connection.notStarted', {}, locale);
}
export const mcpLaunchText = (server: Pick<McpListedServer, 'command' | 'args'>): string => [server.command ?? '', ...(server.args ?? [])].map(mcpSafe).join(' ');

/** `mcp list` for a person: one table, servers that wait for someone first, each with its next step; problems and the check rule after it. */
export function renderMcpList(value: unknown, checked: boolean, locale: Locale, context: Pick<CommandContext, 'env' | 'stdout'>): string {
  const listed = (value ?? {}) as { servers?: readonly McpListedServer[]; problems?: readonly Problem[] };
  const servers = orderPendingFirst(listed.servers ?? [], { pending: waiting, time: () => null }), problems = listed.problems ?? [];
  if (!servers.length && !problems.length) return t('terminal.mcp.none', {}, locale);
  const columns = [{ header: t('climodels.mcp.table.name', {}, locale), shrink: false }, { header: t('climodels.mcp.table.scope', {}, locale), shrink: false },
    { header: t('climodels.mcp.table.state', {}, locale) }, { header: t('climodels.mcp.table.connection', {}, locale) }, { header: t('climodels.mcp.table.launch', {}, locale) }];
  const rows = servers.map(server => [server.name, mcpScopeWord(server.scope, locale), mcpStateWord(server, locale), connectionWord(server, checked, locale), mcpLaunchText(server)]);
  const next = servers.filter(waiting).filter(server => server.status !== 'trust-store-unavailable' && server.status !== 'invalid-launch')
    .map(server => `  ${mcpNextStep(server, locale)}`);
  const failures = servers.filter(server => server.lastStart?.text).map(server => `  ! ${mcpSafe(server.name)}: ${mcpSafe(server.lastStart!.text)}`);
  return [t('terminal.mcp.count', { count: servers.length }, locale), renderCliTable(columns, rows, cliTableStyle(context)),
    ...(next.length ? ['', t('climodels.mcp.next.heading', {}, locale), ...next] : []), ...failures,
    ...problems.map(problem => `  ! ${problem.name === null ? t('terminal.mcp.problemFile', { scope: mcpScopeWord(problem.scope, locale), reason: mcpSafe(problem.reason) }, locale)
      : t('terminal.mcp.problemServer', { name: mcpSafe(problem.name), scope: mcpScopeWord(problem.scope, locale), reason: mcpSafe(problem.reason) }, locale)}`),
    ...(checked ? [] : ['', t('climodels.mcp.checkHint', {}, locale)])].join('\n');
}

/** The next step of a waiting server: its card (a record trusted before alpha.48 says why it asks again; `--yes` is not accepted for it). */
const mcpNextStep = (server: McpListedServer, locale: Locale) => server.reason === 'trust-moved'
  ? t('climodels.mcp.next.moved', { name: mcpSafe(server.name) }, locale) : t('climodels.mcp.next.approve', { name: mcpSafe(server.name) }, locale);
/** `mcp get <name>` for a person: one field per line, values terminal-safe, the next step for a waiting server. */
export function renderMcpServer(value: unknown, locale: Locale): string {
  const server = ((value ?? {}) as { server?: McpListedServer }).server;
  if (!server) return '';
  const http = server.transport === 'http', none = t('climodels.mcp.none', {}, locale), names = ((http ? server.headerNames : server.envNames) ?? []).map(mcpSafe).join(', ') || none;
  return [`${t('climodels.mcp.field.name', {}, locale)}: ${mcpSafe(server.name)}`, `${t('climodels.mcp.field.scope', {}, locale)}: ${mcpScopeWord(server.scope, locale)}`,
    `${t('climodels.mcp.field.state', {}, locale)}: ${mcpStateWord(server, locale)}`,
    http ? `${t('climodels.mcp.field.url', {}, locale)}: ${mcpLaunchText(server)}` : `${t('climodels.mcp.field.command', {}, locale)}: ${mcpLaunchText(server)}`,
    ...(http ? [] : [`${t('climodels.mcp.field.realm', {}, locale)}: ${mcpSafe(server.realm ?? '-')}`]),
    http ? `${t('climodels.mcp.field.headers', {}, locale)}: ${names}` : `${t('climodels.mcp.field.env', {}, locale)}: ${names}`,
    `${t('climodels.mcp.field.tools', {}, locale)}: ${server.pinnedTools ?? 0}`, `${t('climodels.mcp.field.definition', {}, locale)}: ${mcpSafe((server.definitionDigest ?? '').slice(0, 12))}`,
    ...(waiting(server) ? [mcpNextStep(server, locale)] : [])].join('\n');
}

/** The trust card's body: the terminal window's localized fields, one per line, each argument on its own line (SEC-2 F3, one renderer). */
export function mcpTrustCard(raw: unknown, locale: Locale): CliCardRequest {
  const shown = mcpTrustQuestion(raw, locale), { command, args } = raw as { command?: unknown; args?: unknown };
  const argv = Array.isArray(args) ? args.map(String) : [], launch = argv.length ? [String(command ?? ''), ...argv].join(' ') : null;
  const body = shown.lines.flatMap(line => line.text === launch
    ? [`${mcpSafe(line.label)}: ${mcpSafe(command)}`, ...argv.map((value, index) => `  ${t('security.mcp.trustCard.argument', { index: index + 1, value: mcpSafe(value) }, locale)}`)]
    : [line.label ? `${mcpSafe(line.label)}: ${mcpSafe(line.text)}` : `  ${mcpSafe(line.text)}`]);
  const note = (raw as { note?: unknown }).note;
  return { title: mcpSafe(shown.title), body: [...body, ...(typeof note === 'string' && note ? [mcpSafe(note)] : [])],
    options: [{ id: 'yes', label: t('climodels.card.yes', {}, locale), role: 'yes' }, { id: 'no', label: t('climodels.card.no', {}, locale), role: 'no' }] };
}

/** One card on the person's terminal, bounded by the session approval time (silence answers nothing); null = cancelled, nothing applies. */
export async function askMcpCard(context: CommandContext, locale: Locale, request: CliCardRequest): Promise<string | null> {
  const env = context.env ?? process.env;
  const ttlMs = await loadConfig(context.root ?? process.cwd(), { env, heal: false }).then(config => config.approvals.sessionTtlMs, () => getConfigFieldDefault('approvals').sessionTtlMs);
  return askCliCard(request, { locale, env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
    ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
}
export const mcpConfirmOptions = (locale: Locale): readonly CliCardOption[] => [{ id: 'apply', label: t('climodels.card.apply', {}, locale), role: 'yes' },
  { id: 'cancel', label: t('climodels.card.cancel', {}, locale), role: 'no' }];
export const mcpCancelled = (context: CommandContext, locale: Locale): void => {
  emit(t('climodels.card.cancelled', {}, locale), { level: 'warning', ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
};
