import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

// A live controlling PTY for a journey: the program runs on its own terminal (python3 `pty`, as pty-steps), and the test reads the screen and
// types keys between its own file and Git checks (a person editing a file while a worker runs, then answering the card). Each key is one write
// with a pause after it, so Ctrl+O and a decision key never arrive as one chunk (pty-steps DRIVER note, CI run 38503250233).
const RELAY = String.raw`
import fcntl, os, pty, select, struct, sys, termios
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0: os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
inputs = [fd, 0]
while True:
    ready, _, _ = select.select(inputs, [], [], 0.05)
    if fd in ready:
        try: chunk = os.read(fd, 65536)
        except OSError: chunk = b''
        if not chunk: break
        os.write(1, chunk)
    if 0 in ready:
        keys = os.read(0, 4096)
        if keys: os.write(fd, keys)
        else: inputs = [fd]
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) & 0xff)
`;
export type PtySession = Awaited<ReturnType<typeof openPtySession>>;
/** Starts `argv` on a PTY in `cwd`; `text()` is the whole output without control sequences, `mark()`/`since()` bound a wait to new output. */
export function openPtySession(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn('python3', ['-c', RELAY, ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let raw = '', exit: number | null = null;
  child.stdout.on('data', chunk => { raw += String(chunk); }); child.stderr.on('data', chunk => { raw += String(chunk); });
  const closed = new Promise<number>(resolve => child.once('close', code => { exit = code ?? -1; resolve(exit); }));
  const text = () => stripVTControlCharacters(raw);
  /** Flattened screen text: box borders and line breaks removed, so a wrapped sentence still matches. */
  const flat = (from = 0) => text().slice(from).replace(/[│┃╭╮╰╯─━\s]+/gu, ' ');
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  return {
    text, flat, mark: () => text().length, exited: () => exit, closed,
    async waitFor(needle: string | RegExp, from = 0, timeoutMs = Number(process.env['JOURNEY_WAIT_MS'] ?? 60_000)): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const screen = flat(from), at = typeof needle === 'string' ? screen.indexOf(needle) : screen.search(needle);
        if (at >= 0) { await pause(300); return text().length; }
        if (exit !== null || Date.now() > deadline) throw new Error(`waited for ${String(needle)} (exit ${exit})\n${flat(Math.max(from, text().length - 6000))}`);
        await pause(50);
      }
    },
    // An escape sequence (an arrow key) stays one write, as a terminal sends it.
    async type(keys: string) { for (const key of keys.match(/\u001b\[[A-Z0-9~;<]+|[\s\S]/gu) ?? []) { child.stdin.write(key); await pause(key === '\r' ? 120 : 25); } }, // eslint-disable-line no-control-regex
    async close() { if (exit === null) { child.stdin.end(); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await closed; clearTimeout(timer); } },
  };
}
