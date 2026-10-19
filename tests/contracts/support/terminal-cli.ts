import { spawn } from 'node:child_process';

// SEC-1 (A48-D5): the compiled CLI on a real controlling PTY (stdin and stdout on it), the way a person runs it; nothing is mocked. Each
// answer is typed only after its prompt appeared (a hidden prompt switches the terminal to raw mode first, so the value is never echoed).
const DRIVER = String.raw`
import json, os, pty, select, sys, time
spec = json.loads(sys.argv[1])
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execve(spec['argv'][0], spec['argv'], spec['env'])
seen, answers, deadline = b'', list(spec['answers']), time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([terminal], [], [], 0.05)
    if ready:
        try: data = os.read(terminal, 65536)
        except OSError: data = b''
        if not data: break
        seen += data
    if answers and answers[0]['when'].encode() in seen:
        time.sleep(0.05)
        os.write(terminal, answers.pop(0)['send'].encode())
_, status = os.waitpid(pid, 0)
sys.stdout.write(json.dumps({ 'code': os.waitstatus_to_exitcode(status), 'output': seen.decode('utf-8', 'replace') }))
`;

export interface TerminalAnswer { readonly when: string; readonly send: string }
/** Runs `argv` (argv[0] an absolute executable) on its own PTY; output is stdout and stderr as the terminal showed them, CR LF normalized. */
export function runInTerminal(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, answers: readonly TerminalAnswer[] = []): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', DRIVER, JSON.stringify({ argv, cwd, env, answers })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); });
    child.once('error', reject);
    child.once('close', () => {
      try { const parsed = JSON.parse(out) as { code: number; output: string }; resolve({ code: parsed.code, output: parsed.output.replace(/\r\n/gu, '\n') }); }
      catch { reject(new Error(`terminal run: no result (${err || out})`)); }
    });
  });
}
/** The last line of terminal output that parses as a JSON object (the command's `--json` result). */
export function lastJson(output: string): unknown {
  for (const line of output.split('\n').reverse()) { const text = line.trim(); if (text.startsWith('{')) { try { return JSON.parse(text); } catch { /* not JSON */ } } }
  return null;
}
