import type { ShellRealmResult as HostShellResult } from '#domain/index.js';

/**
 * What the result says about processes the command left behind (Astra 2124), within the host shell's process-group contract:
 * `clean` adds nothing; `group-ended` names members of the command's group that were ended (the group was then observed empty);
 * `unverified` says the output may be incomplete and a process the command started may still run, possibly outside its group.
 * Nothing here claims a process outside the group was seen or ended.
 */
export function hostShellCleanupNote(cleanup: HostShellResult['cleanup']): string | null {
  if (cleanup === 'unverified') {
    return '[deckent] cleanup unverified: the output may be incomplete, and a process the command started may still be running, possibly '
      + 'outside its process group (that everything ended could not be verified); this is not a sandbox.';
  }
  return cleanup === 'group-ended' ? '[deckent] cleanup: processes the command left running in its process group were ended; '
    + 'a process that left the group is not observed.' : null;
}

/** The agent-facing result text of one run: sandbox notice, how it ended and after how long, the command (cut at 120), the kept output, then the
 * realm notice and the cleanup note. */
export function describeHostShellResult(command: string, result: HostShellResult, notice: string | null): string {
  const how = result.status === 'exited' ? `exit ${result.exitCode ?? `signal ${result.signal ?? '?'}`}` : result.status;
  const note = hostShellCleanupNote(result.cleanup);
  return `[deckent] run_shell: ${notice ? 'sandbox: none; ' : ''}${how} after ${(result.durationMs / 1000).toFixed(1)}s (${command.length > 120 ? `${command.slice(0, 119)}…` : command})\n${result.output}`
    + (notice ? `\n${notice}` : '')
    + (note ? `${!notice && (result.output.endsWith('\n') || result.output === '') ? '' : '\n'}${note}` : '');
}
