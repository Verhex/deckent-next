import { envValue, getConfigFieldDefault } from '#platform/index.js';
import registry from './human.json' with { type: 'json' };

/** How a CLI call talks to its caller: typed JSON, an interactive person on a terminal, or plain lines (pipe, CI, agent, dumb terminal). */
export type CliMode = 'json' | 'interactive' | 'plain';
export type CliModeReason = 'json' | 'agent' | 'ci' | 'dumb' | 'pipe' | 'tty';
type Stream = { readonly isTTY?: boolean } | undefined;

/** INIT-D7: the config registry's default list of exact agent-marker variable names (`cli.agentEnvironment`, no prefix match); the host
 * passes the installation's configured list on the context (`agentEnvironment`), so this default is used only when none was read. */
export const AGENT_ENVIRONMENT: readonly string[] = Object.freeze([...getConfigFieldDefault('cli').agentEnvironment]);

const marked = (env: Readonly<Record<string, string | undefined>>, names: readonly string[]) =>
  names.some(name => { const value = envValue(env, name)?.trim().toLowerCase(); return value !== undefined && value !== '0' && value !== 'false'; });

/**
 * One decision for every command: `--json` wins; an AI agent, CI or `TERM=dumb` is never asked a question; a pipe on either side is plain;
 * only a real terminal on stdin and stdout is interactive. UX only: the mode grants or removes no authority.
 */
export function detectCliMode(input: { readonly json?: boolean; readonly env?: Readonly<Record<string, string | undefined>>; readonly stdin?: Stream;
  readonly stdout?: Stream; readonly agentEnvironment?: readonly string[] }): Readonly<{ mode: CliMode; reason: CliModeReason }> {
  const env = input.env ?? process.env;
  if (input.json) return { mode: 'json', reason: 'json' };
  if (marked(env, input.agentEnvironment ?? AGENT_ENVIRONMENT)) return { mode: 'plain', reason: 'agent' };
  if (marked(env, registry.ciEnvironment)) return { mode: 'plain', reason: 'ci' };
  if (envValue(env, 'TERM')?.trim().toLowerCase() === 'dumb') return { mode: 'plain', reason: 'dumb' };
  if (!(input.stdin ?? process.stdin).isTTY || !(input.stdout ?? process.stdout).isTTY) return { mode: 'plain', reason: 'pipe' };
  return { mode: 'interactive', reason: 'tty' };
}

/** The same decision read from a command context (its streams, environment and the host's agent list). */
export function cliMode(context: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: Stream; readonly stdout?: unknown; readonly agentEnvironment?: readonly string[] },
  json = false) {
  return detectCliMode({ json, env: context.env ?? process.env, stdin: context.stdin ?? process.stdin, stdout: (context.stdout ?? process.stdout) as Stream,
    ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
}
