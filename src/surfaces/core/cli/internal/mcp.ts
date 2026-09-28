import { createInterface } from 'node:readline';
import { ErrorRegistry, emit, formatValue, resolveLocale, t } from '#platform/index.js';
import type { ConfigLoadOptions, Locale } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

type Scope = 'local' | 'project' | 'user';
/** One `deckent mcp` request as the host runs it (the adapter's `McpCommandRequest`; the surface does not import adapters). */
export type McpCommandRequest = { readonly verb: 'list'; readonly health?: boolean } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Scope; readonly name: string; readonly entry: unknown; readonly approve?: boolean }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Scope }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk: readonly string[] }
  | { readonly verb: 'reset' | 'reconnect'; readonly name: string };
/** The host's MCP registry command; `ask` shows one trust card (phase `launch`, then `tools`) and answers the owner's decision. */
export type McpCommandHandler = (root: string, request: McpCommandRequest, options: ConfigLoadOptions, ask: (card: unknown) => Promise<boolean | null>) => Promise<unknown>;

const usage = () => ErrorRegistry.createError('CLI_USAGE');
const SCOPES: readonly string[] = ['local', 'project', 'user'];
/**
 * `deckent mcp add [--scope local|project|user] [--transport stdio] [--env KEY=VALUE]… [--realm …] [--timeout-ms n] [--yes|--no-approve] <name> -- <command> [args…]`,
 * `add-json [--scope …] [--yes|--no-approve] <name> '<json>'`, `list`, `get <name>`, `remove <name> [--scope …]`, `approve <name> [--always-ask <tool>]… [--yes]`
 * (MCP-CLIENT, Claude Code's scoped model: default scope local). Adding a local/user server is its trust decision (cards, or --yes); a project
 * entry is asked on first use. Registry files hold servers; trust and pins are product state.
 */
export async function mcpCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const verb = argv[1];
  const rest = argv.slice(2), separator = rest.indexOf('--'), flags = separator < 0 ? rest : rest.slice(0, separator), command = separator < 0 ? [] : rest.slice(separator + 1);
  const positionals: string[] = [], env: Record<string, string> = {}, alwaysAsk: string[] = [];
  let scope: Scope | undefined, json = false, yes = false, noApprove = false, language: string | undefined, realm: string | undefined, timeoutMs: number | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!, value = () => { const next = flags[++i]; if (next === undefined || next.startsWith('--')) throw usage(); return next; };
    if (flag === '--json') json = true;
    else if (flag === '--no-color') continue;
    else if (flag === '--yes' && (verb === 'approve' || verb === 'add' || verb === 'add-json')) yes = true;
    else if (flag === '--no-approve' && (verb === 'add' || verb === 'add-json')) noApprove = true;
    else if (flag === '--lang' && language === undefined) language = value();
    else if ((flag === '--scope' || flag === '-s') && scope === undefined) { const next = value(); if (!SCOPES.includes(next)) throw usage(); scope = next as Scope; }
    else if ((flag === '--transport' || flag === '-t') && verb === 'add') { if (value() !== 'stdio') throw usage(); }
    else if ((flag === '--env' || flag === '-e') && verb === 'add') { const pair = value(), at = pair.indexOf('='); if (at < 1) throw usage(); env[pair.slice(0, at)] = pair.slice(at + 1); }
    else if (flag === '--realm' && verb === 'add' && realm === undefined) realm = value();
    else if (flag === '--timeout-ms' && verb === 'add' && timeoutMs === undefined) { timeoutMs = Number(value()); if (!Number.isSafeInteger(timeoutMs)) throw usage(); }
    else if (flag === '--always-ask' && verb === 'approve') alwaysAsk.push(value());
    else if (flag.startsWith('-')) throw usage();
    else positionals.push(flag);
  }
  const name = positionals[0];
  let request: McpCommandRequest;
  if (verb === 'list' && !positionals.length && !scope && !command.length) request = { verb };
  else if (verb === 'get' && positionals.length === 1 && !scope && !command.length) request = { verb, name: name! };
  else if (verb === 'remove' && positionals.length === 1 && !command.length) request = { verb, name: name!, ...(scope ? { scope } : {}) };
  else if (verb === 'approve' && positionals.length === 1 && !scope && !command.length) request = { verb, name: name!, alwaysAsk };
  else if (verb === 'add' && positionals.length === 1 && command.length > 0) request = { verb, scope: scope ?? 'local', name: name!, approve: !noApprove,
    entry: { type: 'stdio', command: command[0], ...(command.length > 1 ? { args: command.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}),
      ...(realm ? { realm } : {}), ...(timeoutMs ? { timeoutMs } : {}) } };
  else if (verb === 'add-json' && positionals.length === 2 && !command.length) {
    let entry: unknown;
    try { entry = JSON.parse(positionals[1]!); } catch { throw usage(); }
    request = { verb: 'add', scope: scope ?? 'local', name: name!, entry, approve: !noApprove };
  } else throw usage();
  const environment = context.env ?? process.env, locale = resolveLocale(language, environment); context.onLocale?.(locale);
  if (!context.runMcpCommand) throw usage();
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  // A trust decision (approve; add of a personal scope, owner 2026-09-28) needs a terminal for its cards, or --yes; nothing is written before.
  const decides = request.verb === 'approve' || (request.verb === 'add' && request.scope !== 'project' && request.approve !== false);
  if (decides && !yes && !context.stdin?.isTTY) throw ErrorRegistry.createError('MCP_APPROVAL_NEEDS_TERMINAL');
  const ask = async (card: unknown) => {
    if (yes) return true;
    const input = context.stdin!;
    emit(card, { ...sinks, json: false, render: formatValue });
    const question = (card as { phase?: unknown }).phase === 'tools' ? t('cli.mcp.toolsPrompt', {}, locale) : t('cli.mcp.launchPrompt', {}, locale);
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    try { return await new Promise<boolean>(resolve => rl.question(question, answer => resolve(/^y(es)?$/iu.test(answer.trim())))); }
    finally { rl.close(); }
  };
  const result = await context.runMcpCommand(context.root ?? process.cwd(), request, { env: environment }, ask);
  emit(result, { ...sinks, json, render: formatValue });
}

