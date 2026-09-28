/**
 * The sandbox's view of the machine, resolved before a command runs (S9): every path is absolute and real. Nothing outside it
 * exists inside the sandbox; the order below is the mount order and is load-bearing (a later mount covers an earlier one).
 */
export interface BubblewrapView {
  /** The project root: read-write (the one place a command changes). */
  readonly projectRoot: string;
  /** The conversation's scratch area (SCR-A; the command's TMPDIR): read-write. */
  readonly scratchDir: string | null;
  /** The service user's HOME: an empty tmpfs (never bound — `~/.ssh`, `~/.aws`, tokens and the product ledger stay invisible). */
  readonly home: string | null;
  /** System prefixes bound read-only when present (an allowlist: never the whole root). */
  readonly systemPaths: readonly string[];
  /** PATH entries outside the system prefixes (a toolchain under HOME, e.g. nvm) with their `lib` siblings: read-only when present. */
  readonly toolchainPaths: readonly string[];
  /** Repository directories (`.git`, a worktree's gitdir and common dir): read-only over the writable project (owner 2026-09-28). */
  readonly readOnlyPaths: readonly string[];
  /** Denied directories inside the project: an empty tmpfs in their place. */
  readonly maskedDirectories: readonly string[];
  /** Denied files inside the project: `/dev/null` bound read-only in their place. A plain (non-device) bind carries `nodev`, so the
   * file opens with EACCES either way: no bytes are readable, no write lands; it is protected, not absent. */
  readonly maskedFiles: readonly string[];
}

/** Size of each tmpfs (`/tmp`, HOME): a runaway write fills the sandbox, never the host. */
export const BUBBLEWRAP_TMPFS_BYTES = 64 * 1024 * 1024;
/** Directories a system toolchain lives in; bound read-only when they exist. `/var`, `/run`, `/mnt` (WSL drives), `/media`, `/root`,
 * `/home` and `/srv` are not among them: sockets, other users, removable and foreign drives stay outside. */
export const BUBBLEWRAP_SYSTEM_PATHS: readonly string[] = Object.freeze(['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt',
  '/snap', '/nix', '/sys']);

/**
 * bubblewrap's argument list for a view (without the trailing `-- <command>`): all namespaces unshared (network included), the
 * sandbox dies with the service process (PID namespace: every process a command started ends with the call, a `setsid` escapee
 * included), a new session (no TIOCSTI injection into the owner's terminal), fresh /proc and a minimal /dev.
 */
export function bubblewrapArguments(view: BubblewrapView): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev',
    '--size', String(BUBBLEWRAP_TMPFS_BYTES), '--tmpfs', '/tmp'];
  if (view.home) args.push('--size', String(BUBBLEWRAP_TMPFS_BYTES), '--tmpfs', view.home);
  for (const path of view.systemPaths) args.push('--ro-bind-try', path, path);
  for (const path of view.toolchainPaths) args.push('--ro-bind-try', path, path);
  args.push('--bind', view.projectRoot, view.projectRoot);
  for (const path of view.readOnlyPaths) args.push('--ro-bind', path, path);
  for (const path of view.maskedDirectories) args.push('--tmpfs', path);
  for (const path of view.maskedFiles) args.push('--ro-bind', '/dev/null', path);
  if (view.scratchDir) args.push('--bind', view.scratchDir, view.scratchDir);
  args.push('--chdir', view.projectRoot);
  return args;
}
