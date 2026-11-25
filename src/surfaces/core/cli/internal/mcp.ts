import { createInterface } from 'node:readline/promises';
import { ErrorRegistry, EXIT_CODES, emit, formatValue, t, type ExitCode } from '#platform/index.js';
import type { ConfigLoadOptions, Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, type CliCardOption } from '#surfaces/core/cli-human/index.js';
import { mcpGrantLine, mcpGrantWithdrawalLine, mcpRemoveLines, mcpRevokeLines } from '#surfaces/core/mcp-presentation/index.js';
import type { CommandContext } from './kernel-commands.js';
import { askMcpCard, mcpCancelled, mcpConfirmOptions, mcpLaunchText, mcpSafe, mcpScopeWord, mcpStateWord, mcpTrustCard, renderMcpList, renderMcpServer,
  type McpListedServer } from './mcp-view.js';

type Scope = 'local' | 'project' | 'user';
type McpSelection = Pick<McpListedServer, 'scope' | 'definitionDigest'>;
/** One `deckent mcp` request as the host runs it (the adapter's `McpCommandRequest`; the surface does not import adapters). */
export type McpCommandRequest = { readonly verb: 'list'; readonly health?: boolean } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Scope; readonly name: string; readonly entry: unknown; readonly approve?: boolean }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Scope; readonly selected?: McpSelection }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk?: readonly string[] | undefined; readonly unattended?: boolean }
  | { readonly verb: 'reset' | 'reconnect'; readonly name: string }
  | { readonly verb: 'revoke'; readonly name: string; readonly selected?: McpSelection }
  | { readonly verb: 'import'; readonly from: 'claude-code' | 'claude-desktop' | { readonly file: string }; readonly scope?: 'local' | 'user' };
/** The host's MCP registry command; `ask` shows one trust card (phase `launch`, then `tools`) and answers the owner's decision; `locale` is this
 * surface's (the host renders `lastStart.text` in it). */
export type McpCommandHandler = (root: string, request: McpCommandRequest, options: ConfigLoadOptions, ask: (card: unknown) => Promise<boolean | null>,
  locale?: Locale) => Promise<unknown>;

const usage = () => ErrorRegistry.createError('CLI_USAGE');
const SCOPES: readonly string[] = ['local', 'project', 'user'];
/**
 * `deckent mcp add [--scope local|project|user] [--transport stdio] [--env KEY=VALUE]… [--realm …] [--timeout-ms n] [--no-approve] <name> -- <command> [args…]`
 * or `add [--transport http] [--header 'Key: value']… <name> <url>` (Streamable HTTP; a URL second argument implies http),
 * `add-json [--scope …] [--no-approve] <name> '<json>'`, `list [--check]`, `get <name>`, `remove <name> [--scope …]`, `approve <name> [--always-ask <tool>]…
 * [--no-always-ask]`, `revoke <name>`, `import [--from claude-code|claude-desktop|<file>] [--scope local|user]` (servers other clients declare, added
 * untrusted). Adding a local/user server is its trust decision; a project entry is asked on first use. Registry files hold servers; trust and pins are
 * product state.
 * C-MODELS (owner CLI review 2026-10-19; owner A48-D5/D6): every trust decision is a person's card on a real terminal — off a terminal (pipe,
 * agent, CI) it is refused before anything is asked, started or written, and `--yes` never skips the card. Listing starts nothing; `--check`
 * starts trusted servers only. A person on a terminal picks the server (approve/revoke/remove without a name), fills the `add` form (command and
 * URL typed: the owner's exception, with a preview card) and picks the `import` source; bare `deckent mcp` there also offers the actions.
 */
