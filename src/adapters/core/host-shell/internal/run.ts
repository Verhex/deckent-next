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
/** How often the group is probed while its survivors are being ended, and how many probes follow SIGKILL before the call settles
 * anyway (a process the kernel cannot end, e.g. in uninterruptible I/O, must not hold the call forever). */
const GROUP_PROBE_MS = 25;
const GROUP_PROBES_AFTER_KILL = 80;

export interface HostShellRequest {
  readonly command: string;
  /** Absolute workspace root: the only working directory a command gets. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Extra variable names an operator allowed (configuration), copied when present in the service environment. */
  readonly extraEnv?: readonly string[];
  readonly signal?: AbortSignal;
  /** Streamed output, in order, each chunk ≤ HOST_SHELL_CHUNK_MAX_BYTES and never splitting a UTF-8 character. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Source of the copied variables (defaults to the service's own environment). */
  readonly environment?: NodeJS.ProcessEnv;
  readonly resultMaxBytes?: number;
}
export interface HostShellResult {
  /** `exited` with its code (or the signal that ended it), `timed-out` / `cancelled` after the group was killed, `spawn-failed`. */
  readonly status: 'exited' | 'timed-out' | 'cancelled' | 'spawn-failed' | 'unsupported-platform';
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** stdout and stderr interleaved as they arrived, bounded (head + tail); `omittedBytes` counts what was left out. */
  readonly output: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
  readonly durationMs: number;
  /** True when members of the command's process group were still alive after the shell exited (background children) and the call
   * ended them before it settled (Astra 2112 R1): nothing the command started outlives the call. */
  readonly survivorsKilled: boolean;
}

export function hostShellEnvironment(source: NodeJS.ProcessEnv, extra: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...HOST_SHELL_ENV_ALLOWLIST, ...extra]) { const value = source[name]; if (typeof value === 'string') env[name] = value; }
  return { ...env, ...NON_INTERACTIVE };
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
 * alive (background children, redirected or not) are ended the same way before the result settles, which reports it
 * (`survivorsKilled`; Astra 2112 R1). Output streams in bounded chunks; the result keeps a bounded head and tail, cut on UTF-8
 * boundaries with a character split across pipe reads carried to the next read (Astra 2112 R2). Windows is not supported yet (typed
 * result, nothing runs).
 */
export function runHostShell(request: HostShellRequest, now: () => number = Date.now): Promise<HostShellResult> {
  const started = now();
  const keep = request.resultMaxBytes ?? HOST_SHELL_RESULT_MAX_BYTES;
  const headMax = Math.floor(keep / 4), tailMax = keep - headMax;
  let head: Buffer = Buffer.alloc(0), tail: Buffer = Buffer.alloc(0), total = 0;
  const done = (status: HostShellResult['status'], exitCode: number | null, signal: string | null, survivorsKilled = false): HostShellResult => {
    const omitted = Math.max(0, total - head.length - tail.length);
    const output = omitted > 0 ? `${head.toString('utf8')}\n[… ${omitted} bytes of output omitted …]\n${tail.toString('utf8')}` : Buffer.concat([head, tail]).toString('utf8');
    return Object.freeze({ status, exitCode, signal, output, totalBytes: total, omittedBytes: omitted, durationMs: Math.max(0, now() - started), survivorsKilled });
  };
  if (process.platform === 'win32') return Promise.resolve(done('unsupported-platform', null, null));
  if (request.signal?.aborted) return Promise.resolve(done('cancelled', null, null));
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['--noprofile', '--norc', '-c', request.command], { cwd: request.cwd, env: hostShellEnvironment(request.environment ?? process.env, request.extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch { resolve(done('spawn-failed', null, null)); return; }
    let ending: 'timed-out' | 'cancelled' | null = null, exited = false, settled = false;
    let termSent = false, killSent = false, forceTimer: NodeJS.Timeout | null = null;
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
      // Once the shell has exited its result is `exited`; whatever is left of the group is being ended anyway.
      if (ending || exited || settled) return;
      ending = why;
      terminateGroup();
    };
    const timer = setTimeout(() => stop('timed-out'), request.timeoutMs ?? HOST_SHELL_DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop('cancelled');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    /** After the shell exited: ends what is left of its group (SIGTERM unless already sent, SIGKILL after the grace) and waits until the
     * group is empty, or for a bounded time after SIGKILL. Resolves whether any survivor was found. */
    const reapGroup = (): Promise<boolean> => new Promise(resolveReap => {
      if (!groupAlive()) { resolveReap(false); return; }
      terminateGroup();
      let probesAfterKill = 0;
      const probe = () => {
        if (!groupAlive() || (killSent && ++probesAfterKill > GROUP_PROBES_AFTER_KILL)) { resolveReap(true); return; }
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
        if (head.length < headMax) {
          const taken = utf8Head(bytes, headMax - head.length);
          head = Buffer.concat([head, taken]);
          if (taken.length < bytes.length) tail = utf8Tail(Buffer.concat([tail, bytes.subarray(taken.length)]), tailMax);
        } else tail = utf8Tail(Buffer.concat([tail, bytes]), tailMax);
      };
      return {
        data(chunk: Buffer) {
          total += chunk.length;
          const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          const cut = bytes.length - utf8IncompleteTail(bytes);
          carry = Buffer.from(bytes.subarray(cut));
          retain(bytes.subarray(0, cut));
          emit(decoder.write(chunk));
        },
        end() { retain(carry); carry = Buffer.alloc(0); emit(decoder.end()); },
      };
    };
    const out = collect('stdout'), err = collect('stderr');
    child.stdout!.on('data', out.data); child.stderr!.on('data', err.data);
    child.stdout!.on('end', out.end); child.stderr!.on('end', err.end);
    const finish = (result: HostShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      request.signal?.removeEventListener('abort', onAbort);
      // A group member that ignored SIGTERM must not outlive the call.
      if (termSent) signalGroup('SIGKILL');
      resolve(result);
    };
    let reaping: Promise<boolean> | null = null;
    child.once('error', () => finish(done('spawn-failed', null, null)));
    // `exit`: the shell is gone; its status is final and the rest of the group is ended. `close` (always after `exit`): all output
    // has arrived; the result settles once the group is empty.
    child.once('exit', () => { exited = true; clearTimeout(timer); reaping = reapGroup(); });
    child.once('close', (code, signal) => { void (reaping ?? Promise.resolve(false)).then(survivorsKilled => finish(done(ending ?? 'exited', code, signal, survivorsKilled))); });
  });
}
