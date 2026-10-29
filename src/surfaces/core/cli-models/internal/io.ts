import { DeckentError, emit, getConfigFieldDefault, loadConfig, t, type Locale } from '#platform/index.js';
import { askCliCard, cliMode, type CliCardOption, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import type { ModelCommandContext } from './context.js';

/** C-MODELS: whether a person is at a real terminal for this call (never an agent, CI, pipe, dumb terminal or `--json`); UX only, no authority. */
export const modelsInteractive = (context: ModelCommandContext, json = false): boolean => cliMode(context, json).mode === 'interactive';
export const modelsSinks = (context: ModelCommandContext) => ({ ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });

/** One card on the person's terminal, bounded by the session approval time (silence answers nothing); null = cancelled, nothing is applied. */
export async function askModelsCard(context: ModelCommandContext, locale: Locale, request: CliCardRequest): Promise<string | null> {
  const env = context.env ?? process.env;
  const ttlMs = await loadConfig(context.root ?? process.cwd(), { env, heal: false }).then(config => config.approvals.sessionTtlMs, () => getConfigFieldDefault('approvals').sessionTtlMs);
  return askCliCard(request, { locale, env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
    ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
}
/** Apply / cancel answers; nothing is preselected, so Enter alone decides nothing. */
export const modelsConfirmOptions = (locale: Locale): readonly CliCardOption[] => [{ id: 'apply', label: t('climodels.card.apply', {}, locale), role: 'yes' },
  { id: 'cancel', label: t('climodels.card.cancel', {}, locale), role: 'no' }];
export const reportModelsCancelled = (context: ModelCommandContext, locale: Locale): void => {
  emit(t('climodels.card.cancelled', {}, locale), { level: 'warning', ...modelsSinks(context) });
};
/** The configured retirement warning threshold (law 6: `models.retirementWarningDays`, the registry default when the config cannot be read). */
export async function retirementWarningDays(context: ModelCommandContext): Promise<number> {
  const fallback = getConfigFieldDefault('models').retirementWarningDays;
  return loadConfig(context.root ?? process.cwd(), { env: context.env ?? process.env, heal: false }).then(config => config.models.retirementWarningDays ?? fallback, () => fallback);
}
/** A denied activation change on a person's terminal: the typed denial stays, preceded by the step that resolves it (template candidate C3). */
export function explainActivationDenial(error: unknown, context: ModelCommandContext, locale: Locale, action: 'activate' | 'deactivate', scope: string): never {
  if (error instanceof DeckentError && (error.code === 'POLICY_DENIED' || error.code === 'POLICY_APPROVAL_UNSUPPORTED')) {
    emit(t('climodels.models.denied', { action, scope }, locale), { level: 'warning', ...modelsSinks(context) });
  }
  throw error;
}
