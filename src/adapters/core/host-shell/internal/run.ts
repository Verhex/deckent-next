import type { ShellRealmRequest as HostShellRequest, ShellRealmResult as HostShellResult } from '#domain/index.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Environment variables copied from the service into the command (Jev 52f9b6f9); everything else is left out. */
export const HOST_SHELL_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'LC_MESSAGES', 'TZ', 'TMPDIR', 'SHELL']);
/** Fixed non-interactive settings: nothing waits for a terminal, a pager or a credential prompt. */
const NON_INTERACTIVE: Readonly<Record<string, string>> = Object.freeze({ TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0' });
export const HOST_SHELL_DEFAULT_TIMEOUT_MS = 300_000;
/** Output kept for the call's result: the head and the tail (errors usually end a run), with what was left out counted. The same
 * 16 KiB as a read tool's result: it enters the model's context and travels as one event frame. */
export const HOST_SHELL_RESULT_MAX_BYTES = 16_384;
/** Largest streamed chunk (one `tool.output` event). */
export const HOST_SHELL_CHUNK_MAX_BYTES = 8_192;
/** SIGTERM to SIGKILL grace for the command's process group. */
const KILL_GRACE_MS = 2_000;
/** How often the group is probed while its survivors are being ended, and how many probes follow SIGKILL before the call gives
 * up on the group and settles anyway, releasing the pipes (a process the kernel cannot end, e.g. in uninterruptible I/O, must not
 * hold the call forever). */
const GROUP_PROBE_MS = 25;
const GROUP_PROBES_AFTER_KILL = 80;
/** After the shell exited and its group is settled, how long inherited pipes still open are drained before they are released:
 * a holder that is not in the group (setsid, a daemon) cannot be seen or ended, and must not hold the call. */
const PIPE_DRAIN_GRACE_MS = 1_000;

/** The call's clock port (I40): a sampler whose monotonic reading measures elapsed time; the platform `TrustedClock` fits it
 * (composition may inject it), the default reads `performance.now()`. Wall time is never used for durations. */
export interface HostShellClock { sample(): { readonly monotonicMs: number } }
const MONOTONIC_CLOCK: HostShellClock = Object.freeze({ sample: () => ({ monotonicMs: performance.now() }) });

export type { ShellRealmRequest as HostShellRequest, ShellRealmResult as HostShellResult } from '#domain/index.js';

export function hostShellEnvironment(source: NodeJS.ProcessEnv, extra: readonly string[] = [], fixed: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...HOST_SHELL_ENV_ALLOWLIST, ...extra]) { const value = source[name]; if (typeof value === 'string') env[name] = value; }
  return { ...env, ...fixed, ...NON_INTERACTIVE };
}

/** UTF-8 safe head of `buffer` within `max` bytes (`buffer` holds whole sequences). */
function utf8Head(buffer: Buffer, max: number): Buffer {
  let end = Math.min(max, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end);
}
/** UTF-8 safe tail of `buffer` within `max` bytes (`buffer` holds whole sequences). */
function utf8Tail(buffer: Buffer, max: number): Buffer {
  let start = Math.max(0, buffer.length - max);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}
