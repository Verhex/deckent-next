import type { Locale } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, type CliCardRequest } from '#surfaces/core/cli-human/index.js';

/** The command's output sinks (tests inject them; the process streams otherwise). */
export const sinksOf = (context: CliBaseContext) => ({ ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });

/**
 * Cards on the person's terminal (L-KIT `askCliCard`: the terminal's window and keys; refused for a pipe, agent, CI or dumb terminal), each
 * bounded by the session approval time and the command's signal: silence answers nothing (null), so the caller applies nothing.
 */
export function cardIo(context: CliBaseContext, locale: Locale, ttlMs: number): { readonly ask: (request: CliCardRequest) => Promise<string | null> } {
  return { ask: request => askCliCard(request, { locale, env: context.env ?? process.env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) }) };
}
