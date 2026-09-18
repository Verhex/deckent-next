import { spawn } from 'node:child_process';
import { processCommandSchema, ProcessRunnerError, type ProcessCommand, type ProcessEvidence } from './contract.js';
/** Linux comparison profile: explicit environment, closed stdin, owned process group, raw bounded output.
 * This reports the command process, never the Docker container or a Task's success.
 */
export async function runNodeProcess(input: ProcessCommand, signal?: AbortSignal): Promise<ProcessEvidence> {
  const parsed = processCommandSchema.safeParse(input);
  if (!parsed.success) throw new ProcessRunnerError('PROCESS_RUNNER_INVALID');
  if (process.platform !== 'linux') throw new ProcessRunnerError('PROCESS_RUNNER_UNSUPPORTED');
  const command = parsed.data; const start = performance.now();
  const evidence = (values: Partial<ProcessEvidence>): ProcessEvidence => Object.freeze({ schemaVersion: 1, requestId: command.requestId,
    started: false, reason: 'start-failed', exitCode: null, signal: null, stdoutBase64: '', stderrBase64: '',
    stdoutTruncated: false, stderrTruncated: false, ...values, durationMs: performance.now() - start });
  if (signal?.aborted) return evidence({ reason: 'cancelled' });
  return new Promise(resolve => {
    let child;
    try { child = spawn(command.executable, [...command.args], { cwd: command.cwd, env: { ...command.env }, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve(evidence({})); return; }
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    let started = false; let reason: ProcessEvidence['reason'] | undefined; let stdoutTruncated = false; let stderrTruncated = false;
    const stop = (cause: ProcessEvidence['reason']) => {
      reason ??= cause;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Exit evidence determines whether the command terminated. */ } }
      // Escaped descendants holding inherited pipes must not extend our transport lifetime.
      child.stdout.destroy(); child.stderr.destroy();
    };
    const abort = () => stop('cancelled'); const timer = setTimeout(() => stop('timeout'), command.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.on('spawn', () => { started = true; });
    child.on('error', () => { reason ??= 'start-failed'; });
    child.stdout.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, command.outputBytes - outBytes)); stdout.push(kept); outBytes += kept.length;
      if (kept.length !== chunk.length) { stdoutTruncated = true; stop('output-limit'); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, command.outputBytes - errBytes)); stderr.push(kept); errBytes += kept.length;
      if (kept.length !== chunk.length) { stderrTruncated = true; stop('output-limit'); }
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve(evidence({ started, reason: reason ?? (exitSignal ? 'signal' : 'exit'), exitCode: started ? exitCode : null, signal: started ? exitSignal : null,
        stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64'), stdoutTruncated, stderrTruncated }));
    });
  });
}
