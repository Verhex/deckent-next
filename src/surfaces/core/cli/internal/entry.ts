import { currentTiming } from '#platform/index.js';
import { registerCliCommands, renderTopHelp, cliHelpRequest, cliInstallationContract, lazyFunction } from '#surfaces/core/cli-kit/index.js';
import { isCodedError, PACKAGE_NAME, PACKAGE_VERSION, NODE_ENGINE_RANGE, assessNodeSupport, readBuildIdentity, isSourceCheckout, t, emit, reportFatal, resolveLocale, loadConfigLanguage, DeckentError, ErrorRegistry, type ExitCode, type Locale } from '#platform/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';
export type { ExitCode } from '#platform/index.js';

// COLDSTART: every family loads on its first call (each reaches the engine barrel); help, `--version` and an unknown command load none of them.
const admin = () => import('#surfaces/core/cli-admin/index.js'), approval = () => import('#surfaces/core/cli-approval/index.js');
const observe = () => import('#surfaces/core/cli-observe/index.js'), cliRun = () => import('#surfaces/core/cli-run/index.js');
const models = () => import('#surfaces/core/cli-models/index.js');
export const runCommand = lazyFunction(cliRun, 'runCommand'), readGraphInput = lazyFunction(cliRun, 'readGraphInput');
export const toolchainsCommand = lazyFunction(admin, 'toolchainsCommand');
export const mcpCommand = lazyFunction(() => import('./mcp.js'), 'mcpCommand'), mcpSlash = lazyFunction(() => import('./mcp.js'), 'mcpSlash');

export const CLI_COMMANDS = registerCliCommands<CommandContext>({
  beuser: lazyFunction(() => import('#surfaces/core/cli-beuser/index.js'), 'beuserCommand'),
  audit: lazyFunction(admin, 'auditCommand'), backup: lazyFunction(admin, 'backupCommand'), identity: lazyFunction(() => import('#surfaces/core/cli-identity/index.js'), 'identityCommand'),
  // C-DOCTOR: `terminal status|chat-plan|snapshot` get their human text and single errors first; the terminal itself is unchanged (K1–K8).
  terminal: async (argv, context) => (await observe()).terminalInfoCommand(argv, context, async () => (await import('./terminal.js')).terminalCommand(argv, context)),
  init: lazyFunction(() => import('#surfaces/core/cli-installation/index.js'), 'initCommand'), monitor: lazyFunction(() => import('#surfaces/core/monitor/index.js'), 'monitorCommand'),
  uninstall: lazyFunction(() => import('#surfaces/core/cli-installation/index.js'), 'uninstallCommand'),
  workers: lazyFunction(observe, 'workersCommand'), run: runCommand, task: lazyFunction(() => import('#surfaces/core/cli-task/index.js'), 'taskCommand'),
  do: lazyFunction(cliRun, 'doCommand'),
  report: lazyFunction(cliRun, 'reportCommand'),
  pool: lazyFunction(admin, 'poolCommand'),
  // Owner 2026-11-06: `models catalog brain` is a governed config write; the config surface owns it (it already depends on cli-models).
  models: async (argv, context) => (await models()).modelsCommand(argv, { ...context, brainOffer: async args => (await import('#surfaces/core/config/index.js')).brainOfferCommand(args, context) }), approval: lazyFunction(approval, 'approvalsCommand'),
  config: async (argv, context) => (await import('#surfaces/core/config/index.js')).configCommand(argv, context),
  mcp: mcpCommand, secret: lazyFunction(admin, 'secretCommand'), toolchains: toolchainsCommand, doctor: runKernelCommand,
  inventory: lazyFunction(cliRun, 'inventoryCommand'), paths: runKernelCommand, runtime: lazyFunction(admin, 'runtimeCommand'), coding: lazyFunction(admin, 'codingCommand'),
  inference: lazyFunction(models, 'inferenceCommand'), operation: lazyFunction(admin, 'operationCommand'), decide: lazyFunction(() => import('#surfaces/core/cli-decision/index.js'), 'decisionCommand'),
  memory: lazyFunction(() => import('#surfaces/core/cli-memory/index.js'), 'memoryCommand'),
  recovery: lazyFunction(approval, 'recoveryCommand'),
  hub: lazyFunction(() => import('#surfaces/core/cli-hub/index.js'), 'hubCommand'),
  agents: lazyFunction(() => import('#surfaces/core/cli-agents/index.js'), 'agentsCommand'),
  policy: async (argv, context) => (argv[1] === 'scopes' ? (await approval()).policyScopesCommand : argv[1] === 'status' || argv[1] === 'show' || argv[1] === 'mcp' || argv[1] === 'grants' || argv[1] === 'revoke' || argv[1] === 'upgrade' || argv[1] === 'recovery' || ['delegations', 'delegate', 'undelegate'].includes(argv[1] ?? '') ? (await approval()).policyGrantsCommand : runKernelCommand)(argv, context),
});

