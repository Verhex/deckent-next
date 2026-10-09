import { mcpCapabilityPreviewLines, mcpCapabilityWords } from '#surfaces/core/work-labels/index.js';
import { ErrorRegistry, emit, loadConfig, resolveLocale } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

export async function policyMcpCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[2];
  if (!['list', 'grant', 'revoke'].includes(action ?? '') || !context.mcpCapabilities) throw ErrorRegistry.createError('CLI_USAGE');
  let scope: string | undefined, group: string | undefined, expect: string | undefined, language: string | undefined, json = false;
  let mode: 'preview' | 'apply' = 'preview', chosenMode = false;
  for (let i = 3; i < argv.length; i++) {
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
  const config = await loadConfig(root, options), locale = resolveLocale(language, env, config.language); context.onLocale?.(locale);
  const words = mcpCapabilityWords(locale), scopes = await host.listMcpCapabilityScopes(root, options);
  if (scope && !scopes.includes(scope)) throw ErrorRegistry.createError('SCOPE_UNKNOWN');
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'list') {
    const views = await Promise.all((scope ? [scope] : scopes).map(id => host.inspectMcpCapabilities(root, id, options)));
    emit(views, { ...sinks, render: rows => rows.flatMap(view => [view.scopeId, ...view.groups.map(state =>
      `  ${state.group.id} · ${words.label(state.group.labelKey, state.group.id)} · ${words.state[state.managed]} / ${words.effective[state.effective]}`)]).join('\n') });
    return;
  }
  const view = await host.inspectMcpCapabilities(root, scope!, options);
  if (!view.groups.some(state => state.group.id === group)) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await host.changeMcpCapabilities(root, { action: action as 'grant' | 'revoke', scopeId: scope!, groupId: group!, mode, ...(expect ? { expect } : {}) }, options);
  emit(result, { ...sinks, render: value => [words.result[value.status], ...mcpCapabilityPreviewLines(value, locale)].join('\n') });
  if (result.status === 'conflict' || result.status === 'refused') throw ErrorRegistry.createError('POLICY_DENIED');
}
