#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PACKAGE_NAME, PACKAGE_VERSION, t, emit, assertErrorRegistry, reportFatal, resolveLocale, type ExitCode } from '#kernel/index.js';
import { registerProviderConfig } from '#providers/index.js';
import { runKernelCommand, type CommandContext } from './kernel-commands.js';
export type { ExitCode } from '#kernel/index.js';

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
    registerProviderConfig();
    if (argv[0] === 'config' || argv[0] === 'doctor') {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
