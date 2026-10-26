import { spawn } from 'node:child_process';
import { processCommandSchema, validateProcessEvidence, ProcessRunnerError, type ProcessCommand, type ProcessEvidence } from './contract.js';
import { callerEnvironment } from '#platform/index.js';
/** A v2 stdout line consumer: complete lines in order (UTF-8, without the newline); `stop` ends the process group at once (reason `stopped`). */
export type ProcessLineConsumer = (line: string) => 'stop' | void;
/** Linux comparison profile: explicit environment, closed (v1) or bounded (v2) stdin, owned process group, raw bounded output.
 * This reports the command process, never the Docker container or a Task's success.
 */
export async function runNodeProcess(input: ProcessCommand, signal?: AbortSignal, onLine?: ProcessLineConsumer): Promise<ProcessEvidence> {
  const parsed = processCommandSchema.safeParse(input);
  if (!parsed.success) throw new ProcessRunnerError('PROCESS_RUNNER_INVALID');
  if (process.platform !== 'linux') throw new ProcessRunnerError('PROCESS_RUNNER_UNSUPPORTED');
  const command = parsed.data, v2 = command.schemaVersion === 2 ? command : null, start = performance.now();
  if (onLine && !v2?.maxLineBytes) throw new ProcessRunnerError('PROCESS_RUNNER_INVALID');
  const errLimit = v2?.stderrBytes ?? command.outputBytes, stdin = v2?.stdinBase64 === undefined ? null : Buffer.from(v2.stdinBase64, 'base64');
  const evidence = (values: Partial<ProcessEvidence>): ProcessEvidence => Object.freeze({ schemaVersion: 1, requestId: command.requestId,
    started: false, reason: 'start-failed', exitCode: null, signal: null, stdoutBase64: '', stderrBase64: '',
    stdoutTruncated: false, stderrTruncated: false, ...values, durationMs: performance.now() - start });
  if (signal?.aborted) return validateProcessEvidence(command, evidence({ reason: 'cancelled' }));
  const result = await new Promise<ProcessEvidence>(resolve => {
    let child;
    try { child = spawn(command.executable, [...command.args], { cwd: command.cwd, env: callerEnvironment({ ...command.env }), detached: true, shell: false, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
    catch { resolve(evidence({})); return; }
    const out = child.stdout!, err = child.stderr!;
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0; let pending = Buffer.alloc(0);
    let started = false; let reason: ProcessEvidence['reason'] | undefined; let stdoutTruncated = false; let stderrTruncated = false;
    let grace: NodeJS.Timeout | undefined;
    const group = (name: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Exit evidence determines whether the command terminated. */ } } };
    const kill = () => {
      clearTimeout(grace); grace = undefined; group('SIGKILL');
      // Escaped descendants holding inherited pipes must not extend our transport lifetime.
      out.destroy(); err.destroy();
    };
    const stop = (cause: ProcessEvidence['reason']) => {
      const first = reason === undefined; reason ??= cause;
      // v2 graceful stop for timeout/cancel only: SIGINT ends the turn, SIGKILL follows after the grace bound; limits and `stop` kill at once.
      if (first && v2?.interruptGraceMs && (cause === 'timeout' || cause === 'cancelled')) { group('SIGINT'); grace = setTimeout(kill, v2.interruptGraceMs); }
      else if (first || grace !== undefined) kill();
    };
    const line = (bytes: Buffer) => { if (reason === undefined && onLine?.(bytes.toString('utf8')) === 'stop') stop('stopped'); };
    const abort = () => stop('cancelled'); const timer = setTimeout(() => stop('timeout'), command.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.on('spawn', () => { started = true; });
    child.on('error', () => { reason ??= 'start-failed'; });
    if (stdin && child.stdin) { child.stdin.on('error', () => { /* A child that exits without reading its input is judged by exit evidence. */ }); child.stdin.end(stdin); }
    out.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, command.outputBytes - outBytes)); stdout.push(kept); outBytes += kept.length;
      if (onLine) {
        pending = Buffer.concat([pending, kept]);
        for (let index = pending.indexOf(10); index >= 0 && reason === undefined; index = pending.indexOf(10)) { line(pending.subarray(0, index)); pending = pending.subarray(index + 1); }
        if (pending.length > v2!.maxLineBytes! && reason === undefined) stop('line-limit');
      }
      if (kept.length !== chunk.length) { stdoutTruncated = true; stop('output-limit'); }
    });
    err.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, errLimit - errBytes)); stderr.push(kept); errBytes += kept.length;
      if (kept.length !== chunk.length) { stderrTruncated = true; stop('output-limit'); }
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (grace !== undefined) { clearTimeout(grace); group('SIGKILL'); }
      if (onLine && pending.length > 0) line(pending);
      resolve(evidence({ started, reason: reason ?? (exitSignal ? 'signal' : 'exit'), exitCode: started ? exitCode : null, signal: started ? exitSignal : null,
        stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64'), stdoutTruncated, stderrTruncated }));
    });
  });
  return validateProcessEvidence(command, result);
}
