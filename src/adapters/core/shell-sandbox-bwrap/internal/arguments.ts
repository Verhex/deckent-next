import { dirname } from 'node:path';

/**
 * The sandbox's view of the machine, resolved before a command runs (S9): every path is absolute and real. Nothing outside it
 * exists inside the sandbox; the order below is the mount order and is load-bearing (a later mount covers an earlier one). The open view
 * also pins the ancestors of its protective mounts, right after the root bind (`ancestorPins`, Astra 2189 R7); a closed view with a
 * writable project, right after the project bind.
 */
export interface BubblewrapView {
  /** The project root: read-write (the one place a command changes). */
  readonly projectRoot: string;
  /** Astra 2170 R1: the project bound read-only (an unbounded call the owner did not approve); absent = read-write. */
  readonly projectReadOnly?: boolean;
  /** SHELL-OVERLAY: the project mounted as an overlay (the real project the only lower layer) whose writes land in `upper` (bubblewrap
   * ≥ 0.11); both directories are Deckent's own, outside the project and outside this view. Replaces the project bind. */
  readonly overlay?: { readonly upper: string; readonly work: string };
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
  /** MODES-3 full access: a worktree's common repository outside the project, bound read-write (absent: none). */
  readonly writablePaths?: readonly string[];
  /** Denied directories inside the project: an empty tmpfs in their place. */
  readonly maskedDirectories: readonly string[];
  /** Directories inside the project that hold the product's state and nothing of the project's own: an empty read-only tmpfs in their place, so
   * neither their content nor the names of their entries are visible and nothing can be created in them (SANDBOX-AD-SIZINTISI). Remounted
   * read-only after every other mount, like a hidden root; the scratch area's mount point inside one is made first and stays writable. */
  readonly emptiedDirectories?: readonly string[];
  /** Denied files inside the project: `/dev/null` bound read-only in their place. A plain (non-device) bind carries `nodev`, so the
   * file opens with EACCES either way: no bytes are readable, no write lands; it is protected, not absent. */
  readonly maskedFiles: readonly string[];
  /**
   * OPEN-SANDBOX (a full-access call): the host's root is bound read-write as the user sees it and the network namespace is kept (no system
   * allowlist, no toolchain binds, no private `/tmp` or HOME tmpfs); the PID namespace, `--die-with-parent`, `--new-session`, a fresh
   * `/proc` and a minimal `/dev` stay. The hard floor is sealed structurally: `sealed` state roots inside the project are bound read-only
   * over the project (their product state masked by the deny walk, so no name, existing or new, is created there), `hidden` ones outside it
   * become an empty tmpfs remounted read-only after every other mount (the scratch area's mount point inside one is made first). Every
   * ancestor of a protective mount is itself a mount point (`ancestorPins`): renaming it fails with EBUSY (R7).
   */
  readonly open?: { readonly sealed: readonly string[]; readonly hidden: readonly string[] };
}

/** Size of each tmpfs (`/tmp`, HOME): a runaway write fills the sandbox, never the host. */
export const BUBBLEWRAP_TMPFS_BYTES = 64 * 1024 * 1024;
/** Directories a system toolchain lives in; bound read-only when they exist. `/var`, `/run`, `/mnt` (WSL drives), `/media`, `/root`,
 * `/home` and `/srv` are not among them: sockets, other users, removable and foreign drives stay outside. */
export const BUBBLEWRAP_SYSTEM_PATHS: readonly string[] = Object.freeze(['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt',
  '/snap', '/nix', '/sys']);

/** Astra 2189 R7: the most ancestor directories a view pins as mount points (beyond it the view is refused, never run with a
 * renamable ancestor). Measured 2026-09-30 on the owner's HOME from a worktree: 32 pins (HOME, directories above masked credentials and
 * the state roots), a `true` call 6.9 → 8.6 ms. */
export const BUBBLEWRAP_ANCESTOR_PIN_MAX = 1_024;

/** One mount of a view in argument order: its target, its arguments, and whether what it shows is the host's own writable tree (a
 * self-bind) — a directory under such a mount can be renamed; under any other (read-only bind, tmpfs, `/dev/null`) it cannot or it vanishes
 * with the call. */
interface ViewMount { readonly target: string; readonly args: readonly string[]; readonly hostWritable: boolean; readonly protective: boolean }
const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The mounts after the root (and `/proc`, `/dev`) in the order bubblewrap applies them: a later mount covers an earlier one. */
function viewMounts(view: BubblewrapView): ViewMount[] {
  const mounts: ViewMount[] = [];
  const add = (target: string, args: readonly string[], hostWritable: boolean, protective: boolean) => mounts.push({ target, args, hostWritable, protective });
  if (view.home && !view.open) add(view.home, ['--size', String(BUBBLEWRAP_TMPFS_BYTES), '--tmpfs', view.home], false, false);
  for (const path of view.systemPaths) add(path, ['--ro-bind-try', path, path], false, false);
  for (const path of view.toolchainPaths) add(path, ['--ro-bind-try', path, path], false, false);
  if (view.overlay) add(view.projectRoot, ['--overlay-src', view.projectRoot, '--overlay', view.overlay.upper, view.overlay.work, view.projectRoot], false, false);
  else add(view.projectRoot, [view.projectReadOnly ? '--ro-bind' : '--bind', view.projectRoot, view.projectRoot], !view.projectReadOnly, false);
  for (const path of view.open?.sealed ?? []) add(path, ['--ro-bind', path, path], false, true);
  for (const path of view.writablePaths ?? []) add(path, ['--bind', path, path], true, false);
  for (const path of view.readOnlyPaths) add(path, ['--ro-bind', path, path], false, true);
  for (const path of view.maskedDirectories) add(path, ['--tmpfs', path], false, true);
  for (const path of view.emptiedDirectories ?? []) add(path, ['--perms', '0555', '--tmpfs', path], false, true);
  for (const path of view.maskedFiles) add(path, ['--ro-bind', '/dev/null', path], false, true);
  for (const path of view.open?.hidden ?? []) add(path, ['--perms', '0700', '--tmpfs', path], false, true);
  if (view.scratchDir) add(view.scratchDir, ['--bind', view.scratchDir, view.scratchDir], true, true);
  return mounts;
}

