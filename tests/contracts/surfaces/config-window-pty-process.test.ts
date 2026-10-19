import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

// J3 (TERMINAL-SABIT-DUZEN, owner 2026-10-18) and TERM-PANEL (owner 2026-10-19, alpha.48): the built `deckent config` window in a
// pseudo-terminal. Its bottom row (the frame's closing border) and the key-hint row above it stay on the same screen rows on the Loading frame,
// across the levels (sections, one section's keys, one key's values), while a filter row is shown and after going back; the title is drawn
// once and the key hints once (the window's chrome, not also the embedded list's), and no row is wider than the terminal. The window's PATH
// holds only Node (python3 is found on the driver's own PATH): no Docker or Git discovery runs, so the first frame does not wait on host tools
// (that wait is measured in the J3 handoff, part B).
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

/** The screen once `upto` characters of output were drawn: its lines, the closing border's row and the lines that hold the title or the hints. */
function screenAt(output: string, upto: number, columns: number, rows: number) {
  const lines = terminalBuffers(output.slice(0, upto).replace(/\r?\n/g, '\r\n'), columns, rows).text.split('\n');
  return { lines, bottom: lines.findLastIndex(line => line.startsWith('╰')), titles: lines.filter(line => line.includes('Configuration ·')).length,
    hints: lines.filter(line => line.includes('↑↓')).length, text: lines.join('\n') };
}

it('the built config window keeps one title, one key-hint row and its bottom border fixed across levels, the filter and the Loading frame (PTY)', async () => {
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-pty-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] } } }), { mode: 0o600 });
  const env = { PATH: dirname(process.execPath), HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  await execute(process.execPath, [cli, 'init', 'policy', '--scope', 'pty', '--apply'], { cwd: project, env, timeout: 60_000 });
  const rows = 30, columns = 100;
  // Each step waits for its screen's text (counted from the previous mark), records the settled screen, then presses its keys:
  // sections: `e` (filter) · Backspace · ↓ · ↑ · Enter (the `general` section's keys) · ↓ · Enter (`output_mode`'s values) · Esc · Esc · Esc (close).
  const steps: [string, string, string][] = [['Configuration ·', 'e', 'sections'], ['filter: e', '\u007f', 'sections, filter "e"'], ['general', '\u001b[B', 'sections'],
    ['layout', '\u001b[A', 'sections'], ['general', '\r', 'sections'], ['Takes:', '\u001b[B', 'general keys'], ['output_mode', '\r', 'general keys'],
    ['explanatory', '\u001b', 'output_mode values'], ['Takes:', '\u001b', 'general keys (back)'], ['general', '\u001b', 'sections (back)']];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'config']), JSON.stringify(steps.map(([wait, send]) => [wait, send])), String(rows), String(columns)],
    { cwd: project, env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CHILD_PATH: env.PATH }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { marks?: number[]; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-4000)}`);
  // The Loading frame: the first frame that says "Loading…", up to the end of its synchronized update.
  const loadingAt = result.output.indexOf('Loading…'), loadingEnd = result.output.indexOf('\u001b[?2026l', loadingAt);
  expect(loadingAt, result.output.slice(0, 2000)).toBeGreaterThan(-1);
  const loading = screenAt(result.output, loadingEnd > loadingAt ? loadingEnd : result.marks![0]!, columns, rows);
  const screens = result.marks!.map((mark, index) => ({ label: steps[index]![2], ...screenAt(result.output, mark, columns, rows) }));
  const table = [`Loading…: border row ${loading.bottom}, title rows ${loading.titles}, hint rows ${loading.hints}`,
    ...screens.map(screen => `${screen.label}: border row ${screen.bottom}, title rows ${screen.titles}, hint rows ${screen.hints}`)];
  if (process.env['DECKENT_TERM_PANEL_ROWS']) await writeFile(process.env['DECKENT_TERM_PANEL_ROWS'], [...table, '', `===== Loading…\n${loading.text}`, ...screens.map(screen => `===== ${screen.label}\n${screen.text}`)].join('\n'));
  expect(loading.bottom, loading.text).toBeGreaterThan(0);
  for (const screen of screens) {
    const where = `${screen.label}\n${screen.text}`;
    expect(screen.bottom, where).toBeGreaterThan(0);
    expect(screen.lines[screen.bottom - 1], where).toMatch(/Esc /u);
    expect(screen.titles, `the title once: ${where}`).toBe(1);
    expect(screen.hints, `one key-hint row: ${where}`).toBe(1);
    for (const line of screen.lines) expect(line.length, line).toBeLessThanOrEqual(columns);
  }
  expect(new Set([loading.bottom, ...screens.map(screen => screen.bottom)]).size, table.join('\n')).toBe(1);
}, 150_000);
