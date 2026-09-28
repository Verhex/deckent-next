import { createInterface } from 'node:readline';
import { ErrorRegistry, emit, formatValue, resolveLocale } from '#platform/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

type Scope = 'local' | 'project' | 'user';
/** One `deckent mcp` request as the host runs it (the adapter's `McpCommandRequest`; the surface does not import adapters). */
export type McpCommandRequest = { readonly verb: 'list' } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Scope; readonly name: string; readonly entry: unknown }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Scope }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk: readonly string[] };
/** The host's MCP registry command; `confirm` shows the approval card and answers the owner's decision. */
export type McpCommandHandler = (root: string, request: McpCommandRequest, options: ConfigLoadOptions, confirm: (card: unknown) => Promise<boolean>) => Promise<unknown>;

const usage = () => ErrorRegistry.createError('CLI_USAGE');
const SCOPES: readonly string[] = ['local', 'project', 'user'];
/**
 * `deckent mcp add [--scope local|project|user] [--transport stdio] [--env KEY=VALUE]… [--realm …] [--timeout-ms n] <name> -- <command> [args…]`,
 * `add-json [--scope …] <name> '<json>'`, `list`, `get <name>`, `remove <name> [--scope …]`, `approve <name> [--always-ask <tool>]… [--yes]`
 * (MCP-CLIENT, Claude Code's scoped model: default scope local). Registry files hold servers; approval and pins are product state.
 */
export async function mcpCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const verb = argv[1];
  const rest = argv.slice(2), separator = rest.indexOf('--'), flags = separator < 0 ? rest : rest.slice(0, separator), command = separator < 0 ? [] : rest.slice(separator + 1);
  const positionals: string[] = [], env: Record<string, string> = {}, alwaysAsk: string[] = [];
  let scope: Scope | undefined, json = false, yes = false, language: string | undefined, realm: string | undefined, timeoutMs: number | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!, value = () => { const next = flags[++i]; if (next === undefined || next.startsWith('--')) throw usage(); return next; };
    if (flag === '--json') json = true;
    else if (flag === '--no-color') continue;
    else if (flag === '--yes' && verb === 'approve') yes = true;
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
  else if (verb === 'add' && positionals.length === 1 && command.length > 0) request = { verb, scope: scope ?? 'local', name: name!, entry: { type: 'stdio', command: command[0],
    ...(command.length > 1 ? { args: command.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}), ...(realm ? { realm } : {}), ...(timeoutMs ? { timeoutMs } : {}) } };
  else if (verb === 'add-json' && positionals.length === 2 && !command.length) {
    let entry: unknown;
    try { entry = JSON.parse(positionals[1]!); } catch { throw usage(); }
    request = { verb: 'add', scope: scope ?? 'local', name: name!, entry };
  } else throw usage();
  const environment = context.env ?? process.env; context.onLocale?.(resolveLocale(language, environment));
  if (!context.runMcpCommand) throw usage();
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const confirm = async (card: unknown) => {
    if (yes) return true;
    const input = context.stdin;
    // No terminal to ask on: the owner passes --yes after reading `deckent mcp get` (never an implicit approval).
    if (!input?.isTTY) throw ErrorRegistry.createError('MCP_APPROVAL_NEEDS_TERMINAL');
    emit(card, { ...sinks, json: false, render: formatValue });
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    try { return await new Promise<boolean>(resolve => rl.question('Approve this MCP server and pin its tools? [y/N] ', answer => resolve(/^y(es)?$/iu.test(answer.trim())))); }
    finally { rl.close(); }
  };
  const result = await context.runMcpCommand(context.root ?? process.cwd(), request, { env: environment }, confirm);
  emit(result, { ...sinks, json, render: formatValue });
}
