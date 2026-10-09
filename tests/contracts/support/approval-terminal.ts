import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ErrorRegistry, productResourcePath, resolveProductLayout } from '#platform/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';

// A PTY belongs to the child, not the test runner. Piped input/output variants retain the controlling TTY.
const DRIVER = String.raw`
import json, os, pty, select, sys, time
argv, mode = json.loads(sys.argv[1]), sys.argv[2]
if len(sys.argv) > 3 and sys.argv[3]: os.chdir(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    if mode == 'piped-input': os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
    if mode == 'redirected-output': os.dup2(2, 1); os.dup2(os.open('/dev/null', os.O_WRONLY), 1)
    os.execvp(argv[0], argv)
out = b''
end = time.monotonic() + 25
while time.monotonic() < end:
    if select.select([fd], [], [], 0.1)[0]:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        out += chunk
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
os.close(fd)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
export async function terminalRequest(f: { project: string; data: string; env: NodeJS.ProcessEnv }, operation: string, input: unknown,
  automatic?: 'allow' | 'deny', mode = 'tty') {
  const endpoint = productResourcePath(resolveProductLayout({ projectRoot: f.project, root: f.data }), 'runtimeSocket');
  const request = { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'terminal-fixture', operation, input, delivery: { maxResultBytes: 65536 } };
  const argv = [process.execPath, resolve('tests/fixtures/approval-terminal-peer.mjs'), endpoint, JSON.stringify(request), automatic ?? ''];
  return driveTerminal(argv, f.env, mode);
}
async function driveTerminal(argv: string[], env: NodeJS.ProcessEnv, mode = 'tty') {
  const result = await terminalProgram(argv, env, undefined, mode);
  if (result.status !== 0) throw new Error(result.output);
  const line = result.output.split(/\r?\n/u).find(value => value.startsWith('{"response":'));
  if (!line) throw new Error(result.output);
  return JSON.parse(line) as { response: { ok: boolean; result?: unknown; error?: { code: string } }; events: unknown[]; decisions: unknown[] };
}
export async function terminalProgram(argv: string[], env: NodeJS.ProcessEnv, cwd?: string, mode = 'tty') {
  const { stdout } = await promisify(execFile)('python3', ['-c', DRIVER, JSON.stringify(argv), mode, cwd ?? ''],
    { env: { ...process.env, ...env }, timeout: 30_000, maxBuffer: 1_000_000 });
  const result = JSON.parse(stdout) as { status: number; output: string };
  return result;
}
export async function terminalApplication<T = unknown>(f: { project: string; env: NodeJS.ProcessEnv }, operation: 'policy-upgrade' | 'mcp-capability' | 'decide', scopeId: string, input: unknown): Promise<T> {
  const argv = [process.execPath, resolve('tests/fixtures/approval-terminal-application.mjs'), f.project, JSON.stringify({ operation, scopeId, input })];
  const value = await driveTerminal(argv, f.env);
  if (!value.response.ok) throw ErrorRegistry.createError(value.response.error!.code);
  return value.response.result as T;
}
