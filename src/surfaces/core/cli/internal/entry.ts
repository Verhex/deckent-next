import { registerCliCommands, renderTopHelp, cliHelpRequest, cliInstallationContract, lazyFunction } from '#surfaces/core/cli-kit/index.js';
import { PACKAGE_NAME, PACKAGE_VERSION, NODE_ENGINE_RANGE, assessNodeSupport, readBuildIdentity, t, emit, assertErrorRegistry, reportFatal, resolveLocale, loadConfigLanguage, DeckentError, ErrorRegistry, type ExitCode, type Locale } from '#platform/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';
export type { ExitCode } from '#platform/index.js';

// COLDSTART: every family loads on its first call (each reaches the engine barrel); help, `--version` and an unknown command load none of them.
const admin = () => import('#surfaces/core/cli-admin/index.js'), approval = () => import('#surfaces/core/cli-approval/index.js');
const observe = () => import('#surfaces/core/cli-observe/index.js'), cliRun = () => import('#surfaces/core/cli-run/index.js');
const models = () => import('#surfaces/core/cli-models/index.js');
export const runCommand = lazyFunction(cliRun, 'runCommand'), readGraphInput = lazyFunction(cliRun, 'readGraphInput');
export const toolchainsCommand = lazyFunction(admin, 'toolchainsCommand');
export const mcpCommand = lazyFunction(() => import('./mcp.js'), 'mcpCommand'), mcpSlash = lazyFunction(() => import('./mcp.js'), 'mcpSlash');

/** Catalog registration binds every family and leaf to its existing argument parser. */
export const CLI_COMMANDS = registerCliCommands<CommandContext>({
  audit: lazyFunction(admin, 'auditCommand'), backup: lazyFunction(admin, 'backupCommand'), identity: lazyFunction(() => import('#surfaces/core/cli-identity/index.js'), 'identityCommand'),
  // C-DOCTOR: `terminal status|chat-plan|snapshot` get their human text and single errors first; the terminal itself is unchanged (K1–K8).
  terminal: async (argv, context) => (await observe()).terminalInfoCommand(argv, context, async () => (await import('./terminal.js')).terminalCommand(argv, context)),
  init: lazyFunction(() => import('#surfaces/core/cli-installation/index.js'), 'initCommand'), monitor: lazyFunction(() => import('#surfaces/core/monitor/index.js'), 'monitorCommand'),
  uninstall: lazyFunction(() => import('#surfaces/core/cli-installation/index.js'), 'uninstallCommand'),
  workers: lazyFunction(observe, 'workersCommand'), run: runCommand, task: lazyFunction(() => import('#surfaces/core/cli-task/index.js'), 'taskCommand'),
  do: lazyFunction(cliRun, 'doCommand'),
  report: lazyFunction(cliRun, 'reportCommand'),
  pool: lazyFunction(admin, 'poolCommand'), models: lazyFunction(models, 'modelsCommand'), approval: lazyFunction(approval, 'approvalsCommand'),
  // The config surface renders through terminal-render (whose barrel carries Ink): a lazy edge keeps it off every other command's start.
  config: async (argv, context) => (await import('#surfaces/core/config/index.js')).configCommand(argv, context),
  mcp: mcpCommand, secret: lazyFunction(admin, 'secretCommand'), toolchains: toolchainsCommand, doctor: runKernelCommand,
  inventory: lazyFunction(cliRun, 'inventoryCommand'), paths: runKernelCommand, runtime: lazyFunction(admin, 'runtimeCommand'), coding: lazyFunction(admin, 'codingCommand'),
  inference: lazyFunction(models, 'inferenceCommand'), operation: lazyFunction(admin, 'operationCommand'), decide: lazyFunction(() => import('#surfaces/core/cli-decision/index.js'), 'decisionCommand'),
  memory: lazyFunction(() => import('#surfaces/core/cli-memory/index.js'), 'memoryCommand'),
  recovery: lazyFunction(approval, 'recoveryCommand'),
  hub: lazyFunction(() => import('#surfaces/core/cli-hub/index.js'), 'hubCommand'),
  agents: lazyFunction(() => import('#surfaces/core/cli-agents/index.js'), 'agentsCommand'),
  policy: async (argv, context) => (argv[1] === 'scopes' ? (await approval()).policyScopesCommand : argv[1] === 'status' || argv[1] === 'mcp' || argv[1] === 'grants' || argv[1] === 'revoke' || argv[1] === 'upgrade' || argv[1] === 'recovery' || ['delegations', 'delegate', 'undelegate'].includes(argv[1] ?? '') ? (await approval()).policyGrantsCommand : runKernelCommand)(argv, context),
});