export async function mcpCommand(argv: readonly string[], context: CommandContext): Promise<void | ExitCode> {
  const bare = argv[1] === undefined || argv[1].startsWith('-'), verb = bare ? 'list' : argv[1];
  const rest = argv.slice(bare ? 1 : 2), separator = rest.indexOf('--'), flags = separator < 0 ? rest : rest.slice(0, separator), command = separator < 0 ? [] : rest.slice(separator + 1);
  const positionals: string[] = [], env: Record<string, string> = {}, headers: Record<string, string> = {}, alwaysAsk: string[] = [];
  let transport: string | undefined, from: string | undefined, scope: Scope | undefined, json = false, yes = false, check = false, noApprove = false, releaseLocks = false,
    language: string | undefined, realm: string | undefined, timeoutMs: number | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!, value = () => { const next = flags[++i]; if (next === undefined || next.startsWith('--')) throw usage(); return next; };
    if (flag === '--json') json = true;
    else if (flag === '--no-color') continue;
    else if (flag === '--yes' && (verb === 'approve' || verb === 'add' || verb === 'add-json')) yes = true;
    else if (flag === '--check' && verb === 'list') check = true;
    else if (flag === '--no-approve' && (verb === 'add' || verb === 'add-json')) noApprove = true;
    else if (flag === '--lang' && language === undefined) language = value();
    else if ((flag === '--scope' || flag === '-s') && scope === undefined) { const next = value(); if (!SCOPES.includes(next)) throw usage(); scope = next as Scope; }
    else if ((flag === '--transport' || flag === '-t') && verb === 'add' && transport === undefined) { transport = value(); if (transport !== 'stdio' && transport !== 'http') throw usage(); }
    else if ((flag === '--header' || flag === '-H') && verb === 'add') { const pair = value(), at = pair.indexOf(':'); if (at < 1) throw usage(); headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim(); }
    else if ((flag === '--env' || flag === '-e') && verb === 'add') { const pair = value(), at = pair.indexOf('='); if (at < 1) throw usage(); env[pair.slice(0, at)] = pair.slice(at + 1); }
    else if (flag === '--realm' && verb === 'add' && realm === undefined) realm = value();
    else if (flag === '--timeout-ms' && verb === 'add' && timeoutMs === undefined) { timeoutMs = Number(value()); if (!Number.isSafeInteger(timeoutMs)) throw usage(); }
    else if (flag === '--always-ask' && verb === 'approve') alwaysAsk.push(value());
    else if (flag === '--no-always-ask' && verb === 'approve') releaseLocks = true;
    else if (flag === '--from' && verb === 'import' && from === undefined) from = value();
    else if (flag.startsWith('-')) throw usage();
    else positionals.push(flag);
  }
  const locale = commandLocale(context, language);
  if (!context.runMcpCommand) throw usage();
  const interactive = cliMode(context).mode === 'interactive', person = interactive && !json, root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const list = async () => ((await context.runMcpCommand!(root, { verb: 'list', health: false }, options, async () => null, locale)) as { servers?: McpListedServer[] }).servers ?? [];
  const name = positionals[0];
  let request: McpCommandRequest;
  if (verb === 'list' && !positionals.length && !scope && !command.length) request = check ? { verb } : { verb, health: false };
  else if (verb === 'get' && positionals.length === 1 && !scope && !command.length) request = { verb, name: name! };
  else if ((verb === 'approve' || verb === 'revoke' || verb === 'remove') && !positionals.length && !command.length && person && !alwaysAsk.length && !releaseLocks) {
    // A person on a terminal picks the server; the action itself follows its usual cards.
    const picked = await pickServer(context, locale, await list(), verb);
    if (picked === null) { mcpCancelled(context, locale); return EXIT_CODES.error; }
    return mcpAct(context, locale, picked, verb);
  } else if (verb === 'remove' && positionals.length === 1 && !command.length) request = { verb, name: name!, ...(scope ? { scope } : {}) };
  else if (verb === 'approve' && positionals.length === 1 && !scope && !command.length) request = { verb, name: name!, ...(alwaysAsk.length || releaseLocks ? { alwaysAsk } : {}) };
  else if (verb === 'revoke' && positionals.length === 1 && !scope && !command.length) request = { verb, name: name! };
  else if (verb === 'add' && !positionals.length && !command.length && person && !transport && !Object.keys(env).length && !Object.keys(headers).length && !realm) {
    const formed = await mcpAddForm(context, locale, scope, noApprove);
    if (formed === null) { mcpCancelled(context, locale); return EXIT_CODES.error; }
    request = formed;
  } else if (verb === 'add' && positionals.length === 2 && !command.length && transport !== 'stdio' && (transport === 'http' || /^https?:\/\//iu.test(positionals[1]!))
    && !Object.keys(env).length && !realm) request = { verb, scope: scope ?? 'local', name: name!, approve: !noApprove,
    entry: { type: 'http', url: positionals[1], ...(Object.keys(headers).length ? { headers } : {}), ...(timeoutMs ? { timeoutMs } : {}) } };
  else if (verb === 'add' && positionals.length === 1 && command.length > 0 && transport !== 'http' && !Object.keys(headers).length) request = { verb, scope: scope ?? 'local', name: name!, approve: !noApprove,
    entry: { type: 'stdio', command: command[0], ...(command.length > 1 ? { args: command.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}),
      ...(realm ? { realm } : {}), ...(timeoutMs ? { timeoutMs } : {}) } };
  else if (verb === 'import' && !positionals.length && !command.length && scope !== 'project' && (scope === undefined || (from !== undefined && from !== 'claude-code'))) {
    let source = from;
    if (source === undefined && person) {
      // The source by selection; each server it declares lands untrusted (per-server selection needs the import port: C-MODELS known limit).
      const picked = await askMcpCard(context, locale, { title: t('climodels.mcp.import.title', {}, locale), body: [t('climodels.mcp.import.body', {}, locale)],
        options: [{ id: 'claude-code', label: t('climodels.mcp.import.claudeCode', {}, locale) }, { id: 'claude-desktop', label: t('climodels.mcp.import.claudeDesktop', {}, locale) },
          { id: 'cancel', label: t('climodels.card.cancel', {}, locale), key: 'n' }] });
      if (picked === null || picked === 'cancel') { mcpCancelled(context, locale); return EXIT_CODES.error; }
      source = picked;
    }
    request = { verb, from: source === undefined || source === 'claude-code' ? 'claude-code' : source === 'claude-desktop' ? source : { file: source }, ...(scope ? { scope } : {}) } as McpCommandRequest;
  } else if (verb === 'add-json' && positionals.length === 2 && !command.length) {
    let entry: unknown;
    try { entry = JSON.parse(positionals[1]!); } catch { throw usage(); }
    request = { verb: 'add', scope: scope ?? 'local', name: name!, entry, approve: !noApprove };
  } else throw usage();
  // A trust decision (approve; add of a personal scope, owner 2026-09-28) is a person's card on a real terminal (owner A48-D5/D6): off a terminal,
  // `--yes` included, it is refused before anything is asked, started or written; AI and MCP never decide.
  const decides = requestsMcpTrust(request);
  if (decides && !interactive) throw ErrorRegistry.createError('MCP_APPROVAL_NEEDS_TERMINAL');
  if (decides && yes) emit(t('climodels.mcp.yesShowsCard', {}, locale), { level: 'warning', ...sinks });
  const result = await context.runMcpCommand(root, request, options, trustAsker(context, locale), locale);
  emit(result, { ...sinks, json, render: value => request.verb === 'list' ? renderMcpList(value, check, locale, context)
    : request.verb === 'get' ? renderMcpServer(value, locale) : mcpResultText(value, request.verb, locale) });
  if (bare && person && request.verb === 'list') return mcpWindow(context, locale, ((result ?? {}) as { servers?: McpListedServer[] }).servers ?? []);
  return mcpActionExit(request, result);
}

