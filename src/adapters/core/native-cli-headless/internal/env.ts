import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { NativeCliHeadless, nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { refuse } from './contract.js';

export type HeadlessEntry = NonNullable<ReturnType<typeof nativeCliHeadless>>;
/**
 * The one environment of every headless spawn (preflight probes and the call): built from registry names, never inherited. HOME and TMPDIR
 * are the connection's emptied run dir (HEADLESS-0: the login survives), the config-dir name points at the person's CLI config directory, and
 * the proxy names point at the realm's relay (S3-5: its network namespace has no other way out); no-proxy names are empty.
 * A deny name can never be present (credential overrides outrank the subscription login in print mode).
 */
export function buildHeadlessEnv(headless: NativeCliHeadless, runDir: string, configDir: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...headless.env.fixed }, { proxy } = headless.isolation;
  for (const name of headless.env.runDir) env[name] = runDir;
  env[headless.env.configDir] = configDir;
  for (const name of proxy.env) env[name] = `http://${proxy.host}:${proxy.port}`;
  for (const name of proxy.clear) env[name] = '';
  if (Object.keys(env).some(name => headless.env.deny.includes(name))) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'environment' });
  return Object.freeze(env);
}
/** s3c: the environment of the CLI's own sign-in in the person's terminal: the registry's inherited names from the person's environment (browser opener,
 * terminal), its fixed names and the login dir; built, never passed through whole, so no credential override reaches it. */
export function headlessLoginEnv(headless: NativeCliHeadless, person: Readonly<Record<string, string | undefined>>, configDir: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of headless.login.env.inherit) { const value = person[name]; if (typeof value === 'string' && !value.includes('\0')) env[name] = value; }
  Object.assign(env, headless.login.env.fixed); env[headless.env.configDir] = configDir;
  if (Object.keys(env).some(name => headless.env.deny.includes(name))) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'environment' });
  return Object.freeze(env);
}
/** Every flag the call uses (fixed argv, model, turn bound, system prompt file and the effort flags); the preflight requires each one. */
export function headlessRequiredFlags({ command, headless }: HeadlessEntry): readonly string[] {
  return [...new Set([...headless.args.filter(arg => arg.startsWith('--')), command.modelFlag, headless.systemPromptFlag,
    ...(command.capabilities.maxTurns ? [command.capabilities.maxTurns.flag] : []), ...(command.capabilities.reasoningEffort?.requiredFlags ?? [])])];
}
/** The argv shape this release sends (flags, bounds, env names, the realm's shape): sealed in the preflight record and every response (an absent
 * optional field leaves an existing digest unchanged). */
export function headlessFlagSetDigest(entry: HeadlessEntry): string {
  const { headless } = entry;
  return createHash('sha256').update(JSON.stringify({ revision: headless.revision, args: headless.args, maxTurns: headless.maxTurns, turnBound: headless.turnBound, prompt: headless.systemPromptArgs, flags: headlessRequiredFlags(entry),
    forbidden: headless.forbiddenFlags, env: { fixed: headless.env.fixed, runDir: headless.env.runDir, configDir: headless.env.configDir },
    isolation: { ...headless.isolation, source: undefined, configVisibleSource: undefined, refreshLock: { ...headless.isolation.refreshLock, source: undefined },
      limits: { ...headless.isolation.limits, boundsSource: undefined, limiterSource: undefined } } })).digest('hex');
}
/** The call argv: no prompt and no secret (system prompt by 0600 file, user message by stdin); a forbidden flag or alias refuses. The turn bound is the
 * CLI's flag, or (`turnBound: stream`, no such flag) the line guard; the prompt file goes in the registry's template (a quoted config value: no quote in it). */
export function headlessArgv({ command, headless }: HeadlessEntry, runDir: string, model: string, effortArgs: readonly string[]): readonly string[] {
  const maxTurns = command.capabilities.maxTurns, file = join(runDir, headless.systemPromptFile);
  if ((!maxTurns && headless.turnBound !== 'stream') || command.modelAliases.includes(model)) refuse('HEADLESS_REQUEST_INVALID', { reason: maxTurns || headless.turnBound ? 'model-alias' : 'turn-bound' });
  if (headless.systemPromptArgs && /["\\]/u.test(file)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const argv = [...headless.args, ...(maxTurns ? [maxTurns.flag, String(headless.maxTurns)] : []), command.modelFlag, model, ...effortArgs,
    ...(headless.systemPromptArgs?.map(arg => arg.replaceAll('{file}', file)) ?? [headless.systemPromptFlag, file])];
  if (argv.some(arg => headless.forbiddenFlags.some(flag => arg === flag || arg.startsWith(flag + '=')))) refuse('HEADLESS_REQUEST_INVALID', { reason: 'forbidden-flag' });
  return Object.freeze(argv);
}
