import { ErrorRegistry, emit, loadConfig, resolveLocale, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { readInferenceServingProfile } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';

/** The chat plan the terminal reports (the `cli-terminal` view, read structurally; no field is added to it). */
type ChatPlan = Readonly<{ status: string; reference: Readonly<{ providerId: string; modelId: string; modelVersion: number }> | null;
  source?: string | null; catalogRevision: string | null; maxCompletionTokens: number | null; historyMessages: number | null }>;
export interface TerminalInfoContext extends CliBaseContext {
  describeTerminalChatPlan?: (root: string, options: ConfigLoadOptions) => Promise<ChatPlan>;
}
const ACTIONS = new Set(['status', 'chat-plan', 'snapshot']);

/** Flags these three actions accept (the terminal parser's own set for them); anything else is left to that parser to refuse. */
function scan(argv: readonly string[]): Readonly<{ json: boolean; help: boolean; language?: string }> | null {
  let json = false, help = false, language: string | undefined;
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index]!;
    if (key === '--json') json = true;
    else if (key === '--help' || key === '-h') help = true;
    else if (key === '--no-color') continue;
    else if (key === '--lang' || key === '--scope') { const value = argv[++index]; if (!value || value.startsWith('-')) return null; if (key === '--lang') language = value; }
    else return null;
  }
  return { json, help, ...(language ? { language } : {}) };
}

function chatPlanText(plan: ChatPlan, locale: Locale): string {
  const model = plan.reference ? `${plan.reference.providerId}/${plan.reference.modelId}@${plan.reference.modelVersion}` : null;
  const status = plan.status === 'ready' ? t('cli.terminalInfo.chat.ready', {}, locale) : plan.status === 'model-not-declared'
    ? t('cli.terminalInfo.chat.notDeclared', {}, locale) : t('cli.terminalInfo.chat.notConfigured', {}, locale);
  const source = plan.source === 'session' ? t('cli.terminalInfo.source.session', {}, locale) : plan.source === 'project' ? t('cli.terminalInfo.source.project', {}, locale)
    : plan.source === 'user-default' ? t('cli.terminalInfo.source.userDefault', {}, locale) : plan.source === 'user' ? t('cli.terminalInfo.source.user', {}, locale) : plan.source === 'connected' ? t('cli.terminalInfo.source.connected', {}, locale)
      : t('cli.terminalInfo.unknown', {}, locale);
  const value = (n: number | null) => n === null ? t('cli.terminalInfo.unknown', {}, locale) : String(n);
  return terminalSafeText([t('cli.terminalInfo.chat.status', { status }, locale),
    ...(model ? [t('cli.terminalInfo.chat.model', { model, source }, locale)] : [t('cli.terminalInfo.chat.next', {}, locale)]),
    ...(plan.maxCompletionTokens === null && plan.historyMessages === null ? []
      : [t('cli.terminalInfo.chat.limits', { tokens: value(plan.maxCompletionTokens), history: value(plan.historyMessages) }, locale)]),
    t('cli.terminalInfo.reachability', {}, locale)].join('\n'));
}

/**
 * The CLI entry of `deckent terminal status|chat-plan|snapshot` (C-DOCTOR; the terminal itself stays in `cli-terminal`, K1–K8):
 * `chat-plan` is readable text for a person (JSON only with `--json`); `snapshot` without an inference_serving profile is one typed error with
 * its next step; `status` adds, after the terminal's own lines, whether the chat model was reached (this command never contacts it: "not
 * tested") and why the context window reads "?". JSON output is the terminal's, unchanged; every other call goes to `delegate`.
 */
export async function terminalInfoCommand(argv: readonly string[], context: TerminalInfoContext, delegate: () => Promise<void>): Promise<void> {
  const action = argv[1], flags = ACTIONS.has(action ?? '') ? scan(argv) : null;
  if (!flags || flags.help) return delegate();
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options: ConfigLoadOptions = { env };
  if (action === 'snapshot') {
    const config = await loadConfig(root, options) as Record<string, unknown>;
    if (!readInferenceServingProfile(config)) throw ErrorRegistry.createError('TERMINAL_SNAPSHOT_NOT_CONFIGURED');
    return delegate();
  }
  if (flags.json) return delegate();
  if (action === 'status') {
    await delegate();
    const config = await loadConfig(root, options) as Record<string, unknown> & { language?: string };
    const locale = resolveLocale(flags.language, env, config.language);
    emit([t('cli.terminalInfo.reachability', {}, locale), readInferenceServingProfile(config) ? t('cli.terminalInfo.context.profile', {}, locale)
      : t('cli.terminalInfo.context.noProfile', {}, locale)].join('\n'), { ...(context.stdout ? { stdout: context.stdout } : {}) });
    return;
  }
  const config = await loadConfig(root, options) as Record<string, unknown> & { language?: string };
  const locale = resolveLocale(flags.language, env, config.language);
  context.onLocale?.(locale);
  if (!context.describeTerminalChatPlan) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
  emit(chatPlanText(await context.describeTerminalChatPlan(root, options), locale), { ...(context.stdout ? { stdout: context.stdout } : {}) });
}
