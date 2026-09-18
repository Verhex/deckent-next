import { runCommand } from './run.js';
import { runInventoryCommand } from './inventory.js';
import { taskCommand } from './task.js';
import { runtimeCommand } from './runtime.js';
import { PACKAGE_NAME, PACKAGE_VERSION, t, emit, assertErrorRegistry, reportFatal, resolveLocale, type ExitCode } from '#platform/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';
export type { ExitCode } from '#platform/index.js';

/** Pure CLI dispatcher: returns the text to print and the exit code; no process side effects (testable). */
export function dispatch(argv: readonly string[]): { readonly output: string; readonly code: ExitCode } {
  const [command] = argv;
  const common = { name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` };
  if (command === undefined || command === '--help' || command === '-h') return { output: t('cli.help', common), code: 0 };
  if (command === '--version' || command === '-v') return { output: t('cli.version', common), code: 0 };
  return { output: t('cli.unknownCommand', { ...common, command }), code: 2 };
}

export async function main(argv: readonly string[] = process.argv.slice(2), context: CommandContext = {}): Promise<ExitCode> {
  let locale = resolveLocale(undefined, context.env);
  try {
    assertErrorRegistry();
    const scoped = argv[0] === 'run' || argv[0] === 'task';
    const helpAt = scoped ? ((argv[1] === '--help' || argv[1] === '-h') ? 1 : (argv[2] === '--help' || argv[2] === '-h') ? 2 : -1) : -1;
    if (scoped && helpAt >= 0 && (argv.length === helpAt + 1 || (argv.length === helpAt + 3 && argv[helpAt + 1] === '--lang' && !!argv[helpAt + 2] && !argv[helpAt + 2]!.startsWith('-')))) {
      locale = resolveLocale(argv[helpAt + 2], context.env); context.onLocale?.(locale);
      emit(argv[0] === 'run' ? t('cli.help.run', {}, locale) : t('cli.help.task', {}, locale),
        { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
      return 0;
    }
    context.initialize?.();
    if (argv[0] === 'run') {
      await runCommand(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } });
      return 0;
    }
    if (argv[0] === 'inventory') {
      await runInventoryCommand(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } });
      return 0;
    }
    if (argv[0] === 'task') { await taskCommand(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } }); return 0; }
    if (argv[0] === 'runtime') { await runtimeCommand(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } }); return 0; }
    if (argv[0] === 'policy' || argv[0] === 'config' || argv[0] === 'doctor' || argv[0] === 'paths') {
      await runKernelCommand(argv, { ...context, onLocale: value => { locale = value; context.onLocale?.(value); } });
      return 0;
    }
    const result = dispatch(argv);
    emit(result.output, { level: result.code === 0 ? 'info' : 'error', ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return result.code;
  } catch (error) {
    return reportFatal(error, { ...context, argv, json: argv.includes('--json'), locale });
  }
}
