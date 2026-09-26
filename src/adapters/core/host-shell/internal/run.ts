import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Environment variables copied from the service into the command (Jev 52f9b6f9); everything else is left out. */
export const HOST_SHELL_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'LC_MESSAGES', 'TZ', 'TMPDIR', 'SHELL']);
/** Fixed non-interactive settings: nothing waits for a terminal, a pager or a credential prompt. */
const NON_INTERACTIVE: Readonly<Record<string, string>> = Object.freeze({ TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0' });
export const HOST_SHELL_DEFAULT_TIMEOUT_MS = 300_000;
/** Output kept for the call's result: the head and the tail (errors usually end a run), with what was left out counted. */
export const HOST_SHELL_RESULT_MAX_BYTES = 131_072;
/** Largest streamed chunk (one `tool.output` event). */
export const HOST_SHELL_CHUNK_MAX_BYTES = 8_192;
const KILL_GRACE_MS = 2_000;

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
}

export function hostShellEnvironment(source: NodeJS.ProcessEnv, extra: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...HOST_SHELL_ENV_ALLOWLIST, ...extra]) { const value = source[name]; if (typeof value === 'string') env[name] = value; }
  return { ...env, ...NON_INTERACTIVE };
}

/** UTF-8 safe head of `buffer` within `max` bytes. */
function utf8Head(buffer: Buffer, max: number): Buffer {
  let end = Math.min(max, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end);
}
/** UTF-8 safe tail of `buffer` within `max` bytes. */
function utf8Tail(buffer: Buffer, max: number): Buffer {
  let start = Math.max(0, buffer.length - max);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/**
 * Runs one command on the host (T-L4 slice 3b). Not a sandbox: the command runs as the service's OS user with that user's file,
 * process and network access; the workspace root is only its working directory. `bash --noprofile --norc -c` (no rc-file side
 * effects), stdin closed, a small allowlisted environment plus fixed non-interactive settings (no credentials from the service's
 * environment unless an operator allows the name), its own process group. Cancellation or the timeout signals the whole group
 * (SIGTERM, then SIGKILL after a short grace), so a pipeline's children never outlive the call. Output streams in bounded
 * chunks; the result keeps a bounded head and tail. Windows is not supported yet (typed result, nothing runs).
 */
export function runHostShell(request: HostShellRequest, now: () => number = Date.now): Promise<HostShellResult> {
  const started = now();
  const keep = request.resultMaxBytes ?? HOST_SHELL_RESULT_MAX_BYTES;
  const headMax = Math.floor(keep / 4), tailMax = keep - headMax;
  let head: Buffer = Buffer.alloc(0), tail: Buffer = Buffer.alloc(0), total = 0;
  const done = (status: HostShellResult['status'], exitCode: number | null, signal: string | null): HostShellResult => {
    const omitted = Math.max(0, total - head.length - tail.length);
    const output = omitted > 0 ? `${head.toString('utf8')}\n[… ${omitted} bytes of output omitted …]\n${tail.toString('utf8')}` : Buffer.concat([head, tail]).toString('utf8');
    return Object.freeze({ status, exitCode, signal, output, totalBytes: total, omittedBytes: omitted, durationMs: Math.max(0, now() - started) });
  };
  if (process.platform === 'win32') return Promise.resolve(done('unsupported-platform', null, null));
  if (request.signal?.aborted) return Promise.resolve(done('cancelled', null, null));
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['--noprofile', '--norc', '-c', request.command], { cwd: request.cwd, env: hostShellEnvironment(request.environment ?? process.env, request.extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch { resolve(done('spawn-failed', null, null)); return; }
    let ending: 'timed-out' | 'cancelled' | null = null, settled = false, forceTimer: NodeJS.Timeout | null = null;
    const signalGroup = (name: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } }
    };
    const stop = (why: 'timed-out' | 'cancelled') => {
      if (ending || settled) return;
      ending = why;
      signalGroup('SIGTERM');
      forceTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('timed-out'), request.timeoutMs ?? HOST_SHELL_DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop('cancelled');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (stream: 'stdout' | 'stderr') => {
      const decoder = new StringDecoder('utf8');
      const emit = (text: string) => {
        if (!text || !request.onOutput) return;
        let rest = Buffer.from(text, 'utf8');
        while (rest.length > 0) { const part = utf8Head(rest, HOST_SHELL_CHUNK_MAX_BYTES); request.onOutput(stream, part.toString('utf8')); rest = rest.subarray(part.length); }
      };
      return {
        data(chunk: Buffer) {
          total += chunk.length;
          if (head.length < headMax) {
            const room = headMax - head.length;
            const taken = utf8Head(chunk, room);
            head = Buffer.concat([head, taken]);
            if (taken.length < chunk.length) tail = utf8Tail(Buffer.concat([tail, chunk.subarray(taken.length)]), tailMax);
          } else tail = utf8Tail(Buffer.concat([tail, chunk]), tailMax);
          emit(decoder.write(chunk));
        },
        end() { emit(decoder.end()); },
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
      if (ending) signalGroup('SIGKILL');
      resolve(result);
    };
    child.once('error', () => finish(done('spawn-failed', null, null)));
    child.once('close', (code, signal) => finish(done(ending ?? 'exited', code, signal)));
  });
}
