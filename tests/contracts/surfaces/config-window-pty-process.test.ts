import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

// J3 (TERMINAL-SABIT-DUZEN, owner 2026-10-18): the built `deckent config` window in a pseudo-terminal. While the person moves within one level
// (the sections, then one section's keys), its bottom row (the frame's closing border) and the key-hint row above it stay on the same screen rows,
// and no row is wider than the terminal. The window's PATH holds only Node (python3 is found on the driver's own PATH): no Docker or Git
// discovery runs, so the first frame does not wait on host tools (that wait is measured in the J3 handoff).
// Known open defect (J3 HANDOFF, terminal-panels owner): the window's height still changes between levels and while a filter row is shown, and
// the title and key hints are drawn twice (the window's and the embedded list's); this test pins only what holds today.
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
beforeEach(context => { if (process.platform === 'win32') context.skip('POSIX pty driver'); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** python3 `pty`: each step waits for its text, lets the screen settle, records how much output existed, then types its keys. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps, rows, cols = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ); env['PATH'] = os.environ['CHILD_PATH']
    os.execvpe(argv[0], argv, env)
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
    while wait.encode() not in out[marks[-1] if marks else 0:]:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); os.waitpid(pid, 0)
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(0)
    read_for(0.6)
    marks.append(len(out))
    if send:
        os.write(fd, send.encode()); read_for(0.6)
read_for(0.3)
try: os.kill(pid, 9); os.waitpid(pid, 0)
except OSError: pass
sys.stdout.write(json.dumps({'marks': [len(out[:mark].decode('utf8', 'replace')) for mark in marks], 'output': out.decode('utf8', 'replace')}))
`;

it('the built config window keeps its bottom border and key-hint rows fixed while moving within a level (PTY)', async () => {
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-pty-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] } } }), { mode: 0o600 });
  const env = { PATH: dirname(process.execPath), HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  await execute(process.execPath, [cli, 'init', 'policy', '--scope', 'pty', '--apply'], { cwd: project, env, timeout: 60_000 });
  const rows = 30, columns = 100;
  // Each step waits for its screen's text (counted from the previous mark), records the settled screen, then presses its keys:
  // sections ↓ ↓ ↑, Enter (the `layout` section's keys), keys ↓ ↑, Esc (back), Esc (close).
  const steps: [string, string, 'sections' | 'keys' | null][] = [['Configuration ·', '\u001b[B', 'sections'], ['layout', '\u001b[B', 'sections'], ['storage', '\u001b[A', 'sections'],
    ['layout', '\r', 'sections'], ['›', '\u001b[B', 'keys'], ['›', '\u001b[A', 'keys'], ['›', '\u001b', 'keys'], ['general', '\u001b', null]];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'config']), JSON.stringify(steps.map(([wait, send]) => [wait, send])), String(rows), String(columns)],
    { cwd: project, env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CHILD_PATH: env.PATH }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { marks?: number[]; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-4000)}`);
  const bottoms = { sections: new Set<number>(), keys: new Set<number>() };
  for (const [index, mark] of result.marks!.entries()) {
    const screen = terminalBuffers(result.output.slice(0, mark).replace(/\r?\n/g, '\r\n'), columns, rows);
    const lines = screen.text.split('\n'), bottom = lines.findLastIndex(line => line.startsWith('╰')), level = steps[index]![2];
    expect(bottom, `step ${index}\n${screen.text}`).toBeGreaterThan(0);
    expect(lines[bottom - 1], `step ${index}\n${screen.text}`).toMatch(/Esc back/u);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(columns);
    if (level) bottoms[level].add(bottom);
  }
  expect([...bottoms.sections], result.output.slice(-3000)).toHaveLength(1); expect([...bottoms.keys], result.output.slice(-3000)).toHaveLength(1);
}, 150_000);
