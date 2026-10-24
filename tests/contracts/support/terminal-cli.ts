import { childEnv } from './child-env.js';
import { owned } from './owned.js';

// SEC-1 (A48-D5): the compiled CLI on a real controlling PTY (stdin and stdout on it), the way a person runs it; nothing is mocked. Each
// answer is typed only after its prompt appeared (a hidden prompt switches the terminal to raw mode first, so the value is never echoed).
// J2e join: a prompt is looked for only in the output after the previous answer, and the answer waits 0.3 s after it, so an arrow-key card
// (L-KIT, drawn before Ink switches stdin to raw mode) is answered once it listens, and the next card is not matched on an earlier frame.
const DRIVER = String.raw`
import json, os, pty, select, signal, sys, time
spec = json.loads(sys.argv[1])
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execve(spec['argv'][0], spec['argv'], spec['env'])
# Stopped by the test harness (deadline or teardown): the PTY child leads its own session and group, so it is ended with the driver.
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except OSError: pass
    os._exit(143)
signal.signal(signal.SIGTERM, stop)
seen, answers, deadline, mark = b'', list(spec['answers']), time.time() + 30, 0
while time.time() < deadline:
    ready, _, _ = select.select([terminal], [], [], 0.05)
    if ready:
        try: data = os.read(terminal, 65536)
        except OSError: data = b''
        if not data: break
        seen += data
    if answers and answers[0]['when'].encode() in seen[mark:]:
        time.sleep(0.3)
        os.write(terminal, answers.pop(0)['send'].encode())
        mark = len(seen)
else:
    # Past the 30 s bound the child is stopped, so the wait below returns (its signal status is the visible failure) instead of hanging.
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.write(json.dumps({ 'code': os.waitstatus_to_exitcode(status), 'output': seen.decode('utf-8', 'replace') }))
`;

export interface TerminalAnswer { readonly when: string; readonly send: string }
/** Runs `argv` (argv[0] an absolute executable) on its own PTY; output is stdout and stderr as the terminal showed them, CR LF normalized.
 * `env` is the child's whole environment; the python driver itself is an owned child with the allowlisted environment. */
export async function runInTerminal(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, answers: readonly TerminalAnswer[] = []): Promise<{ code: number; output: string }> {
  const { stdout, stderr } = await owned().run('python3', ['-c', DRIVER, JSON.stringify({ argv, cwd, env, answers })], { env: childEnv(), deadlineMs: 40_000, label: `terminal ${argv.slice(1, 3).join(' ')}` });
  try { const parsed = JSON.parse(stdout) as { code: number; output: string }; return { code: parsed.code, output: parsed.output.replace(/\r\n/gu, '\n') }; }
  catch { throw new Error(`terminal run: no result (${stderr || stdout})`); }
}
/** Terminal control sequences (CSI: cursor, mode, colour) an Ink card leaves before the next output on the same line. */
const CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'gu');
/** The last line of terminal output that parses as a JSON object (the command's `--json` result), control sequences removed. */
export function lastJson(output: string): unknown {
  for (const line of output.split('\n').reverse()) { const text = line.replace(CSI, '').trim(); if (text.startsWith('{')) { try { return JSON.parse(text); } catch { /* not JSON */ } } }
  return null;
}
