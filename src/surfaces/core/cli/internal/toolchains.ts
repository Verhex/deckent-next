import { ErrorRegistry, emit, formatValue, resolveLocale, t } from '#platform/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

export type ToolchainUpdateHandler = (root: string, input: Readonly<{ apply: boolean }>, options: ConfigLoadOptions) => Promise<Readonly<{ decision: string; plan: Readonly<{ next: Readonly<{ imageVersion: string }> | null }> | null; build: Readonly<{ imageId: string; tag: string | null }> | null; proposalPath: string | null }>>;
/** `toolchains update [--apply] [--json]`: policy-driven plan/build for the next worker image version. Installed config is never written here. */
export async function toolchainsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; let apply = false, json = false, language: string | undefined;
  if (action !== 'update') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (flag === '--lang' && language === undefined) { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); continue; }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const env = context.env ?? process.env; const locale = resolveLocale(language, env); context.onLocale?.(locale);
  if (!context.updateToolchains) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.updateToolchains(context.root ?? process.cwd(), { apply }, { env });
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  emit(result, { ...sinks, json, render: value => `${t('cli.toolchains.update', { decision: value.decision, version: value.plan?.next?.imageVersion ?? '-',
    image: value.build?.tag ?? value.build?.imageId ?? '-', proposal: value.proposalPath ?? '-' }, locale)}\n${formatValue(value)}` });
}