/** Number of trailing bytes of `buffer` that begin a UTF-8 sequence the buffer does not complete (0 when it ends on a boundary). */
function utf8IncompleteTail(buffer: Buffer): number {
  for (let back = 1; back <= 3 && back <= buffer.length; back++) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/**
 * Runs one command on the host (T-L4 slice 3b). Not a sandbox: the command runs as the service's OS user with that user's file,
 * process and network access; the workspace root is only its working directory. `bash --noprofile --norc -c` (no rc-file side
 * effects), stdin closed, a small allowlisted environment plus fixed non-interactive settings (no credentials from the service's
 * environment unless an operator allows the name), its own process group. The group is the call's lifetime: cancellation or the
 * timeout signals the whole group (SIGTERM, then SIGKILL after a short grace), and when the shell exits by itself, members still
 * alive (background children, redirected or not) are ended the same way before the result settles, which reports what could be
 * verified (`cleanup`; Astra 2112 R1). Inherited pipes still open after the group is settled are drained for a bounded grace and
 * then released, so a descendant that left the group (setsid, a daemon) cannot hold the call — nor can it be seen or ended: it may
 * outlive the call (Astra 2119; a process-group contract, not a sandbox). Output streams in bounded chunks; the result keeps a bounded head and tail, cut on UTF-8
 * boundaries with a character split across pipe reads carried to the next read (Astra 2112 R2). Windows is not supported yet (typed
 * result, nothing runs).
 */
export function runHostShell(request: HostShellRequest, clock: HostShellClock = MONOTONIC_CLOCK): Promise<HostShellResult> {
  return runShellProcess(BASH_LAUNCH, request, clock);
}

/** What is spawned for a command: the host shell itself, or a sandbox launcher (S9 bubblewrap, S11 Landlock helper) whose argv ends
 * with the same shell line and which execs bash in its own process (the process-group contract below is unchanged). A launcher with
 * `statusChannel` reports a setup failure as text on fd 3 before anything runs (the call is then `spawn-failed` with that text as its
 * output); fd 3 closed with nothing written means the command started — the command itself never holds fd 3, so it cannot forge a
 * setup failure. */
export interface ShellLaunch { readonly file: string; readonly args: (command: string) => readonly string[]; readonly statusChannel?: boolean }
export const BASH_LAUNCH: ShellLaunch = Object.freeze({ file: 'bash', args: (command: string) => ['--noprofile', '--norc', '-c', command] });
/** Longest setup-failure text kept from a launcher. */
const LAUNCH_STATUS_MAX_BYTES = 1_024;

/** The one process runner behind every realm: `launch` decides the executable and argv; the group, cancellation, timeout, pipe and
 * output contracts above are the same for all of them. */
export function runShellProcess(launch: ShellLaunch, request: HostShellRequest, clock: HostShellClock = MONOTONIC_CLOCK): Promise<HostShellResult> {
  const started = clock.sample().monotonicMs;
  const elapsedMs = () => Math.max(0, Math.round(clock.sample().monotonicMs - started));
  const keep = request.resultMaxBytes ?? HOST_SHELL_RESULT_MAX_BYTES;
  const headMax = Math.floor(keep / 4), tailMax = keep - headMax;
  let head: Buffer = Buffer.alloc(0), tail: Buffer = Buffer.alloc(0), total = 0;
  // Once bytes went to the tail the head is closed, so the kept output stays in arrival order even while the head has room left.
  let headOpen = true;
  const done = (status: HostShellResult['status'], exitCode: number | null, signal: string | null, cleanup: HostShellResult['cleanup'] = 'clean'): HostShellResult => {
    const omitted = Math.max(0, total - head.length - tail.length);
    const output = omitted > 0 ? `${head.toString('utf8')}\n[… ${omitted} bytes of output omitted …]\n${tail.toString('utf8')}` : Buffer.concat([head, tail]).toString('utf8');
    return Object.freeze({ status, exitCode, signal, output, totalBytes: total, omittedBytes: omitted, durationMs: elapsedMs(), cleanup });
  };
  if (process.platform === 'win32') return Promise.resolve(done('unsupported-platform', null, null));
  if (request.signal?.aborted) return Promise.resolve(done('cancelled', null, null));
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.file, [...launch.args(request.command)], { cwd: request.cwd, env: hostShellEnvironment(request.environment ?? process.env, request.extraEnv, request.fixedEnv),
        stdio: launch.statusChannel ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: true });
    } catch { resolve(done('spawn-failed', null, null)); return; }
    let ending: 'timed-out' | 'cancelled' | null = null, exited = false, settled = false;
    let termSent = false, killSent = false, forceTimer: NodeJS.Timeout | null = null;
    // Pipes still open after the shell exited are drained for a bounded grace once the group is settled, then released; a
    // timeout or cancellation during that drain releases them at once. Released pipes mean the cleanup is unverified.
    let openPipes = 2, pipesReleased = false, drainTimer: NodeJS.Timeout | null = null;
    const releasePipes = () => {
      if (pipesReleased || openPipes === 0) return;
      pipesReleased = true;
      child.stdout?.destroy(); child.stderr?.destroy();
    };
    const signalGroup = (name: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } }
    };
    /** Whether any member of the command's process group still exists (signal 0 probes the group without touching it). */
    const groupAlive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    const terminateGroup = () => {
      if (termSent) return;
      termSent = true;
      signalGroup('SIGTERM');
      forceTimer = setTimeout(() => { killSent = true; signalGroup('SIGKILL'); }, KILL_GRACE_MS);
    };
    const stop = (why: 'timed-out' | 'cancelled') => {
      if (settled) return;
      // Once the shell has exited its result is `exited` and what is left of the group is being ended anyway; the timeout or
      // cancellation then only stops the drain.
      if (exited) { releasePipes(); return; }
      if (ending) return;
      ending = why;
      terminateGroup();
    };
    const timer = setTimeout(() => stop('timed-out'), request.timeoutMs ?? HOST_SHELL_DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop('cancelled');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    /** After the shell exited: ends what is left of its group (SIGTERM unless already sent, SIGKILL after the grace) and waits until the
     * group is observed empty, or for a bounded time after SIGKILL. Resolves what could be verified. */
    const reapGroup = (): Promise<'clean' | 'group-ended' | 'unverified'> => new Promise(resolveReap => {
      if (!groupAlive()) { resolveReap('clean'); return; }
      terminateGroup();
      let probesAfterKill = 0;
      const probe = () => {
        if (!groupAlive()) { resolveReap('group-ended'); return; }
        if (killSent && ++probesAfterKill > GROUP_PROBES_AFTER_KILL) { resolveReap('unverified'); return; }
        setTimeout(probe, GROUP_PROBE_MS);
      };
      setTimeout(probe, GROUP_PROBE_MS);
    });
    const collect = (stream: 'stdout' | 'stderr') => {
      const decoder = new StringDecoder('utf8');
      // Trailing bytes of a UTF-8 sequence a pipe read cut in the middle, kept until the next read completes it (head/tail accounting).
      let carry: Buffer = Buffer.alloc(0);
      const emit = (text: string) => {
        if (!text || !request.onOutput) return;
        let rest = Buffer.from(text, 'utf8');
        while (rest.length > 0) { const part = utf8Head(rest, HOST_SHELL_CHUNK_MAX_BYTES); request.onOutput(stream, part.toString('utf8')); rest = rest.subarray(part.length); }
      };
      const retain = (bytes: Buffer) => {
        if (bytes.length === 0) return;
        if (headOpen && head.length < headMax) {
          const taken = utf8Head(bytes, headMax - head.length);
          head = Buffer.concat([head, taken]);
          if (taken.length < bytes.length) { headOpen = false; tail = utf8Tail(Buffer.concat([tail, bytes.subarray(taken.length)]), tailMax); }
        } else tail = utf8Tail(Buffer.concat([tail, bytes]), tailMax);
      };
      let ended = false;
      return {
        data(chunk: Buffer) {
          total += chunk.length;
          const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          const cut = bytes.length - utf8IncompleteTail(bytes);
          carry = Buffer.from(bytes.subarray(cut));
          retain(bytes.subarray(0, cut));
          emit(decoder.write(chunk));
        },
        /** Flushes what is held back (once): at the stream's end, or at its close when it was released before ending. */
        end() { if (ended) return; ended = true; retain(carry); carry = Buffer.alloc(0); emit(decoder.end()); },
      };
    };
    const out = collect('stdout'), err = collect('stderr');
    child.stdout!.on('data', out.data); child.stderr!.on('data', err.data);
    child.stdout!.on('end', out.end); child.stderr!.on('end', err.end);
    child.stdout!.on('close', () => { openPipes--; out.end(); }); child.stderr!.on('close', () => { openPipes--; err.end(); });
    const finish = (result: HostShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); if (drainTimer) clearTimeout(drainTimer);
      request.signal?.removeEventListener('abort', onAbort);
      // A group member that ignored SIGTERM must not outlive the call.
      if (termSent) signalGroup('SIGKILL');
      resolve(result);
    };
    let reaping: Promise<HostShellResult['cleanup']> | null = null;
    child.once('error', () => finish(done('spawn-failed', null, null)));
    // `exit`: the shell is gone; its status is final and the rest of the group is ended; pipes still open once the group is settled
    // are drained for a bounded grace, then released (the timeout keeps running and, like a cancellation, releases them at once).
    // `close` (always after `exit`): the pipes are closed or released; the result settles once the group is settled too.
    child.once('exit', () => {
      exited = true;
      reaping = reapGroup().then(cleanup => { if (openPipes > 0 && !settled) drainTimer = setTimeout(releasePipes, PIPE_DRAIN_GRACE_MS); return cleanup; });
    });
    // The launcher's status channel (fd 3): text is a setup failure before anything ran; `close` below waits for its end too.
    let setupFailure = '';
    child.stdio[3]?.on('data', (chunk: Buffer) => { if (setupFailure.length < LAUNCH_STATUS_MAX_BYTES) setupFailure += chunk.toString('utf8').slice(0, LAUNCH_STATUS_MAX_BYTES); });
    child.once('close', (code, signal) => {
      void (reaping ?? Promise.resolve<HostShellResult['cleanup']>('clean')).then(cleanup => finish(setupFailure !== ''
        ? Object.freeze({ ...done('spawn-failed', null, null, cleanup), output: `[deckent] ${setupFailure.trim()}; nothing was run.` })
        : done(ending ?? 'exited', code, signal, pipesReleased ? 'unverified' : cleanup)));
    });
  });
}
