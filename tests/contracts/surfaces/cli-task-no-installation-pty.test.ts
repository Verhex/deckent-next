import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * J2c on a real pseudo-terminal through the production entry (compiled CLI): in a folder with no Deckent installation, the task menu and the
 * task pick (`deckent task`, `deckent task inspect` without ids) answer with the same typed next step as bare `deckent`
 * (TERMINAL_SCOPE_REQUIRED, exit 2, `deckent init policy …`), never a raw file-system error, and write nothing. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
/** python3 `pty` driver: runs the command on a 100x30 terminal with nothing typed and returns its exit status and output. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, cwd = json.loads(sys.argv[1]), sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
out = b''
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
deadline = time.time() + 25
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('deckent task on a real PTY in a folder with no installation (production entry)', () => {
  it.each([
    { argv: ['task'], language: 'en', next: 'Select a scope: run `deckent init policy --scope <id> --apply`' },
    { argv: ['task', 'inspect'], language: 'en', next: 'Select a scope: run `deckent init policy --scope <id> --apply`' },
    { argv: ['task', '--lang', 'tr'], language: 'tr', next: 'Bir kapsam seçin: `deckent init policy --scope <id> --apply` çalıştırın' },
  ])('NEGATIVE: deckent $argv names the setup step with a typed code, exit 2, and writes nothing', async ({ argv, next }) => {
    await access(cli);
    const home = await mkdtemp(join(tmpdir(), 'deckent-task-pty-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-task-pty-root-'));
    roots.push(home, root);
    // A clean environment: no AI-agent or CI marker (the test runner may itself run inside one), so the TTY menu path is taken.
    const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...argv]), root],
      { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const run = JSON.parse(stdout) as { status?: number | string; output: string };
    expect(run.output, run.output).toContain('[TERMINAL_SCOPE_REQUIRED]');
    expect(run.output).toContain(next);
    expect(run.output).not.toMatch(/ENOENT|\[UNKNOWN\]/u);
    expect(run.status, run.output).toBe(2);
    expect(await readdir(root)).toEqual([]);
  }, 90_000);
});