function requestsMcpTrust(request: McpCommandRequest): boolean {
  return request.verb === 'approve' || (request.verb === 'add' && request.scope !== 'project' && request.approve !== false);
}

function mcpActionExit(request: McpCommandRequest, value: unknown): ExitCode | void {
  const result = value as { approved?: boolean; trust?: string; grant?: { status: string } } | null | undefined;
  const grantRefused = result?.grant?.status === 'refused';
  if (request.verb === 'approve' && result?.approved === false) return EXIT_CODES.error;
  if (request.verb === 'add' && requestsMcpTrust(request)
    && (result?.trust === 'declined' || result?.trust === 'unanswered' || result?.trust === 'shadowed')) return EXIT_CODES.error;
  if (grantRefused && (requestsMcpTrust(request) || request.verb === 'revoke' || request.verb === 'remove')) return EXIT_CODES.error;
}

/** The trust card asker: the card on the person's terminal; its answer, or null when cancelled (the adapter records nothing then). */
const trustAsker = (context: CommandContext, locale: Locale) => async (card: unknown): Promise<boolean | null> => {
  const answer = await askMcpCard(context, locale, mcpTrustCard(card, locale));
  return answer === null ? null : answer === 'yes';
};

const pickTitle = (verb: 'approve' | 'revoke' | 'remove', locale: Locale) => verb === 'approve' ? t('climodels.mcp.pick.approve', {}, locale)
  : verb === 'revoke' ? t('climodels.mcp.pick.revoke', {}, locale) : t('climodels.mcp.pick.remove', {}, locale);
