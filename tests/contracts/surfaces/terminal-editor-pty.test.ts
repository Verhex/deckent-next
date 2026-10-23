import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * T4 (Ctrl+G, as in Claude Code and Codex) on a real pseudo-terminal through the production entry and the production editor adapter: every key typed
 * in the editor reaches the editor (this process stops reading the TTY), the draft comes back, the screen and the input are restored, and a Ctrl+C
 * that a cooked-mode editor turns into SIGINT ends the editor, never the terminal. Full window and inline layout. Requires `npm run build`.
 */
const execute = promisify(execFile);
const fixture = resolve('tests/contracts/surfaces/terminal-editor-pty.fixture.mjs');
const editor = resolve('tests/fixtures/terminal-editor/tty-editor.mjs');
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, __import__('termios').TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
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
start = 0
for wait, send, pause in steps:
    deadline = time.time() + 20
    # Each wait looks only after the previous step's match (a word can appear again).
    while out.decode('utf8', 'replace').find(wait, start) < 0:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    start = out.decode('utf8', 'replace').find(wait, start) + len(wait)
    read_for(pause)
    marks.append(len(out.decode('utf8', 'replace')))
    if send: os.write(fd, send.encode())
read_for(0.5)
os.write(fd, b'\x03'); time.sleep(0.3); os.write(fd, b'\x03')
deadline = time.time() + 10
while time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: break
sys.stdout.write(json.dumps({'output': out.decode('utf8', 'replace'), 'marks': marks}))
`;
type Step = readonly [wait: string, send: string, pause: number];
async function pty(steps: readonly Step[], layout: 'fullscreen' | 'inline', mode: 'raw' | 'cooked') {
  await access(resolve('dist/surfaces/core/terminal/index.js'));
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), process.execPath, fixture, layout],
    { env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', EDITOR: `"${process.execPath}" "${editor}"`, FIXTURE_TTY_EDITOR: mode }, timeout: 90_000 })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
  const result = JSON.parse(stdout) as { output: string; marks: number[]; timeout?: string };
  expect(result.timeout, result.output?.slice(-2500)).toBeUndefined();
  return result;
}
const MOUSE_OFF = '\u001b[?1006l\u001b[?1002l\u001b[?1000l', MOUSE_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1006h';

describe.skipIf(process.platform === 'win32')('external editor on a real PTY (production entry and adapter)', () => {
  for (const layout of ['fullscreen', 'inline'] as const) {
    it(`${layout}: the editor gets every typed key, the draft comes back and the terminal takes its input again`, async () => {
      const run = await pty([['READY', 'draft-one', 0.3], ['draft-one', '\u0007', 0.2], ['EDITOR-OPEN[draft-one]', 'typed-in-editor\r', 0.2],
        ['EDITOR-GOT[', '', 0.6], ['draft-one typed-in-editor', '\r', 0.2], ['draft-one typed-in-editor-line-2', '', 0.3]], layout, 'raw');
      // Not one key went to the terminal: the editor read the whole line.
      expect(run.output).toContain('EDITOR-GOT[typed-in-editor]');
      if (layout === 'fullscreen') {
        const handed = run.output.slice(run.marks[1], run.output.indexOf('EDITOR-OPEN'));
        expect(handed).toContain(MOUSE_OFF); expect(handed).toContain('\u001b[?1049l');
        const back = run.output.slice(run.output.indexOf('EDITOR-GOT['), run.marks[4]);
        expect(back).toContain(MOUSE_ON); expect(back).toContain('\u001b[?1049h');
      }
    }, 120_000);
  }

  it('Ctrl+C in a cooked-mode editor ends the editor (SIGINT to the group), never the terminal; the draft is kept', async () => {
    const run = await pty([['READY', 'keep', 0.3], ['keep', '\u0007', 0.2], ['EDITOR-OPEN[keep]', '\u0003', 0.3], ['EDITOR-FAILED', 'X', 0.3], ['keepX', '\u0015', 0.3]],
      'fullscreen', 'cooked');
    expect(run.output.slice(run.marks[2])).not.toContain('EDITOR-GOT[');
    // Still the same process: the draft took the next key, and the two closing Ctrl+C on the emptied line end it normally.
    expect(run.output).toContain('EXIT-CLEAN');
  }, 120_000);
});
