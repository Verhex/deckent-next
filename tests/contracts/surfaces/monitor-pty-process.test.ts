import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';
import { fullSnapshot } from '../../fixtures/monitor/snapshots.js';

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
backgrounds = json.loads(sys.argv[5]) if len(sys.argv) > 5 else []
queries = 0
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
out = b''
marks = []
def read_for(seconds):
    global out, queries
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: return False
            if not chunk: return False
            out += chunk
            count = out.count(b'\x1b]11;?')
            while queries < count and queries < len(backgrounds):
                rgb = backgrounds[queries]
                os.write(fd, ('\x1b]11;rgb:'+rgb+'\x07\x1b[?62c').encode())
                queries += 1
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

/** The compiled host and embedded monitor: keep the opening palette stale on purpose. */
async function embeddedTheme(root: string) {
  const fixture = join(root, 'monitor-theme.mjs');
  const module = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
  await writeFile(fixture, `
import { createElement, useState } from ${module('node_modules/react/index.js')};
import { Text, useInput } from ${module('node_modules/ink/build/index.js')};
import { openTerminalHost } from ${module('dist/surfaces/core/terminal-host/index.js')};
import { terminalPalette } from ${module('dist/surfaces/core/terminal-kit/index.js')};
import { loadMonitorSurface } from ${module('dist/surfaces/core/monitor/index.js')};
const surface = await loadMonitorSurface(), snapshot = ${JSON.stringify(fullSnapshot)};
const palette = terminalPalette('light', 'truecolor', undefined, '#F0ECE5');
const monitor = surface.monitorWindowView({ palette, load: async () => snapshot, initial: snapshot, intervalMs: 60000, locale: 'en', ascii: false, errorText: String });
let host;
function View({ context }) {
  const [opened, open] = useState(false);
  useInput(input => { if (input === 'h') context.theme.apply('light-high-contrast'); if (input === 'o') open(true); if (input === 'a') context.theme.apply('auto'); if (input === 'x') void host.close(); });
  return opened ? monitor({ active: true, onClose() {}, size: { columns: 100, rows: 25 } }) : createElement(Text, null, 'READY');
}
host = await openTerminalHost({ palette, theme: { setting: 'light', capability: 'truecolor' }, fullscreen: false, view: context => createElement(View, { context }) });
await host.wait();
`);
  const steps = [['READY', 'h'], ['READY', 'o'], ['[1 ', '2'], ['[2 Runs]', 'a'], ['[2 Runs]', '\u001b[?997;1n'], ['[2 Runs]', 'x']];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, fixture]), JSON.stringify(steps), '30', '100',
    JSON.stringify(['f0/ec/e5', '1e/1e/1e'])], { env: { PATH: process.env['PATH'], TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { marks: number[]; output: string; code: number | null; timeout?: string };
  expect(result.timeout, result.output.slice(-4000)).toBeUndefined(); expect(result.code).toBe(0);
  const frame = (index: number) => result.output.slice(result.marks[index - 1], result.marks[index]);
  const esc = '\u001b[';
  // Exact palette tokens: high contrast at opening, host apply while open, then DEC 2031's dark background. The tab stays on Runs.
  expect(frame(2)).toContain(`${esc}38;2;10;48;105m[1 `);
  expect(frame(4)).toContain(`${esc}38;2;11;106;158m[2 Runs]`);
  expect(frame(5)).toContain(`${esc}38;2;56;211;255m[2 Runs]`);
  expect(frame(5)).not.toContain(`${esc}38;2;11;106;158m[2 Runs]`);
}

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
  await embeddedTheme(root);
}, 150_000);