const pickNone = (verb: 'approve' | 'revoke' | 'remove', locale: Locale) => verb === 'approve' ? t('climodels.mcp.pick.none.approve', {}, locale)
  : verb === 'revoke' ? t('climodels.mcp.pick.none.revoke', {}, locale) : t('climodels.mcp.pick.none.remove', {}, locale);
/** The server a person picks for an action: approve lists the waiting servers, revoke the trusted ones, remove all. */
async function pickServer(context: CommandContext, locale: Locale, servers: readonly McpListedServer[], verb: 'approve' | 'revoke' | 'remove'): Promise<McpListedServer | null> {
  const fits = servers.filter(server => verb === 'remove' || (verb === 'approve' ? server.status !== 'trusted' : server.status === 'trusted'));
  if (!fits.length) { emit(pickNone(verb, locale), { ...(context.stdout ? { stdout: context.stdout } : {}) }); return null; }
  const chosen = await askMcpCard(context, locale, { title: pickTitle(verb, locale),
    options: fits.map(server => ({ id: `${server.scope}:${server.name}`, label: `${mcpSafe(server.name)} · ${mcpScopeWord(server.scope, locale)} · ${mcpStateWord(server, locale)}` })) });
  return fits.find(server => `${server.scope}:${server.name}` === chosen) ?? null;
}

/** One action on a picked server: approve shows the trust cards; revoke and remove first show what goes (command, realm, tools) and ask. */
async function mcpAct(context: CommandContext, locale: Locale, server: McpListedServer, verb: 'approve' | 'revoke' | 'remove'): Promise<void | ExitCode> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  if (verb !== 'approve') {
    const body = [t('climodels.mcp.field.command', {}, locale) + `: ${mcpLaunchText(server)}`, t('climodels.mcp.field.realm', {}, locale) + `: ${mcpSafe(server.realm ?? '-')}`,
      t('climodels.mcp.field.tools', {}, locale) + `: ${server.pinnedTools ?? 0}`, verb === 'revoke' ? t('cli.mcp.revoke.cardEffect', {}, locale) : t('climodels.mcp.card.removeWhat', {}, locale)];
    const answer = await askMcpCard(context, locale, { title: verb === 'revoke' ? t('climodels.mcp.card.revoke', { name: mcpSafe(server.name) }, locale) : t('climodels.mcp.card.remove', { name: mcpSafe(server.name) }, locale), body, options: mcpConfirmOptions(locale) });
    if (answer !== 'apply') { mcpCancelled(context, locale); return EXIT_CODES.error; }
  }
  const { name, scope, definitionDigest } = server;
  const request: McpCommandRequest = verb === 'approve' ? { verb, name } : { verb, name, selected: { scope, definitionDigest } };
  const result = await context.runMcpCommand!(root, request, options, trustAsker(context, locale), locale);
  emit(result, { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}), render: value => mcpResultText(value, verb, locale) });
  return mcpActionExit(request, result);
}

