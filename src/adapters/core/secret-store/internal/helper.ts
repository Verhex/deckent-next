import { spawn } from 'node:child_process';
import { ErrorRegistry } from '#platform/index.js';
import { createSecretHelperBackend, SECRET_VALUE_MAX_BYTES, type SecretHelperOptions, type SecretStoreFactory } from '#engine/index.js';
export type { SecretHelperOptions } from '#engine/index.js';
/** Optional trusted-host adapter. Registration grants nothing; engine owns authorization, deadline and factory-wide admission.
 * Protocol v1: NAME + LF on stdin, one UTF-8 value + optional LF/CRLF on stdout, empty = absent. No shell, inherited env or output log.
 */
export function createSecretHelperFactory(options: SecretHelperOptions): SecretStoreFactory {
  return createSecretHelperBackend(options, readHelper, process.platform);
}
function readHelper(options: SecretHelperOptions, name: string, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined, finished = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (code?: string, value?: string) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited or never spawned */ } }
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (code) reject(ErrorRegistry.createError(code)); else resolve(value);
    };
    const abort = () => finish('SECRET_HELPER_TIMEOUT');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { child = spawn(options.executable, [...options.args], { cwd: options.cwd, env: {}, shell: false,
      detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish('SECRET_HELPER_FAILED'); return; }
    child.on('error', () => finish('SECRET_HELPER_FAILED')); child.stdin?.on('error', () => finish('SECRET_HELPER_FAILED'));
    const output = (chunk: Buffer, stdout: boolean) => {
      if (finished) { chunk.fill(0); return; }
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) { chunk.fill(0); finish('SECRET_HELPER_OUTPUT_LIMIT'); return; }
      if (stdout) chunks.push(chunk); else chunk.fill(0);
    };
    child.stdout?.on('data', (chunk: Buffer) => output(chunk, true)); child.stderr?.on('data', (chunk: Buffer) => output(chunk, false));
    child.on('close', (exitCode, exitSignal) => {
      if (finished) return;
      if (exitCode !== 0 || exitSignal !== null) { finish('SECRET_HELPER_FAILED'); return; }
      const buffer = Buffer.concat(chunks); let value: string;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r?\n$/, ''); }
      catch { buffer.fill(0); finish('SECRET_VALUE_INVALID'); return; }
      buffer.fill(0);
      if (value.includes('\n') || value.includes('\r') || value.includes('\0') || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) {
        finish('SECRET_VALUE_INVALID'); return;
      }
      finish(undefined, value === '' ? undefined : value);
    });
    child.stdin?.end(`${name}\n`);
  });
}
