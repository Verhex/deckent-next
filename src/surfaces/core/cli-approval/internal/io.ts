import { EXIT_CODES, emit, t, type ExitCode, type Locale } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, type CliCardRequest } from '#surfaces/core/cli-human/index.js';

/** The command's output sinks (tests inject them; the process streams otherwise). */
export const sinksOf = (context: CliBaseContext) => ({ ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });

/** Owner decision 155: a scope pick that closed without a scope never showed the requested table or list, so it is not a success. */
export function scopeCancelled(context: CliBaseContext, locale: Locale): ExitCode {
  emit(t('cli.approval.scope.cancelled', {}, locale), { level: 'warning', ...sinksOf(context) });
  return EXIT_CODES.error;
}

/**
 * Cards on the person's terminal (L-KIT `askCliCard`: the terminal's window and keys; refused for a pipe, agent, CI or dumb terminal), each
 * bounded by the session approval time, any record deadline and the command's signal. Silence answers nothing (null).
 */
export function cardIo(context: CliBaseContext, locale: Locale, ttlMs: number): { readonly ask: (request: CliCardRequest, expiresAt?: number) => Promise<string | null> } {
  return { ask: (request, expiresAt) => {
    const waitMs = expiresAt === undefined ? ttlMs : Math.min(ttlMs, expiresAt - Date.now());
    const timeout = waitMs <= 0 ? AbortSignal.abort() : AbortSignal.timeout(waitMs);
    return askCliCard(request, { locale, env: context.env ?? process.env, signal: AbortSignal.any([timeout, ...(context.signal ? [context.signal] : [])]),
      ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
  } };
}
