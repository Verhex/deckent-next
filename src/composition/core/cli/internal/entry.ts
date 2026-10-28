#!/usr/bin/env node
import './production-mode.js'; // First: NODE_ENV is settled before any module below loads React.
import { main as runCli, resolveCliLocale } from '#surfaces/index.js';
import { isMainModule, envValue, loadConfigLanguage, loadConfigAgentEnvironment, resolveProjectRoot, DeckentError, formatHumanError, exitCodeFor, type Locale, type ProjectRootResolution } from '#platform/index.js';
/** L-KIT: the call's locale, resolved once here and handed to every command (`context.locale`): `--lang`, DECKENT_LANGUAGE/DECKENT_LANG,
 * config `language`, LC_ALL, LC_MESSAGES, LANG. Presentation only: a config that cannot be read falls back to the environment, never blocks. */
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
export const SIGNAL_COMMANDS: readonly (readonly [string, string?])[] = Object.freeze([['beuser', 'walk'], ['do'], ['workers', 'watch'], ['decide', 'ask'],
  ['task', 'integration-deliver'], ['task', 'integration-adopt'], ['task', 'integration-rollback']]);
/** INIT-D7: the installation's `cli.agentEnvironment`, read like the language (presentation only); unreadable or invalid → the kit default. */
export const hostAgentEnvironment = (root: string, env: NodeJS.ProcessEnv = process.env) => loadConfigAgentEnvironment(root, { env }).catch(() => undefined);
/** U7-1: the project this call belongs to, walked up from the launch folder; `init --here` keeps the exact folder (a nested installation).
 * Git is asked (lazily, read-only) only when an installation above the folder lies in a work tree. A refusal is printed in the caller's language. */
export async function hostProjectRoot(argv: readonly string[], start: string, env: NodeJS.ProcessEnv = process.env): Promise<ProjectRootResolution> {
  return resolveProjectRoot(start, env, { exact: argv[0] === 'init' && argv.includes('--here'),
    ports: { tracked: async (directory, paths) => (await import('./git-tracked.js')).gitTracksPaths(directory, paths, env) } });
}
export async function main(argv: readonly string[] = process.argv.slice(2), serviceEntry?: string) {
  let resolution: ProjectRootResolution;
  try { resolution = await hostProjectRoot(argv, process.cwd()); }
  catch (error) {
    if (!(error instanceof DeckentError)) throw error;
    process.stderr.write(`${formatHumanError(error, { locale: await hostLocale(argv, process.cwd()), env: process.env, isTTY: Boolean(process.stderr.isTTY) })}\n`);
    return exitCodeFor(error);
  }
  const root = resolution.root;
  const [locale, agentEnvironment] = await Promise.all([hostLocale(argv, root), hostAgentEnvironment(root)]);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve', handlesSignals = isRuntimeServe || SIGNAL_COMMANDS.some(([family, action]) => argv[0] === family && (action === undefined || argv[1] === action));
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (handlesSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  const base = { root, rootResolution: resolution, locale, ...(agentEnvironment ? { agentEnvironment } : {}), signal: controller.signal };
  // COLDSTART: host operations remain lazy. Model-connect help alone loads the public adapter metadata boundary for its current kinds.
  try { return await runCli(argv, { ...base, helpParams: async key => key !== 'cli.help.modelsConnect' ? {} : { kinds: (await import('./model-help.js')).modelConnectHelpKinds() },
    loadHost: async () => (await import('./host.js')).createCliHost(base, serviceEntry) }); }
  finally { if (handlesSignals) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
/** A reader that closed the pipe (`deckent … | head`) is a SIGPIPE: 128 + 13, the code a shell reports for `cat`, `git` and `yes` there. */
export const CLOSED_PIPE_EXIT = 141;
if (isMainModule(import.meta)) {
  // KUR-55: Node ignores SIGPIPE, so a closed reader surfaces as an unhandled EPIPE stack trace. The call stops quietly instead, before another
  // write; `runtime serve` keeps running (its output is a log, never the reason to stop a service). Any other stream error still surfaces.
  if (!(process.argv[2] === 'runtime' && process.argv[3] === 'serve')) for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error; process.exit(CLOSED_PIPE_EXIT); });
  }
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
