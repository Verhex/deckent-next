import { isAbsolute, relative, resolve, sep } from 'node:path';
import { modelTextPrefix, type ShellRealmResult as HostShellResult } from '#domain/index.js';
import { shellNamedPaths } from '#engine/index.js';
import { LOCALES, t, type Locale } from '#platform/index.js';
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
  return `[deckent] run_shell: ${tracked ? `tracked: deleted=${tracked.deleted} overwritten=${tracked.overwritten}; ` : ''}${realm?.marker ? `${realm.marker}; ` : ''}${how} after ${(result.durationMs / 1000).toFixed(1)}s (${command.length > 120 ? `${modelTextPrefix(command, 119)}…` : command})\n${result.output}`
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
/** The kernel's EROFS text as a command prints it (glibc's message; a translated one under another installed locale is not matched, and the
 * result then stays as it was). Measured 2026-10-07 in bubblewrap: `unlink: cannot unlink 'src/x': Read-only file system`. */
const READ_ONLY_FILE_SYSTEM = /Read-only file system/u;
const NAMED_PATHS_SHOWN = 5;
/**
 * B3 (owner terminal test 2026-10-07): a sandboxed command whose write failed on a protected path (Deckent's own source, the write floor) got only
 * the raw "Read-only file system". When its output carries that error and it names such a path, the result says, in the person's language,
 * which path, why, and what can change it (the edit tools ask for approval; full access) — the model reads the same text. Authority is
 * unchanged: the sandbox still keeps the path read-only; asking for the shell is the PROTECTED-PATHS card's work.
 */
export function protectedPathShellNote(command: string, output: string, isProtected: (path: string) => boolean, language: Locale = LOCALES[0]): string | null {
  if (!READ_ONLY_FILE_SYSTEM.test(output)) return null;
  const paths = shellNamedPaths(command, isProtected);
  if (paths.length === 0) return null;
  const shown = `${paths.slice(0, NAMED_PATHS_SHOWN).join(', ')}${paths.length > NAMED_PATHS_SHOWN ? ` (+${paths.length - NAMED_PATHS_SHOWN})` : ''}`;
  return `[deckent] ${t('agent.shell.protectedPathReadOnly', { paths: shown }, language)}`;
}
/** A word a command names, as a project-relative path the turn's write floor holds (outside the project: never). */
export const onWriteFloor = (root: string, floor: (rel: string) => boolean) => (text: string) => {
  const rel = relative(root, resolve(root, text));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && floor(rel.split(sep).join('/'));
};
