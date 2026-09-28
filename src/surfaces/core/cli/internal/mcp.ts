import { ErrorRegistry, emit, formatValue, resolveLocale } from '#platform/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

/** The host's MCP-client inspection (MCP-CLIENT): `list` reads configuration only; `inspect` starts one server under its realm, reads its era
 * and tool list, verifies the pins and closes it (never a tool call). Null: the server is not configured. */
export type McpServersInspectHandler = (root: string, input: { readonly action: 'list' } | { readonly action: 'inspect'; readonly id: string },
  options: ConfigLoadOptions) => Promise<unknown>;
/**
 * `deckent mcp servers list [--json]` and `deckent mcp servers inspect <id> [--json]` (MCP-CLIENT, read-only surface of this slice: installing a
 * server or re-pinning a tool is the owner's configuration edit; the terminal and `/policy` flows belong to POLICY-ADMIN).
 */
export async function mcpCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  if (argv[1] !== 'servers' || (argv[2] !== 'list' && argv[2] !== 'inspect')) throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[2];
  let id: string | undefined, json = false, language: string | undefined, i = 3;
  if (action === 'inspect') { id = argv[3]; i = 4; if (!id || id.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); }
  for (; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (flag === '--lang' && language === undefined) { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); continue; }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const env = context.env ?? process.env; context.onLocale?.(resolveLocale(language, env));
  if (!context.inspectMcpServers) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.inspectMcpServers(context.root ?? process.cwd(), action === 'list' ? { action } : { action, id: id! }, { env });
  if (result === null) throw ErrorRegistry.createError('CLI_USAGE');
  emit(result, { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}), json, render: formatValue });
}
