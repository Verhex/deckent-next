import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * TERMINAL-SABIT-DUZEN on a real pseudo-terminal through the production entry (alternate screen + mouse filter): the wheel scrolls the
 * conversation, a "new messages" row appears while scrolled back during streaming, End jumps to the latest, the bar never moves, and mouse
 * reports (wheel or click) never answer a card. Requires `npm run build`.
 */
const execute = promisify(execFile);
const built = resolve('dist/surfaces/core/terminal/index.js');
const fixture = resolve('tests/contracts/surfaces/terminal-fullscreen-pty.fixture.mjs');
const ROWS = 24, COLUMNS = 80;
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, __import__('termios').TIOCSWINSZ, struct.pack('HHHH', ${ROWS}, ${COLUMNS}, 0, 0))
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
for wait, send, pause in steps:
    deadline = time.time() + 20
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
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
async function pty(steps: readonly Step[]) {
  await access(built);
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), process.execPath, fixture], { env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' }, timeout: 90_000 })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
  const result = JSON.parse(stdout) as { output: string; marks: number[]; timeout?: string };
  expect(result.timeout, result.output?.slice(-2000)).toBeUndefined();
  const complete = (end: number) => { const at = result.output.lastIndexOf('\u001b[?2026l', end); return at < 0 ? end : at + '\u001b[?2026l'.length; };
  // The replay fixture does not know mouse-mode toggles; they are presentation only.
  const clean = (text: string) => text.replaceAll('\u001b[?1000h', '').replaceAll('\u001b[?1006h', '').replaceAll('\u001b[?1006l', '').replaceAll('\u001b[?1000l', '');
  const screen = (mark: number) => terminalBuffers(clean(result.output.slice(0, complete(result.marks[mark]!))), COLUMNS, ROWS).text.split('\n');
  return { ...result, screen };
}
const WHEEL_UP = '\u001b[<64;10;5M', WHEEL_DOWN = '\u001b[<65;10;5M', CLICK = '\u001b[<0;10;20M\u001b[<0;10;20m';
const barTop = (rows: readonly string[]) => rows.findLastIndex(row => row.startsWith('╭'));

describe.skipIf(process.platform === 'win32')('full window on a real PTY (production entry)', () => {
  it('wheel scrolls back; a new-messages row appears while streaming; End jumps to the latest; the bar row never moves', async () => {
    const run = await pty([
      ['READY', 'first\r', 0.2], ['first-line-3', 'long\r', 0.2], ['long-line-20', `${WHEEL_UP}${WHEEL_UP}${WHEEL_UP}${WHEEL_UP}`, 0.1],
      ['NEW ', '', 0.6], ['NEW ', '', 3.6], ['NEW ', '\u001b[F', 0.1], ['long-line-79', '', 0.6]]);
    expect(run.output).toContain('\u001b[?1000h'); expect(run.output).toContain('\u001b[?1006h'); expect(run.output).toContain('\u001b[?1000l');
    const start = run.screen(0), scrolled = run.screen(4), jumped = run.screen(6);
    expect(barTop(start)).toBeGreaterThan(10);
    expect(barTop(scrolled)).toBe(barTop(start)); expect(barTop(jumped)).toBe(barTop(start));
    // Scrolled back while the answer streamed: the newest line is not on screen and the row names the new messages (or lines) and End.
    expect(scrolled.join('\n')).toMatch(/(?:NEW|BELOW) \d+ END/u); expect(scrolled.join('\n')).not.toContain('long-line-79');
    // End: following again, the newest line is just above the bar and the row is gone.
    expect(jumped.join('\n')).toContain('long-line-79'); expect(jumped.join('\n')).not.toMatch(/(?:NEW|BELOW) \d+ END/u);
    // No mouse report reached the composer as text.
    expect(jumped.join('\n')).not.toMatch(/\[<6[45];/u);
  }, 120_000);

  it('wheel and clicks over an approval card never answer it; a deliberate key does', async () => {
    const run = await pty([['READY', 'card\r', 0.2], ['Approval needed', `${WHEEL_UP}${CLICK}${WHEEL_DOWN}${CLICK}`, 0.6], ['Approval needed', '', 0.5], ['Approval needed', 'n', 0.2], ['READY', '', 0.5]]);
    const before = run.screen(2).join('\n');
    expect(before).toContain('Approval needed');
    // The child writes its decisions to stderr (the same PTY): none before the deliberate n, a deny after it.
    expect(run.output.slice(0, run.marks[3]).includes('DECIDED'), run.output.slice(Math.max(0, run.output.indexOf('DECIDED') - 600), run.output.indexOf('DECIDED') + 40)).toBe(false); expect(run.output.slice(run.marks[3])).toContain('DECIDED deny');
    expect(run.screen(4).join('\n')).not.toContain('Approval needed');
  }, 120_000);
});
