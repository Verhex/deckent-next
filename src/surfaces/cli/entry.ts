#!/usr/bin/env node
import { PACKAGE_NAME, PACKAGE_VERSION, t } from '../../kernel/index.js';

export type ExitCode = 0 | 2;

/** Pure CLI dispatcher: returns the text to print and the exit code; no process side effects (testable). */
export function dispatch(argv: readonly string[]): { readonly output: string; readonly code: ExitCode } {
  const [command] = argv;
  const common = { name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` };
  if (command === undefined || command === '--help' || command === '-h') return { output: t('cli.help', common), code: 0 };
  if (command === '--version' || command === '-v') return { output: t('cli.version', common), code: 0 };
  return { output: t('cli.unknownCommand', { ...common, command }), code: 2 };
}

export function main(argv: readonly string[] = process.argv.slice(2)): ExitCode {
  const result = dispatch(argv);
  (result.code === 0 ? process.stdout : process.stderr).write(`${result.output}\n`);
  return result.code;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main();
}
