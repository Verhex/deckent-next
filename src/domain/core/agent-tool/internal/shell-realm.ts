/** Shell execution port: implementations own isolation, process lifetime and bounded output; callers retain policy/effect authority. */
export type ShellRealmMode = 'require-sandbox' | 'prefer-sandbox' | 'host';
/**
 * What a chosen realm contains (SHELL-AUTONOMY, owner 2026-09-28): `sandbox` — an enforced sandbox (bubblewrap, Landlock at full ABI);
 * `degraded` — a sandbox with typed gaps (Landlock below ABI 6); `host` — no sandbox. A permission decision input: only `sandbox`
 * lets full-auto run a command the classifier cannot bound without asking.
 */
export type ShellRealmContainment = 'sandbox' | 'degraded' | 'host';
export interface ShellRealm {
  readonly kind: 'host' | 'bubblewrap' | 'landlock';
  run(request: ShellRealmRequest): Promise<ShellRealmResult>;
}

export interface ShellRealmRequest {
  readonly command: string;
  /** Absolute workspace root: the only working directory a command gets. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Extra variable names an operator allowed (configuration), copied when present in the service environment. */
  readonly extraEnv?: readonly string[];
  /** Values the caller sets whatever the service environment holds (SCR-A: `TMPDIR` = the conversation's scratch area). */
  readonly fixedEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Streamed output, in order, each chunk ≤ HOST_SHELL_CHUNK_MAX_BYTES and never splitting a UTF-8 character. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Source of the copied variables (defaults to the service's own environment). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly resultMaxBytes?: number;
  /** A call the owner did not approve (a mode relaxation or a silent decision): a sandbox realm keeps the write floor's existing paths
   * read-only (SHELL-AUTONOMY: the floor never goes silent). The host realm cannot and does not: it is never silent for such commands. */
  readonly writeFloorReadOnly?: boolean;
  /** A call whose command the classifier could not bound and the owner did not approve (a full-auto sandbox relaxation): a sandbox realm
   * keeps the whole project read-only — only the scratch area (and bubblewrap's private `/tmp`) are writable — so no name, existing or
   * new, can appear in the project without a card (Astra 2170 R1). */
  readonly projectReadOnly?: boolean;
}
export interface ShellRealmResult {
  /** `exited` with its code (or the signal that ended it), `timed-out` / `cancelled` after the group was killed, `spawn-failed`. */
  readonly status: 'exited' | 'timed-out' | 'cancelled' | 'spawn-failed' | 'unsupported-platform';
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** stdout and stderr interleaved as they arrived, bounded (head + tail); `omittedBytes` counts what was left out. */
  readonly output: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
  /** Elapsed time of the call on the monotonic clock (I40): a host wall clock stepping backwards during the run never shortens it. */
  readonly durationMs: number;
  /** What the call could verify about processes the command left behind, within its process group (Astra 2112 R1, 2119):
   * `clean` — the group was empty when the shell exited and the pipes closed by themselves; `group-ended` — members of the group
   * still alive after the shell exited were ended and the group was observed empty; `unverified` — the group could not be observed
   * empty after SIGKILL, or the pipes had to be released (drain deadline, timeout or cancellation) while something still held them:
   * a process the command started may be running, possibly outside its group. A descendant that left the group (setsid, a daemon)
   * is never observed and can outlive the call: this is a process-group contract, not a sandbox. */
  readonly cleanup: 'clean' | 'group-ended' | 'unverified';
}