/** Words after -- belong to the invoked program, including its language and help flags. */
function invocationArgs(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf('--'); return separator < 0 ? argv : argv.slice(0, separator);
}

/** Pure CLI dispatcher: returns the text to print and the exit code; no process side effects (testable). */
export function dispatch(argv: readonly string[], locale?: Locale): { readonly output: string; readonly code: ExitCode } {
  const [command] = argv;
  const flags = invocationArgs(argv), languageAt = flags.indexOf('--lang');
  const l = locale ?? resolveLocale(languageAt < 0 ? undefined : flags[languageAt + 1]);
  const common = { name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` };
  if (command === undefined || command === '--help' || command === '-h') return { output: renderTopHelp(l), code: 0 };
  if (command === '--version' || command === '-v') {
    const build = readBuildIdentity();
    const line = build ? '\n' + t('cli.version.build', { tree: build.sourceTreeSha256.slice(0, 12), commit: build.sourceCommit?.slice(0, 12) ?? '-',
      dirty: build.sourceDirty ? t('cli.version.dirty', {}, l) : '', source: build.sourceCommonDir && isSourceCheckout() ? ` · sourceCommonDir ${build.sourceCommonDir}` : '' }, l) : '';
    return { output: t('cli.version', common, l) + line, code: 0 };
  }
  return { output: t('cli.unknownCommand', { ...common, command }, l), code: 2 };
}

/** Bare piped `deckent` prints the top help; anything else that is not a command is `--version` or an unknown command. */
function emitDispatch(argv: readonly string[], locale: Locale, context: CommandContext): ExitCode | Promise<ExitCode> {
  const result = argv.length === 0 ? { output: renderTopHelp(locale), code: 0 as const } : dispatch(argv, locale);
  // BeUser KER-14: `--json` keeps its contract for an unknown command too: one typed error object on stderr, never plain text.
  if (result.code !== 0 && argv.includes('--json')) return reportFatal(ErrorRegistry.createError('CLI_COMMAND_UNKNOWN', { locale, params: { command: argv[0] ?? '', name: PACKAGE_NAME } }),
    { ...context, argv, json: true, locale });
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
  // R34: `--lang <locale>` is a global option (top help); before the command word it means the same as after it.
  let flags = invocationArgs(argv);
  if (flags[0] === '--lang' && flags[1] !== undefined && !flags[1].startsWith('-')) {
    argv = [...flags.slice(2), '--lang', flags[1], ...argv.slice(flags.length)]; flags = invocationArgs(argv);
  }
  const languageAt = flags.indexOf('--lang'), language = languageAt < 0 ? undefined : flags[languageAt + 1];
  const words = flags.length === argv.length && flags.at(-2) === '--lang' ? flags.slice(0, -2) : argv;
  // L-KIT: the host resolved the call's locale once (config language included), so an error before a command reports its own locale
  // renders in the same language as its heading.
  let locale = context.locale ?? resolveLocale(undefined, context.env), shell: import('#surfaces/core/terminal-host/index.js').TerminalShell | null = null;
  try {
    currentTiming()?.phase('dispatch');
    const helpAt = flags.findIndex(word => word === '--help' || word === '-h');
    const helpArgv = languageAt >= 0 && languageAt < helpAt ? [...flags.slice(0, languageAt), ...flags.slice(languageAt + 2), ...flags.slice(languageAt, languageAt + 2)] : flags;
    const help = await cliHelpRequest(helpArgv, CLI_COMMANDS, context.env, () => loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }), context.helpParams, async (locale, query) => (await import('#surfaces/core/terminal-labels/index.js')).terminalCommandHelp(locale, query));
    if (help) {
      locale = help.locale; context.onLocale?.(locale);
      emit(help.output, { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
      return 0;
    }
    const terminalFlags = argv[0] === '--scope';
    const interactive = terminalFlags || (words.length === 0 && interactiveTerminal(context)) || (words.length === 1 && words[0] === '--full-access');
    // `--version`, an unknown command and piped bare `deckent` need no host (COLDSTART): the host's operations load only for a command or the terminal.
    if (!interactive && !CLI_COMMANDS.some(item => item.name === argv[0])) return emitDispatch(words, locale, context);
    // alpha.60 C (P4): where the Workline will open in the full window, its frame is drawn before the host graph loads (`launch-shell`).
    // A shell that cannot be drawn is no refusal: the launch goes on the earlier path.
    if (interactive && interactiveTerminal(context)) shell = await (await import('./launch-shell.js')).openLaunchShell(words, language, context).catch(() => null);
    if (shell) context = { ...context, terminalShell: shell };
    if (context.loadHost) context = { ...context, ...(await context.loadHost(shell ? () => shell!.host.flushed() : undefined)) };
    await shell?.host.flushed(); // drain keys from the last import before identity/setup can replace the composer
    if (shell && !shell.host.open()) return 0; // Astra 2860 R1: the person closed the shell while the host loaded: the launch stops, nothing else runs
    context.initialize?.();
    // ID-1C: the relocation stop precedes every installation-bound command. Commands that own their installation load/recovery and
    // identity check (config, init) or need no installation (policy vocabulary) declare it in the catalog and are not gated here.
    if (context.loadInstallationIdentity && (interactive || CLI_COMMANDS.some(item => item.name === argv[0]))
      && cliInstallationContract(argv, CLI_COMMANDS) === undefined) {
      locale = resolveLocale(language, context.env,
        await loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }));
      await context.loadInstallationIdentity(context.root ?? process.cwd(), { ...(context.env ? { env: context.env } : {}), globalOnly: argv.includes('--global') });
    }
    // `deckent` alone opens the interactive terminal on a real terminal; piped or dumb terminals get help (owner 2026-09-23).
    // `deckent --full-access` (MODES-3) opens it in full access; without a terminal it is refused by the terminal itself (never silent).
    if (interactive) {
      const launch = async (selected = context) => (await import('./terminal.js'))
        .terminalCommand(['terminal', ...argv], { ...selected, onLocale: value => { locale = value; context.onLocale?.(value); } });
      // I-S5 (owner D8): bare `deckent` with no scope in a folder with no installation offers the guided setup to a person on a terminal.
      const result = await launch().catch(async (error: unknown) => {
        if (argv.length !== 0 || !isCodedError(error, 'TERMINAL_SCOPE_REQUIRED')) throw error;
        return (await import('./setup-offer.js')).offerSetup(error, context, locale, launch);
      });
      await shell?.host.close(); // the Workline did not take the shell (it closed or the launch returned early)
      if (result === 'cancelled') {
        await reportFatal(ErrorRegistry.createError('CLI_INSTALLATION_MISSING'), { ...context, argv, locale });
        return 1;
      }
      return result ?? 0;
    }
    // Installation on a Node.js below the supported floor is allowed to proceed, but never silently (a known heap overrun in older 24.x).
    if (argv[0] === 'init') {
      const node = assessNodeSupport(process.version, NODE_ENGINE_RANGE);
      if (node.status === 'unsupported') emit(t('doctor.nodeUnsupported.init', { version: node.version, floor: node.floor ?? NODE_ENGINE_RANGE }, locale), { level: 'warning', ...(context.stderr ? { stderr: context.stderr } : {}) });
    }
    const command = CLI_COMMANDS.find(item => item.path.length === 1 && item.name === argv[0]);
    if (command) {
      locale = context.locale ?? resolveLocale(language, context.env,
        await loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }).catch(() => undefined));
      return (await command.run(argv, { ...context, locale, onLocale: value => { locale = value; context.onLocale?.(value); } })) ?? 0;
    }
    return emitDispatch(words, locale, context);
  } catch (error) {
    // A refusal after the shell's frame (the relocation stop, identity admission) leaves the full window first: the same text, the same exit code.
    await shell?.host.close();
    // Echo only registered command words, never an invalid argument or its potentially sensitive value.
    const path = CLI_COMMANDS.filter(item => item.path.every((part, index) => argv[index] === part)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
    const diagnostic = error instanceof DeckentError && error.code === 'CLI_USAGE' && !error.params?.['command'] && path
      ? ErrorRegistry.createError('CLI_USAGE', { locale, params: { ...error.params, command: `${PACKAGE_NAME} ${path.join(' ')}` } }) : error;
    return reportFatal(diagnostic, { ...context, argv, json: argv.includes('--json'), locale });
  }
}