/** Bare `deckent mcp` on a person's terminal: after the table, pick a server and what to do with it (Esc closes; nothing changes). */
async function mcpWindow(context: CommandContext, locale: Locale, servers: readonly McpListedServer[]): Promise<void | ExitCode> {
  if (!servers.length) return;
  const close: CliCardOption = { id: 'close', label: t('climodels.card.close', {}, locale), key: 'q' };
  const picked = await askMcpCard(context, locale, { title: t('climodels.mcp.pick.server', {}, locale),
    options: [...servers.map(server => ({ id: `${server.scope}:${server.name}`, label: `${mcpSafe(server.name)} · ${mcpStateWord(server, locale)}` })), close] });
  const server = servers.find(entry => `${entry.scope}:${entry.name}` === picked);
  if (!server) return;
  const actions = [...(server.status === 'trusted' ? [] : [{ id: 'approve', label: t('climodels.mcp.action.approve', {}, locale) }]),
    ...(server.status === 'trusted' ? [{ id: 'revoke', label: t('climodels.mcp.action.revoke', {}, locale) }] : []), { id: 'remove', label: t('climodels.mcp.action.remove', {}, locale) }, close];
  const action = await askMcpCard(context, locale, { title: t('climodels.mcp.pick.action', { name: mcpSafe(server.name) }, locale), options: actions });
  if (action === 'approve' || action === 'revoke' || action === 'remove') return mcpAct(context, locale, server, action);
}

/** The `add` form on a person's terminal: name, connection type, command or URL typed (owner exception to "values by selection"), scope picked,
 * then a preview card with the realm and environment names before anything is written; the trust cards follow for a personal scope. */
async function mcpAddForm(context: CommandContext, locale: Locale, scope: Scope | undefined, noApprove: boolean): Promise<McpCommandRequest | null> {
  const typed = async (question: string): Promise<string | null> => {
    const output = (context.stdout ?? process.stdout) as NodeJS.WritableStream & { isTTY?: boolean };
    const prompt = createInterface({ input: (context.stdin ?? process.stdin) as NodeJS.ReadableStream, output, terminal: output.isTTY === true });
    try { const answer = (await prompt.question(question)).trim(); return answer || null; } catch { return null; } finally { prompt.close(); }
  };
  // Both typed values come first (owner exception: the command or URL is typed); an http(s) URL is a Streamable HTTP server, as in the flag form.
  const name = await typed(t('climodels.mcp.add.name', {}, locale)); if (name === null) return null;
  const launch = await typed(t('climodels.mcp.add.launch', {}, locale)); if (launch === null) return null;
  const transport = /^https?:\/\//iu.test(launch) ? 'http' : 'stdio';
  const chosen = scope ?? await askMcpCard(context, locale, { title: t('climodels.mcp.add.scope', {}, locale), initial: 'local',
    options: [{ id: 'local', label: t('climodels.mcp.add.scope.local', {}, locale) }, { id: 'project', label: t('climodels.mcp.add.scope.project', {}, locale) },
      { id: 'user', label: t('climodels.mcp.add.scope.user', {}, locale) }] }) as Scope | null;
  if (chosen === null) return null;
  const words = launch.split(/\s+/u), entry = transport === 'http' ? { type: 'http', url: launch } : { type: 'stdio', command: words[0], ...(words.length > 1 ? { args: words.slice(1) } : {}) };
  const preview = [t('climodels.mcp.field.name', {}, locale) + `: ${mcpSafe(name)}`, t('climodels.mcp.field.scope', {}, locale) + `: ${mcpScopeWord(chosen, locale)}`,
    ...(transport === 'http' ? [t('climodels.mcp.field.url', {}, locale) + `: ${mcpSafe(launch)}`]
      : [t('climodels.mcp.field.command', {}, locale) + `: ${mcpSafe(words[0])}`, ...words.slice(1).map((value, index) => `  ${t('security.mcp.trustCard.argument', { index: index + 1, value: mcpSafe(value) }, locale)}`),
        t('climodels.mcp.field.realm', {}, locale) + `: ${t('climodels.mcp.add.realmDefault', {}, locale)}`]),
    (transport === 'http' ? t('climodels.mcp.field.headers', {}, locale) : t('climodels.mcp.field.env', {}, locale)) + `: ${t('climodels.mcp.none', {}, locale)}`,
    chosen === 'project' || noApprove ? t('climodels.mcp.add.untrusted', {}, locale) : t('climodels.mcp.add.trustNext', {}, locale)];
  const answer = await askMcpCard(context, locale, { title: t('climodels.mcp.add.preview', { name: mcpSafe(name) }, locale), body: preview, options: mcpConfirmOptions(locale) });
  return answer === 'apply' ? { verb: 'add', scope: chosen, name, entry, approve: !noApprove } : null;
}

