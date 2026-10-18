import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/**
 * python3 `pty` driver: each step waits for a text in the output so far, then types its keys 10 ms apart; the view is stopped after the last step.
 * A step marked `fresh` waits for its text in the output after the previous step's keys only (a focus label shown earlier does not count);
 * `next` waits for it after the previous step's matched text (a decision window shows its keys only once they count, TERMINAL-SABIT-DUZEN).
 * Ctrl+O and the decision key are separate steps: written back to back, a loaded host can read both bytes in one chunk, which Ink 7.1.1 parses
 * as one text input (`\x0fy`, not Ctrl+O) — the key then lands in the composer (CI run 38503250233; ALPHA36-CI2 DECISIONS).
 */
export const DRIVER = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time, re
argv, steps, mode = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    if mode == 'piped-input': os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
out = b''
sent_at = 0
matched_at = 0
def read_for(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: return False
            if not chunk: return False
            out += chunk
    return True
for step in steps:
    wait, send = step[0], step[1]
    # 'fresh': after the previous step's keys; 'next': after the previous step's matched text (a decision's keys show only once armed).
    since = matched_at if len(step) > 2 and step[2] == 'next' else sent_at if len(step) > 2 else 0
    deadline = time.time() + 40
    while wait.encode() not in out[since:]:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); os.waitpid(pid, 0)
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(0)
    matched_at = out.index(wait.encode(), since) + len(wait.encode())
    read_for(0.4)
    # One write per key: an escape sequence (PgDn, an arrow) stays whole, as a terminal sends it (CI 2026-10-18: byte by byte it split into
    # several reads on a loaded host and a decision window rightly refused the multi-event read).
    for char in re.findall(r'\x1b\[[A-Z0-9~;<]+|.', send, re.S):
        os.write(fd, char.encode()); time.sleep(0.01)
    sent_at = len(out)
status = None
deadline = time.time() + 2
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, signal.SIGTERM); time.sleep(0.3)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if not finished: os.kill(pid, 9); os.waitpid(pid, 0)
    status = 'stopped'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
export type Step = readonly [wait: string, keys: string] | readonly [wait: string, keys: string, fresh: 'fresh' | 'next'];
/** Runs `node <program> <mode>` on its own controlling PTY in `project` and types the steps (see DRIVER). */
export async function inPty(program: string, project: string, env: NodeJS.ProcessEnv, mode: string, steps: readonly Step[], stdin = 'tty') {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, program, mode]), JSON.stringify(steps), stdin],
    { cwd: project, env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-6000)}`);
  return result;
}
