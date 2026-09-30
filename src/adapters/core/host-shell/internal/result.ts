import type { ShellRealmResult as HostShellResult } from '#domain/index.js';
import { HOST_SHELL_RUN_OPERATION } from './target.js';

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

/** The agent-facing result text of one run: the realm marker, how it ended and after how long, the command (cut at 120), the kept
 * output, then the realm notice and the cleanup note. FA-TRACKED-WARN: a full-access call that deleted or overwrote git-tracked files
 * leads with `tracked: deleted=N overwritten=M; ` — the first thing after the tool prefix, so neither the command's text nor its output
 * can supply it (the terminal's finished line reads it from there, `trackedChangesOfToolResult`). */
export function describeHostShellResult(command: string, result: HostShellResult, realm: { readonly marker: string | null; readonly notice: string | null } | null,
  tracked?: { readonly deleted: number; readonly overwritten: number }): string {
  const how = result.status === 'exited' ? `exit ${result.exitCode ?? `signal ${result.signal ?? '?'}`}` : result.status;
  const note = hostShellCleanupNote(result.cleanup), notice = realm?.notice ?? null;
  return `[deckent] run_shell: ${tracked ? `tracked: deleted=${tracked.deleted} overwritten=${tracked.overwritten}; ` : ''}${realm?.marker ? `${realm.marker}; ` : ''}${how} after ${(result.durationMs / 1000).toFixed(1)}s (${command.length > 120 ? `${command.slice(0, 119)}…` : command})\n${result.output}`
    + (notice ? `\n${notice}` : '')
    + (note ? `${!notice && (result.output.endsWith('\n') || result.output === '') ? '' : '\n'}${note}` : '');
}

/** The agent-facing notes a shell call's result may carry beyond the run itself (its write posture and how it ended). */
export const HOST_SHELL_NOTES = Object.freeze({
  /** Told to the model when an unattended run failed with the project read-only (so it changes files another way, not by retrying). */
  projectReadOnly: '[deckent] the project was read-only for this unattended run: change project files with the edit tools, or with a command the owner approves.',
  /** SHELL-OVERLAY: a full-auto call whose writes could not be kept aside (no private directory outside the project) ran read-only. */
  writeSetUnavailable: '[deckent] write set: unavailable here (no private directory outside the project); the project was read-only for this run.',
  /** SHELL-OVERLAY: a run that was stopped kept its writes aside; none of them reached the project. */
  writeSetDiscarded: '[deckent] the command was stopped; what it changed was kept aside and not applied (the project is unchanged by it).',
  /** A run stopped in a posture that wrote directly: what it changed is not known. */
  stoppedUnknown: '[deckent] the command was stopped; what it changed before that is unknown.',
});

/** The agent-facing result of a shell call whose effect produced no run (policy, approval, not started): its typed code in words. */
export function describeShellEffectRefusal(code: unknown): string {
  const why = code === 'POLICY_DENIED' ? `denied by policy (operation ${HOST_SHELL_RUN_OPERATION.operation.id})`
    : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the command needs an approval that was not given'
    : code === 'EFFECT_REJECTED' ? 'the command could not start'
    : typeof code === 'string' && code.startsWith('APPROVAL_') ? `the approval for this call could not be verified (${code}); nothing was run`
    : typeof code === 'string' ? code : 'failed';
  return `[deckent] run_shell: error=${why}`;
}
