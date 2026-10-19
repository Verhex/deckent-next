import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * I-S4 on a real pseudo-terminal through the production entry (compiled CLI): bare `deckent init` opens the guided window, answers move
 * from stage to stage, the window keeps one height (its bottom border row never moves), Esc closes it, and nothing is written to the
 * folder. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const ROWS = 40, COLUMNS = 100;
/** python3 `pty` driver: each step waits for its text in the output written after the previous step's keys, then sends its keys one per write. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
steps, argv, cwd = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ${ROWS}, ${COLUMNS}, 0, 0))
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
since = 0
for wait, send in steps:
    deadline = time.time() + 25
    while wait.encode() not in out[since:]:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.4)
    marks.append(len(out))
    since = len(out)
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.15)
deadline = time.time() + 25
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'marks': marks}))
`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('bare deckent init on a real PTY (production entry)', () => {
  it('guides stage by stage in one fixed-height window, closes on Esc and writes nothing', async () => {
    await access(cli);
    const home = await mkdtemp(join(tmpdir(), 'deckent-init-pty-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-init-pty-root-'));
    roots.push(home, root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'erp-demo' }));
    // A clean environment: no AI-agent or CI marker (the test runner may itself run inside one), English, a real terminal type.
    const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
    const steps = [['Enter confirm', '1'], ['Enter confirm', '\r'], ['> 3. Folder and scope', '1'], ['Enter confirm', '\r'], ['> 4. Who uses', '\u001b'], ['Deckent setup plan', '']];
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify([process.execPath, cli, 'init']), root],
      { env: { ...env, PATH: process.env['PATH'] ?? '' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const run = JSON.parse(stdout) as { status?: number | string; output: string; marks: number[]; timeout?: string };
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.status, run.output.slice(-2000)).toBe(0);
    const screen = (mark: number) => terminalBuffers(run.output.slice(0, run.marks[mark]), COLUMNS, ROWS).text.split('\n');
    const bottom = (rows: readonly string[]) => rows.findLastIndex(row => /^[╰+└]/u.test(row));
    const rows = [0, 2, 4].map(mark => bottom(screen(mark)));
    // The language, folder and profile steps: the same window, the same bottom border row.
    expect(rows[0]).toBeGreaterThan(5);
    expect(rows).toEqual([rows[0], rows[0], rows[0]]);
    expect(screen(2).join('\n')).toContain('> 3. Folder and scope');
    expect(screen(4).join('\n')).toContain('> 4. Who uses this installation');
    // After Esc the plain summary stays in the scrollback; the folder holds only what the test put there.
    expect(run.output).toContain('Nothing was applied.');
    expect(await readdir(root)).toEqual(['package.json']);
  }, 150_000);
});