/**
 * `/mcp` in the terminal (MCP-CLIENT, owner 2026-09-28): the servers of this project with their scope and trust state (nothing is started), and
 * `approve <name>` (forget a decline: the next message asks with the trust cards), `reconnect <name>` (the service restarts it on its next use),
 * `remove <name>` (from its registry file; its trust is revoked).
 */
export async function mcpSlash(root: string, args: string, context: CommandContext, options: ConfigLoadOptions, locale: Locale): Promise<readonly string[]> {
  const [verb = 'list', name, ...extra] = args.split(/\s+/u).filter(Boolean);
  const run = (request: McpCommandRequest) => context.runMcpCommand!(root, request, options, async () => null);
  if (extra.length || (verb !== 'list' && !name) || (verb === 'list' && name)) return [t('terminal.mcp.usage', {}, locale)];
  if (verb === 'list') {
    const listed = await run({ verb: 'list', health: false }) as { servers: { name: string; scope: string; status: string; command: string; args: string[]; pinnedTools: number }[];
      problems: { name: string | null; scope: string; reason: string }[] };
    if (!listed.servers.length && !listed.problems.length) return [t('terminal.mcp.none', {}, locale)];
    return [t('terminal.mcp.count', { count: listed.servers.length }, locale), ...listed.servers.map(server => `  ${server.name}  ${server.scope}  ${server.status}${server.pinnedTools ? ` (${server.pinnedTools} tools pinned)` : ''}  ${
      [server.command, ...server.args].join(' ')}`), ...listed.problems.map(problem => `  ! ${problem.scope} ${problem.name ?? '(file)'}: ${problem.reason}`),
    ...(listed.servers.some(server => server.status === 'pending-approval' || server.status === 'changed') ? [`  ${t('terminal.mcp.pendingHint', {}, locale)}`] : [])];
  }
  if (verb === 'approve') { await run({ verb: 'reset', name: name! }); return [t('terminal.mcp.approve', { name: name! }, locale)]; }
  if (verb === 'reconnect') { await run({ verb: 'reconnect', name: name! }); return [t('terminal.mcp.reconnect', { name: name! }, locale)]; }
  if (verb === 'remove') { const removed = await run({ verb: 'remove', name: name! }) as { removed: { scope: string } }; return [t('terminal.mcp.removed', { name: name!, scope: removed.removed.scope }, locale)]; }
  return [t('terminal.mcp.usage', {}, locale)];
}
