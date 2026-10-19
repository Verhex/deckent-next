import { mcpCapabilityPreviewLines, mcpCapabilityWords } from '#surfaces/core/work-labels/index.js';
import { ErrorRegistry, emit, loadConfig } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, cliTableStyle } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { mcpTable, toggleMcp } from './policy-toggle.js';

/**
 * `deckent policy mcp` without an action: on a person's terminal the groups with on/off → pick → preview card → apply (the same governed change as
 * `grant|revoke --apply --expect`); anywhere else the read-only `list`. `list|grant|revoke` keep their explicit flags unchanged.
 */
export async function policyMcpCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const bare = argv[2] === undefined || argv[2].startsWith('-'), action = bare ? 'list' : argv[2];
  if (!['list', 'grant', 'revoke'].includes(action ?? '') || !context.mcpCapabilities) throw ErrorRegistry.createError('CLI_USAGE');
  let scope: string | undefined, group: string | undefined, expect: string | undefined, language: string | undefined, json = false;
  let mode: 'preview' | 'apply' = 'preview', chosenMode = false;
  for (let i = bare ? 2 : 3; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if ((flag === '--preview' || flag === '--apply') && !chosenMode) { mode = flag === '--apply' ? 'apply' : 'preview'; chosenMode = true; }
    else if (['--scope', '--group', '--expect', '--lang'].includes(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--scope' && scope === undefined) scope = value; else if (flag === '--group' && group === undefined) group = value;
      else if (flag === '--expect' && expect === undefined) expect = value; else if (flag === '--lang' && language === undefined) language = value;
      else throw ErrorRegistry.createError('CLI_USAGE');
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (action === 'list' ? group !== undefined || expect !== undefined || chosenMode : !scope || !group || (mode === 'apply') !== (expect !== undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, host = context.mcpCapabilities;
  const locale = commandLocale(context, language);
  if (bare && !json && cliMode(context).mode === 'interactive') return toggleMcp(context, locale, scope, (await loadConfig(root, options)).approvals.sessionTtlMs);
  const words = mcpCapabilityWords(locale), scopes = await host.listMcpCapabilityScopes(root, options);
  if (scope && !scopes.includes(scope)) throw ErrorRegistry.createError('SCOPE_UNKNOWN');
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'list') {
    const views = await Promise.all((scope ? [scope] : scopes).map(id => host.inspectMcpCapabilities(root, id, options)));
    emit(views, { ...sinks, render: rows => rows.flatMap(view => [view.scopeId, mcpTable(view, locale, cliTableStyle(context))]).join('\n') });
    return;
  }
  const view = await host.inspectMcpCapabilities(root, scope!, options);
  if (!view.groups.some(state => state.group.id === group)) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await host.changeMcpCapabilities(root, { action: action as 'grant' | 'revoke', scopeId: scope!, groupId: group!, mode, ...(expect ? { expect } : {}) }, options);
  emit(result, { ...sinks, render: value => [words.result[value.status], ...mcpCapabilityPreviewLines(value, locale)].join('\n') });
  if (result.status === 'conflict' || result.status === 'refused') throw ErrorRegistry.createError('POLICY_DENIED');
}