/** A change's result in the person's words (add, approve, revoke, remove, import), with the K1 grant outcome as one sentence. */
function mcpResultText(value: unknown, verb: McpCommandRequest['verb'], locale: Locale): string {
  if (verb === 'revoke') return mcpRevokeLines(value, locale).map(mcpSafe).join('\n');
  const result = (value ?? {}) as { added?: { name: string; scope: string }; trust?: string; approved?: boolean; name?: string; scope?: string; pinnedTools?: number;
    removed?: { name: string; scope: string }; reset?: { name: string }; imported?: { name: string; scope: string }[];
    skipped?: { name: string | null; reason: string }[]; grant?: unknown };
  const lines: string[] = [];
  if (result.added) {
    const values = { name: mcpSafe(result.added.name), scope: mcpScopeWord(result.added.scope, locale), tools: result.pinnedTools ?? 0 };
    lines.push(result.trust === 'trusted' ? t('climodels.mcp.result.added.trusted', values, locale) : result.trust === 'declined' ? t('climodels.mcp.result.added.declined', values, locale)
      : result.trust === 'shadowed' ? t('climodels.mcp.result.added.shadowed', values, locale) : t('climodels.mcp.result.added.pending', values, locale));
  }
  else if (result.approved !== undefined) {
    const values = { name: mcpSafe(result.name), scope: mcpScopeWord(result.scope ?? '', locale), tools: result.pinnedTools ?? 0 };
    lines.push(result.approved ? t('climodels.mcp.result.approved', values, locale) : t('climodels.mcp.result.notApproved', values, locale));
  }
  else if (result.removed) return mcpRemoveLines(value, locale).map(mcpSafe).join('\n');
  else if (result.imported) {
    lines.push(result.imported.length ? t('climodels.mcp.result.imported', { names: result.imported.map(item => `${mcpSafe(item.name)} (${mcpScopeWord(item.scope, locale)})`).join(', ') }, locale)
      : t('climodels.mcp.result.importedNone', {}, locale));
    for (const skipped of result.skipped ?? []) lines.push(`  ${t('climodels.mcp.result.skipped', { name: mcpSafe(skipped.name ?? '-'), reason: mcpSafe(skipped.reason) }, locale)}`);
  } else return formatValue(value);
  const withdrawal = result.approved === false || result.trust === 'declined' || result.trust === 'unanswered';
  const grant = mcpGrantLine(result.grant, locale, withdrawal ? 'withdrawal' : 'write');
  return [...lines, ...(grant ? [grant] : [])].join('\n');
}

