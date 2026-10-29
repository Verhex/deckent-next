import { emit, getConfigFieldDefault, loadConfig, t, type Locale } from '#platform/index.js';
import { askCliCard, cliMode, type CliCardOption, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';

/** C-ADMIN: whether a person is at a real terminal for this call (never an agent, CI, pipe, dumb terminal or `--json`); UX only, no authority. */
export const adminInteractive = (context: AdminCommandContext, json = false): boolean => cliMode(context, json).mode === 'interactive';

/** One card on the person's terminal, bounded by the session approval time (silence answers nothing); null = cancelled, nothing is applied. */
export async function askAdminCard(context: AdminCommandContext, locale: Locale, request: CliCardRequest): Promise<string | null> {
  const env = context.env ?? process.env;
  const ttlMs = await loadConfig(context.root ?? process.cwd(), { env }).then(config => config.approvals.sessionTtlMs, () => getConfigFieldDefault('approvals').sessionTtlMs);
  return askCliCard(request, { locale, env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
    ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
}
/** Apply / cancel answers; nothing is preselected, so Enter alone decides nothing. */
export const confirmOptions = (locale: Locale): readonly CliCardOption[] => [{ id: 'apply', label: t('cli.admin.card.apply', {}, locale), role: 'yes' },
  { id: 'cancel', label: t('cli.admin.card.cancel', {}, locale), role: 'no' }];
/** The command's stdout/stderr sinks as `emit` takes them. */
export const adminSinks = (context: AdminCommandContext) => ({ ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
/** "Cancelled; nothing was changed." on stderr (a person's own answer, not an error). */
export const reportCancelled = (context: AdminCommandContext, locale: Locale): void => {
  emit(t('cli.admin.card.cancelled', {}, locale), { level: 'warning', ...adminSinks(context) });
};
