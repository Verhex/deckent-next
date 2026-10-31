import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

// PB-MON-UX at the real boundary: the built `deckent monitor` in a pseudo-terminal. Its status and key-hint rows stay on the same screen rows
// on every tab, in help, in the Config tab (`a`) and while the `/` filter is open (TERMINAL-SABIT-DUZEN: the bottom bar never moves).
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
beforeEach(context => { if (process.platform === 'win32') context.skip('POSIX pty driver'); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** python3 `pty`: each step waits for its text, types its keys, and records how much output existed once the screen settled. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps, rows, cols = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
out = b''
marks = []
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
for wait, send in steps:
    deadline = time.time() + 40
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); os.waitpid(pid, 0)
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(0)
    read_for(0.6)
    marks.append(len(out.decode('utf8', 'replace')))
    if send:
        os.write(fd, send.encode()); read_for(0.6)
read_for(0.3)
ended, status = os.waitpid(pid, os.WNOHANG)
code = os.waitstatus_to_exitcode(status) if ended else None
if not ended:
    os.kill(pid, 9); os.waitpid(pid, 0)
sys.stdout.write(json.dumps({'marks': marks, 'output': out.decode('utf8', 'replace'), 'code': code}))
`;

it('the built monitor keeps its status and key-hint rows fixed across tabs, help, Config and the filter (PTY)', async () => {
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-pty-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] } } }));
  const rows = 30, columns = 100;
  // Each step: wait for a text, then press keys; the screen is checked once it settled after the wait.
  const steps: [string, string][] = [['Tab/', '2'], ['[2 Runs]', '3'], ['[3 Workers]', '6'], ['[6 Installs]', '7'], ['[7 Map]', '8'], ['[8 Config]', 'a'],
    ['Showing all', '?'], ['Legend', '\u001b'], ['a all/changed', '/'], ['Enter keeps', '\u001b'], ['a all/changed', 'q']];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'monitor', '--lang', 'en']), JSON.stringify(steps), String(rows), String(columns)],
    { cwd: project, env: { ...process.env, HOME: join(root, 'home'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1', COLUMNS: String(columns) }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { marks?: number[]; timeout?: string; output: string; code?: number | null };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-4000)}`);
  expect(result.code).toBe(0);
  // Switching to the shared theme host must preserve Ink's earlier Ctrl+C exit, including from the filter.
  const interrupted = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'monitor', '--lang', 'en']),
    JSON.stringify([['Tab/', '/'], ['Enter keeps', '\u0003']]), String(rows), String(columns)],
    { cwd: project, env: { ...process.env, HOME: join(root, 'home'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' }, timeout: 30_000 });
  expect((JSON.parse(interrupted.stdout) as { code: number | null }).code).toBe(0);
  const hintRows = new Set<number>(), statusRows = new Set<number>();
  for (const [index, mark] of result.marks!.entries()) {
    const screen = terminalBuffers(result.output.slice(0, mark).replace(/\r?\n/g, '\r\n'), columns, rows);
    expect(screen.alternate, `step ${index}`).toBe(true);
    const lines = screen.text.split('\n');
    // The hint row is the last written row (rows − 1 lines: the frame never fills the last row); the status row is directly above it.
    const hint = lines.length - 1;
    expect(lines[hint], `step ${index}\n${screen.text}`).toMatch(/^Tab\/←→ /u);
    hintRows.add(hint); statusRows.add(hint - 1);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(columns);
  }
  expect([...hintRows]).toEqual([rows - 2]); expect([...statusRows]).toEqual([rows - 3]);
}, 150_000);
