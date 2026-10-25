#!/usr/bin/env node
import { main as runCli, resolveCliLocale } from '#surfaces/index.js';
import { isMainModule, envValue, loadConfigLanguage, loadConfigAgentEnvironment, type Locale } from '#platform/index.js';
/**
 * L-KIT: the call's locale, resolved once here and handed to every command (`context.locale`): `--lang`, DECKENT_LANGUAGE/DECKENT_LANG,
 * config `language`, LC_ALL, LC_MESSAGES, LANG. Presentation only: a config that cannot be read falls back to the environment, never blocks.
 */
export async function hostLocale(argv: readonly string[], root: string, env: NodeJS.ProcessEnv = process.env): Promise<Locale> {
  const at = argv.indexOf('--lang'), flag = at >= 0 && !argv[at + 1]?.startsWith('-') ? argv[at + 1] : undefined;
  // A supported flag or DECKENT_LANGUAGE/DECKENT_LANG outranks config: no config read is needed then (an unsupported value is passed over).
  const decisive = [flag, envValue(env, 'DECKENT_LANGUAGE'), envValue(env, 'DECKENT_LANG')]
    .some(value => !!value && resolveCliLocale({ flag: value, env: {} }) === value.slice(0, 2).toLowerCase());
  if (decisive) return resolveCliLocale({ flag, env });
  let configLanguage: string | undefined;
  try { configLanguage = await loadConfigLanguage(root, { env }); } catch { /* unreadable or invalid config: the environment chain decides */ }
  return resolveCliLocale({ flag, env, configLanguage });
}
/** The long-running commands whose SIGINT/SIGTERM cancel the call (besides `runtime serve`); a cli-grouped-help test pins each name to the catalog. */
export const SIGNAL_COMMANDS: readonly (readonly [string, string?])[] = Object.freeze([['do'], ['workers', 'watch'], ['decide', 'ask'],
  ['task', 'integration-deliver'], ['task', 'integration-adopt'], ['task', 'integration-rollback']]);
/** INIT-D7: the installation's `cli.agentEnvironment`, read like the language (presentation only); unreadable or invalid → the kit default. */
export const hostAgentEnvironment = (root: string, env: NodeJS.ProcessEnv = process.env) => loadConfigAgentEnvironment(root, { env }).catch(() => undefined);
export async function main(argv: readonly string[] = process.argv.slice(2), serviceEntry?: string) {
  const root = process.cwd();
  const [locale, agentEnvironment] = await Promise.all([hostLocale(argv, root), hostAgentEnvironment(root)]);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve', handlesSignals = isRuntimeServe || SIGNAL_COMMANDS.some(([family, action]) => argv[0] === family && (action === undefined || argv[1] === action));
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (handlesSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const base = { root, locale, ...(agentEnvironment ? { agentEnvironment } : {}), signal: controller.signal };
  // COLDSTART: host operations remain lazy. Model-connect help alone loads the public adapter metadata boundary for its current kinds.
  try { return await runCli(argv, { ...base, helpParams: async key => {
    if (key !== 'cli.help.modelsConnect') return {};
    const { modelConnectHelpKinds } = await import('./model-help.js');
    return { kinds: modelConnectHelpKinds() };
  }, loadHost: async () => (await import('./host.js')).createCliHost(base, serviceEntry) }); }
  finally { if (handlesSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (isMainModule(import.meta)) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