/** Pure CLI dispatcher: returns the text to print and the exit code; no process side effects (testable). */
export function dispatch(argv: readonly string[], locale?: Locale): { readonly output: string; readonly code: ExitCode } {
  const [command] = argv;
  const l = locale ?? resolveLocale();
  const common = { name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` };
  if (command === undefined || command === '--help' || command === '-h') return { output: renderTopHelp(l ?? resolveLocale(argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined)), code: 0 };
  if (command === '--version' || command === '-v') {
    const build = readBuildIdentity();
    const line = build ? '\n' + t('cli.version.build', { tree: build.sourceTreeSha256.slice(0, 12), commit: build.sourceCommit?.slice(0, 12) ?? '-',
      dirty: build.sourceDirty ? t('cli.version.dirty', {}, l) : '', source: build.sourceCommonDir ? ` · sourceCommonDir ${build.sourceCommonDir}` : '' }, l) : '';
    return { output: t('cli.version', common, l) + line, code: 0 };
  }
  return { output: t('cli.unknownCommand', { ...common, command }, l), code: 2 };
}

/** Bare piped `deckent` prints the top help; anything else that is not a command is `--version` or an unknown command. */
function emitDispatch(argv: readonly string[], locale: Locale, context: CommandContext): ExitCode {
  const result = argv.length === 0 ? { output: renderTopHelp(locale), code: 0 as const } : dispatch(argv, locale);
  emit(result.output, { level: result.code === 0 ? 'info' : 'error', ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
  return result.code;
}

function interactiveTerminal(context: CommandContext): boolean {
  const stdin = context.stdin ?? process.stdin;
  const stdout: unknown = context.stdout ?? process.stdout;
  const term = (context.env ?? process.env)['TERM'];
  return Boolean(stdin.isTTY) && Boolean((stdout as { isTTY?: boolean }).isTTY) && term !== 'dumb';
}

export async function main(argv: readonly string[] = process.argv.slice(2), context: CommandContext = {}): Promise<ExitCode> {
  // L-KIT: the host resolved the call's locale once (config language included), so an error before a command reports its own locale
  // renders in the same language as its heading.
  let locale = context.locale ?? resolveLocale(undefined, context.env);
  try {
    assertErrorRegistry();
    const help = await cliHelpRequest(argv, CLI_COMMANDS, context.env, () => loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }), context.helpParams);
    if (help) {
      locale = help.locale; context.onLocale?.(locale);
      emit(help.output, { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
      return 0;
    }
    const terminalFlags = argv[0] === '--scope';
    const interactive = terminalFlags || (argv.length === 0 && interactiveTerminal(context)) || (argv.length === 1 && argv[0] === '--full-access');
    // `--version`, an unknown command and piped bare `deckent` need no host (COLDSTART): the host's operations load only for a command or the terminal.
    if (!interactive && !CLI_COMMANDS.some(item => item.name === argv[0])) return emitDispatch(argv, locale, context);
    if (context.loadHost) context = { ...context, ...(await context.loadHost()) };
    context.initialize?.();
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
      const launch = async (selected = context) => (await import('./terminal.js')).terminalCommand(['terminal', ...argv], { ...selected, onLocale: value => { locale = value; context.onLocale?.(value); } });
      // I-S5 (owner D8): bare `deckent` with no scope in a folder with no installation offers the guided setup to a person on a terminal.
      await launch().catch(async (error: unknown) => {
        if (argv.length !== 0 || (error as { code?: unknown } | null)?.code !== 'TERMINAL_SCOPE_REQUIRED') throw error;
        await (await import('./setup-offer.js')).offerSetup(error, context, locale, launch);
      });
      return 0;
    }
    // Installation on a Node.js below the supported floor is allowed to proceed, but never silently (a known heap overrun in older 24.x).
    if (argv[0] === 'init') {
      const node = assessNodeSupport(process.version, NODE_ENGINE_RANGE);
      if (node.status === 'unsupported') emit(t('doctor.nodeUnsupported.init', { version: node.version, floor: node.floor ?? NODE_ENGINE_RANGE }, locale), { level: 'warning', ...(context.stderr ? { stderr: context.stderr } : {}) });
    }
    const command = CLI_COMMANDS.find(item => item.path.length === 1 && item.name === argv[0]);
    if (command) {
      locale = context.locale ?? resolveLocale(argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined, context.env,
        await loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }).catch(() => undefined));
      return (await command.run(argv, { ...context, locale, onLocale: value => { locale = value; context.onLocale?.(value); } })) ?? 0;
    }
    return emitDispatch(argv, locale, context);
  } catch (error) {
    // Echo only registered command words, never an invalid argument or its potentially sensitive value.
    const path = CLI_COMMANDS.filter(item => item.path.every((part, index) => argv[index] === part)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
    const diagnostic = error instanceof DeckentError && error.code === 'CLI_USAGE' && !error.params?.['command'] && path
      ? ErrorRegistry.createError('CLI_USAGE', { locale, params: { ...error.params, command: `${PACKAGE_NAME} ${path.join(' ')}` } }) : error;
    return reportFatal(diagnostic, { ...context, argv, json: argv.includes('--json'), locale });
  }
}
