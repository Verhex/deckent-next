import { BUBBLEWRAP_ARGUMENT_MAX_BYTES, BUBBLEWRAP_SYSTEM_PATHS } from './arguments.js';

/**
 * S3-5: the closed view one non-shell process runs in (the headless subscription CLI). Every path is absolute and real; nothing outside it exists
 * inside the realm (bubblewrap's root is its own tmpfs), so the rest of the person's HOME (`~/.ssh`, tokens, other projects) is absent. The order
 * below is the mount order and is load-bearing: a later mount covers an earlier one.
 */
export interface IsolatedProcessView {
  /** The process's cwd and HOME: private memory (a sized tmpfs), so nothing it writes there reaches the host. */
  readonly workDir: string;
  /** Host files shown read-only at their own path inside `workDir` (the 0600 system prompt file). */
  readonly workFiles: readonly string[];
  /** Host files shown read-only at their own path: the executables the realm runs. */
  readonly executables: readonly string[];
  /** The one host directory bound read-write at its own path (the person's owner-approved CLI login dir); null: none. */
  readonly stateDir: string | null;
  /** Existing entries of `stateDir` the process must not see: each directory becomes an empty sized tmpfs, each file `/dev/null` read-only. */
  readonly stateMasks: Readonly<{ directories: readonly string[]; files: readonly string[] }>;
  /** Host Unix sockets shown at a path of the realm (the gateway that is the only way out of its empty network namespace). */
  readonly sockets: readonly Readonly<{ source: string; target: string }>[];
  /** Size of every tmpfs (`/tmp`, `workDir`, each masked directory). */
  readonly tmpfsBytes: number;
}

/**
 * bubblewrap's arguments for a view (without `-- <command>`), per the bundled 0.13.0 manual: every namespace unshared and the user namespace
 * required (`--disable-userns` needs it: the process cannot build a namespace of its own to rearrange its view), no `--share-net` (an empty
 * network namespace: only loopback), the realm dies with its launcher (PID namespace: no process outlives the call), a fresh /proc and a
 * minimal /dev. No `--new-session`: the runner starts the launcher detached (a new session without a controlling terminal, stdio pipes only),
 * and the CLI must stay in the runner's process group so SIGINT reaches it first. Null when the arguments exceed the launcher's argv bound.
 */
export function isolatedProcessArguments(view: IsolatedProcessView): string[] | null {
  const size = String(view.tmpfsBytes);
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--proc', '/proc', '--dev', '/dev', '--size', size, '--tmpfs', '/tmp'];
  for (const path of BUBBLEWRAP_SYSTEM_PATHS) args.push('--ro-bind-try', path, path);
  for (const path of view.executables) args.push('--ro-bind', path, path);
  args.push('--perms', '0700', '--size', size, '--tmpfs', view.workDir);
  if (view.stateDir) {
    args.push('--bind', view.stateDir, view.stateDir);
    for (const path of view.stateMasks.directories) args.push('--perms', '0700', '--size', size, '--tmpfs', path);
    for (const path of view.stateMasks.files) args.push('--ro-bind', '/dev/null', path);
  }
  for (const path of view.workFiles) args.push('--ro-bind', path, path);
  for (const socket of view.sockets) args.push('--ro-bind', socket.source, socket.target);
  // The realm's own root (bubblewrap's tmpfs holding the mount points) read-only last: a write outside the private memories and the bound login
  // dir fails instead of landing in memory (`--remount-ro` changes only that mount point).
  args.push('--remount-ro', '/', '--chdir', view.workDir);
  return args.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0) > BUBBLEWRAP_ARGUMENT_MAX_BYTES ? null : args;
}

/**
 * The argv that starts `command` in a view. The host POSIX shell makes the launcher ignore SIGINT (an ignored disposition survives `exec`;
 * bubblewrap only resets SIGCHLD), so a SIGINT to the runner's process group ends the CLI's turn while the realm stays up; the realm's own shell
 * sets the process limits — no core dump (a crashed CLI's memory holds its login), bounded file size and descriptors — and execs `command`.
 */
export function isolatedProcessCommand(input: Readonly<{ shell: string; launcher: string; view: IsolatedProcessView; fileSizeBlocks: number; openFiles: number;
  command: readonly string[] }>): Readonly<{ executable: string; args: readonly string[] }> | null {
  const view = isolatedProcessArguments(input.view);
  // `fileSizeBlocks` is in the shell's own unit: POSIX `ulimit -f` counts 512-byte blocks (dash; bash in POSIX mode).
  if (!view || !Number.isSafeInteger(input.fileSizeBlocks) || input.fileSizeBlocks <= 0 || !Number.isSafeInteger(input.openFiles) || input.openFiles <= 0) return null;
  // `unset PWD`: the shell's own variable never joins the command's built environment.
  const limits = `ulimit -c 0 && ulimit -f ${input.fileSizeBlocks} && ulimit -n ${input.openFiles} && unset PWD && exec "$0" "$@"`;
  return Object.freeze({ executable: input.shell, args: Object.freeze(['-c', 'trap "" INT; exec "$0" "$@"', input.launcher, ...view, '--', input.shell, '-c', limits, ...input.command]) });
}