/**
 * Astra 2189 R7: the ancestor directories a view makes mount points, each with the mount it follows (`-1`: the open view's root bind).
 * A protective mount (a sealed/hidden state root, a read-only path, a mask, the scratch area) protects a path, not its parent: where the
 * parent is the host's writable tree, `mv` of it carries the mount away with the renamed directory and a command could recreate the
 * original path with bytes of its choosing. A directory that is a mount point in the sandbox's mount namespace cannot be renamed or
 * removed (EBUSY — the kernel checks the directory itself, so this holds even where a later bind of the same host tree covers the pin), so
 * every ancestor of a protective target — up to, not including, `/` — is bound onto itself; not one that is already a mount target, nor
 * one under a mount that is not the host's writable tree (a read-only bind refuses the rename with EROFS; a tmpfs, the closed views'
 * root, is the call's own). An ancestor under an owner-Y writable directory of a sealed root is (that directory is the host's tree again).
 * Placement: right after the first host-writable mount that holds it — the open view's root bind (so before every other mount), a closed
 * view's writable project bind, a writable path — so the pin binds the host's directory and precedes every protective mount beneath it
 * (`--bind` is recursive and binds the HOST's source: after a protective mount it would cover that mount with the host's writable tree).
 * Never in an overlay view (a self-bind would resolve to the host's lower directory and bypass the write set) or a read-only project.
 */
function placedPins(view: BubblewrapView): { readonly path: string; readonly after: number }[] {
  if (!view.open && (view.overlay || view.projectReadOnly)) return [];
  const mounts = viewMounts(view), targets = new Set(mounts.map(mount => mount.target));
  const out = new Map<string, number>();
  for (const mount of mounts) {
    if (!mount.protective) continue;
    // Every platform root is a fixed point of dirname (a Windows drive or UNC root too); never loop there synchronously.
    for (let path = dirname(mount.target); path !== '/' && path !== '.' && path !== dirname(path); path = dirname(path)) {
      if (out.has(path)) break;
      if (targets.has(path)) continue;
      // The mount that shows this directory: the last one (in argument order) whose target holds it; none = the root (the open view's
      // host bind, a closed view's own tmpfs). The pin follows the first host-writable one holding it.
      let coverWritable = view.open !== undefined, first = view.open ? -1 : null;
      for (let index = 0; index < mounts.length; index++) {
        if (!within(path, mounts[index]!.target)) continue;
        coverWritable = mounts[index]!.hostWritable;
        if (first === null && coverWritable) first = index;
      }
      if (coverWritable && first !== null) out.set(path, first);
    }
  }
  const depth = (path: string) => path.split('/').length;
  return [...out].map(([path, after]) => ({ path, after })).sort((a, b) => a.after - b.after || depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** The ancestor directories a view pins (`placedPins`), outermost first within each placement. */
export const ancestorPins = (view: BubblewrapView): string[] => placedPins(view).map(pin => pin.path);

/**
 * bubblewrap's argument list for a view (without the trailing `-- <command>`): all namespaces unshared (network included), the
 * sandbox dies with the service process (PID namespace: every process a command started ends with the call, a `setsid` escapee
 * included), a new session (no TIOCSTI injection into the owner's terminal), fresh /proc and a minimal /dev.
 */
export function bubblewrapArguments(view: BubblewrapView): string[] {
  // Order is load-bearing (the man page: applied in argument order): `--share-net` after `--unshare-all` keeps the host network; the root
  // bind before `/proc` and `/dev`, which cover the host's. R7: each ancestor pin right after the host-writable mount it follows (`placedPins`).
  const pins = new Map<number, string[]>();
  for (const pin of placedPins(view)) pins.set(pin.after, [...(pins.get(pin.after) ?? []), '--bind', pin.path, pin.path]);
  const args = view.open ? ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--bind', '/', '/', ...pins.get(-1) ?? [], '--proc', '/proc', '--dev', '/dev']
    : ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--size', String(BUBBLEWRAP_TMPFS_BYTES), '--tmpfs', '/tmp'];
  viewMounts(view).forEach((mount, index) => args.push(...mount.args, ...pins.get(index) ?? []));
  // `--remount-ro` changes only that mount point (man page), so a scratch area bound inside a hidden root stays writable.
  for (const path of view.open?.hidden ?? []) args.push('--remount-ro', path);
  for (const path of view.emptiedDirectories ?? []) args.push('--remount-ro', path);
  args.push('--chdir', view.projectRoot);
  return args;
}
