import { resolve } from 'node:path';
import { terminalProgram } from './approval-terminal.js';

/** Runs the built operator command on a real controlling PTY. The driver sends the
 * explicit answer only after the production card's y/N prompt has been displayed. */
export async function deliveryTerminalCli(project: string, env: NodeJS.ProcessEnv, args: string[], answer: string) {
  const result = await terminalProgram([process.execPath, resolve('dist/composition/core/cli/internal/entry.js'), ...args], env, project, 'tty', answer);
  const exit = (result.status & 127) === 0 ? result.status >> 8 : 128 + (result.status & 127);
  // PTY merges stdout/stderr: retain the full card separately from the CLI's JSON result/error.
  const line = result.output.split(/\r?\n/u).findLast(value => value.startsWith('{'));
  if ((args.includes('--json') || exit !== 0) && !line) throw new Error(result.output);
  return { exit, stdout: line ?? result.output, output: result.output,
    code: exit === 0 ? null : (JSON.parse(line!) as { code: string }).code };
}