function mcpStatusText(status: string, locale: Locale): string {
  switch (status) {
    case 'trusted': return t('terminal.mcp.status.trusted', {}, locale);
    case 'pending-approval': return t('terminal.mcp.status.pending', {}, locale);
    case 'changed': return t('terminal.mcp.status.changed', {}, locale);
    case 'declined': return t('terminal.mcp.status.declined', {}, locale);
    case 'invalid-launch': return t('terminal.mcp.status.invalidLaunch', {}, locale);
    case 'trust-store-unavailable': return t('terminal.mcp.status.trustUnreadable', {}, locale);
    default: return status;
  }
}
function mcpScopeText(scope: string, locale: Locale): string {
  if (scope === 'local') return t('terminal.mcp.scope.local', {}, locale);
  if (scope === 'project') return t('terminal.mcp.scope.project', {}, locale);
  return scope === 'user' ? t('terminal.mcp.scope.user', {}, locale) : scope;
}

/**
 * `/mcp` in the terminal (MCP-CLIENT, owner 2026-09-28): the servers of this project with their scope and trust state (nothing is started), and
 * `approve <name>` (forget a decline: the next message asks with the trust cards), `reconnect <name>` (the service restarts it on its next use),
 * `remove <name>` (from its registry file; its trust is revoked), `revoke <name>` (K1: trust is revoked and grant removal is reported separately).
 */
export async function mcpSlash(root: string, args: string, context: CommandContext, options: ConfigLoadOptions, locale: Locale): Promise<readonly string[]> {
  const [verb = 'list', name, ...extra] = args.split(/\s+/u).filter(Boolean);
  const run = (request: McpCommandRequest) => context.runMcpCommand!(root, request, options, async () => null, locale);
  if (extra.length || (verb !== 'list' && !name) || (verb === 'list' && name)) return [t('terminal.mcp.usage', {}, locale)];
  if (verb === 'list') {
    const listed = await run({ verb: 'list', health: false }) as { servers: { name: string; scope: string; status: string; command: string; args: string[]; pinnedTools: number;
      lastStart?: { text: string; phase?: string } }[];
      problems: { name: string | null; scope: string; reason: string }[] };
    if (!listed.servers.length && !listed.problems.length) return [t('terminal.mcp.none', {}, locale)];
    return [t('terminal.mcp.count', { count: listed.servers.length }, locale), ...listed.servers.flatMap(server => [`  ${[server.name, mcpScopeText(server.scope, locale), mcpStatusText(server.status, locale),
      ...(server.pinnedTools ? [server.pinnedTools === 1 ? t('terminal.mcp.toolOne', {}, locale) : t('terminal.mcp.tools', { count: server.pinnedTools }, locale)] : []), ...(server.lastStart ? [(server.lastStart.phase === 'tools' ? t('terminal.mcp.toolsChanged', {}, locale) : t('terminal.mcp.notStarted', {}, locale))] : []),
      [server.command, ...server.args].join(' ')].join(' · ')}`, ...(server.lastStart ? [`    ${server.lastStart.text}`] : [])]),
    ...listed.problems.map(problem => `  ${problem.name === null ? t('terminal.mcp.problemFile', { scope: mcpScopeText(problem.scope, locale), reason: problem.reason }, locale)
      : t('terminal.mcp.problemServer', { name: problem.name, scope: mcpScopeText(problem.scope, locale), reason: problem.reason }, locale)}`),
    ...(listed.servers.some(server => server.status === 'pending-approval' || server.status === 'changed') ? [`  ${t('terminal.mcp.pendingHint', {}, locale)}`] : [])];
  }
  if (verb === 'approve') {
    const receipt = await run({ verb: 'reset', name: name! });
    const reset = t('terminal.mcp.approve', { name: name! }, locale);
    const withdrawal = mcpGrantWithdrawalLine(receipt, locale);
    return withdrawal ? [reset, withdrawal] : [reset];
  }
  if (verb === 'reconnect') { await run({ verb: 'reconnect', name: name! }); return [t('terminal.mcp.reconnect', { name: name! }, locale)]; }
  if (verb === 'revoke') return mcpRevokeLines(await run({ verb: 'revoke', name: name! }), locale);
  if (verb === 'remove') return mcpRemoveLines(await run({ verb: 'remove', name: name! }), locale, name);
  return [t('terminal.mcp.usage', {}, locale)];
}
