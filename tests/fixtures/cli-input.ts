import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { relative } from 'node:path';
import { expect } from 'vitest';
import { main as cliMain, runCommand as cliRunCommand } from '#surfaces/core/cli/index.js';

/** Rendering/schema fixtures exercise stdin on Windows, where the product explicitly refuses no-follow file input.
 * POSIX still exercises the authored file cases. This helper is not Windows file-input acceptance. */
async function portableInput(argv: readonly string[], context: Parameters<typeof cliMain>[1], flag: '--input' | '--graph') {
  const at = argv.indexOf(flag), source = argv[at + 1];
  if (process.platform !== 'win32' || at < 0 || !source || source === '-' || argv.includes('--branch')) return { argv, context };
  const state = expect.getState();
  console.log('verify-not-run: ' + JSON.stringify({ file: relative(process.cwd(), state.testPath ?? '').replaceAll('\\', '/'),
    test: state.currentTestName, state: 'skipped', variant: 'file-input',
    reason: 'CLI_FILE_INPUT_UNSUPPORTED: Windows no-follow file transport is refused; this rendering assertion exercises stdin instead' }));
  const bytes = await readFile(source);
  const input = [...argv]; input[at + 1] = '-';
  return { argv: input, context: { ...context, stdin: Readable.from([bytes]) } };
}
export async function main(argv: readonly string[], context: Parameters<typeof cliMain>[1] = {}) {
  const input = await portableInput(argv, context, '--input');
  return cliMain(input.argv, input.context);
}
export async function runCommand(argv: readonly string[], context: Parameters<typeof cliRunCommand>[1]) {
  const input = await portableInput(argv, context, '--graph');
  return cliRunCommand(input.argv, input.context!);
}
