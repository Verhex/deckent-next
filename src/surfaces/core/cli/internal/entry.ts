import { identityCommand } from '#surfaces/core/cli-identity/index.js';
import { registerCliCommands, renderTopHelp, cliHelpRequest, cliInstallationContract } from '#surfaces/core/cli-kit/index.js';
import { approvalsCommand } from './approvals.js';
import { workersCommand, runInventoryCommand, monitorCommand } from '#surfaces/core/monitor/index.js';
import { runCommand } from './run.js';
import { codingCommand } from './coding.js';
import { taskCommand } from './task.js';
import { runtimeCommand } from './runtime.js';
import { initCommand } from '#surfaces/core/cli-installation/index.js';
import { toolchainsCommand } from './toolchains.js';
import { mcpCommand } from './mcp.js';
import { operationCommand } from './operation.js';
import { policyGrantsCommand } from './policy-grants.js';
import { secretCommand } from './secret.js';
import { poolCommand } from './pool.js';
import { inferenceCommand, modelsCommand } from '#surfaces/core/cli-models/index.js';
import { decisionCommand } from '#surfaces/core/cli-decision/index.js';
import { PACKAGE_NAME, PACKAGE_VERSION, readBuildIdentity, t, emit, assertErrorRegistry, reportFatal, resolveLocale, loadConfigLanguage, type ExitCode } from '#platform/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';
export type { ExitCode } from '#platform/index.js';

/** Catalog registration binds every family and leaf to its existing argument parser. */
export const CLI_COMMANDS = registerCliCommands<CommandContext>({
  identity: identityCommand,
  terminal: async (argv, context) => (await import('./terminal.js')).terminalCommand(argv, context),
  init: initCommand, monitor: monitorCommand, workers: workersCommand, run: runCommand, task: taskCommand,
  pool: poolCommand, models: modelsCommand, approval: approvalsCommand,
  // The config surface renders through terminal-render (whose barrel carries Ink): a lazy edge keeps it off every other command's start.
  config: async (argv, context) => (await import('#surfaces/core/config/index.js')).configCommand(argv, context),
  mcp: mcpCommand, secret: secretCommand, toolchains: toolchainsCommand, doctor: runKernelCommand,
  inventory: runInventoryCommand, paths: runKernelCommand, runtime: runtimeCommand, coding: codingCommand,
  inference: inferenceCommand, operation: operationCommand, decide: decisionCommand,
  policy: (argv, context) => (argv[1] === 'grants' || argv[1] === 'revoke' || argv[1] === 'upgrade' ? policyGrantsCommand : runKernelCommand)(argv, context),
});

/** Pure CLI dispatcher: returns the text to print and the exit code; no process side effects (testable). */
export function dispatch(argv: readonly string[]): { readonly output: string; readonly code: ExitCode } {
  const [command] = argv;
  const common = { name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` };
  if (command === undefined || command === '--help' || command === '-h') return { output: renderTopHelp(resolveLocale(argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined), argv.includes('--all')), code: 0 };
  if (command === '--version' || command === '-v') {
    const build = readBuildIdentity();
    const line = build ? '\n' + t('cli.version.build', { tree: build.sourceTreeSha256.slice(0, 12), commit: build.sourceCommit?.slice(0, 12) ?? '-',
      dirty: build.sourceDirty ? t('cli.version.dirty') : '', source: build.sourceCommonDir ? ` · sourceCommonDir ${build.sourceCommonDir}` : '' }) : '';
    return { output: t('cli.version', common) + line, code: 0 };
  }
  return { output: t('cli.unknownCommand', { ...common, command }), code: 2 };
}

function interactiveTerminal(context: CommandContext): boolean {
  const stdin = context.stdin ?? process.stdin;
  const stdout: unknown = context.stdout ?? process.stdout;
  const term = (context.env ?? process.env)['TERM'];
  return Boolean(stdin.isTTY) && Boolean((stdout as { isTTY?: boolean }).isTTY) && term !== 'dumb';
}

export async function main(argv: readonly string[] = process.argv.slice(2), context: CommandContext = {}): Promise<ExitCode> {
  let locale = resolveLocale(undefined, context.env);
  try {
    assertErrorRegistry();
    const help = await cliHelpRequest(argv, CLI_COMMANDS, context.env, () => loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }));
    if (help) {
      locale = help.locale; context.onLocale?.(locale);
      emit(help.output, { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
      return 0;
    }
    context.initialize?.();
    const interactive = (argv.length === 0 && interactiveTerminal(context)) || (argv.length === 1 && argv[0] === '--full-access');
    // ID-1C: the relocation stop precedes every installation-bound command. Commands that own their installation load/recovery and
    // identity check (config, init) or need no installation (policy vocabulary) declare it in the catalog and are not gated here.
    if (context.loadInstallationIdentity && (interactive || CLI_COMMANDS.some(item => item.name === argv[0]))
      && cliInstallationContract(argv, CLI_COMMANDS) === undefined) {
      locale = resolveLocale(argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined, context.env,
        await loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }));
      await context.loadInstallationIdentity(context.root ?? process.cwd(), { ...(context.env ? { env: context.env } : {}), globalOnly: argv.includes('--global') });
    }
    // `deckent` alone opens the interactive terminal on a real terminal; piped or dumb terminals get help (owner 2026-09-23).
    // `deckent --full-access` (MODES-3) opens it in full access; without a terminal it is refused by the terminal itself (never silent).
    if (interactive) {
      await (await import('./terminal.js')).terminalCommand(['terminal', ...argv], { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } });
      return 0;
    }
    const command = CLI_COMMANDS.find(item => item.path.length === 1 && item.name === argv[0]);
    if (command) { await command.run(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } }); return 0; }
    const result = argv.length === 0 ? { output: renderTopHelp(locale), code: 0 as const } : dispatch(argv);
    emit(result.output, { level: result.code === 0 ? 'info' : 'error', ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return result.code;
  } catch (error) {
    return reportFatal(error, { ...context, argv, json: argv.includes('--json'), locale });
  }
}
