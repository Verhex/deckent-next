import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * TERMINAL-SABIT-DUZEN on a real pseudo-terminal through the production entry (alternate screen + mouse filter): the wheel scrolls the
 * conversation, a "new messages" row appears while scrolled back during streaming, End jumps to the latest, the bar never moves, and mouse
 * reports (wheel or click) never answer a card. TERM-POLISH: a tool step stands one blank line apart from the text around it and from the next
 * tool step; click and drag selects the conversation and the release copies it with OSC 52. Requires `npm run build`.
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
  const clean = (text: string) => ['\u001b[?1000h', '\u001b[?1002h', '\u001b[?1006h', '\u001b[?1006l', '\u001b[?1002l', '\u001b[?1000l'].reduce((rest, mode) => rest.replaceAll(mode, ''), text);
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
    expect(run.output).toContain('\u001b[?1000h\u001b[?1002h\u001b[?1006h'); expect(run.output).toContain('\u001b[?1006l\u001b[?1002l\u001b[?1000l');
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
    // The mouse reports go in once the card's keys count (armed: its key hints show), so they could have answered it if they reached it.
    // alpha.59 L3: Ctrl+Y on the armed card sends its drawn text with OSC 52 (the host's one writer) and neither answers nor re-arms it; a
    // left-drag over its body rows (screen rows 12-15, under the title) selects them and the release copies them the same way.
    const DRAG_CARD = '\u001b[<0;3;12M\u001b[<32;40;14M\u001b[<32;80;15M\u001b[<0;80;15m';
    const run = await pty([['READY', 'card\r', 0.2], ['Enter confirm', `${WHEEL_UP}${CLICK}${WHEEL_DOWN}${CLICK}`, 0.6], ['Approval needed', '', 0.5], ['Enter confirm', '\u0019', 0.5],
      ['Enter confirm', DRAG_CARD, 0.6], ['Enter confirm', 'n', 0.2], ['READY', '', 0.5]]);
    const before = run.screen(2).join('\n');
    expect(before).toContain('Approval needed'); expect(before).toContain('Ctrl+Y COPY'); expect(run.screen(4).join('\n')).toMatch(/CARD-SENT \d+/u);
    // eslint-disable-next-line no-control-regex -- the OSC 52 clipboard request is a control sequence.
    const copy = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/u.exec(run.output.slice(run.marks[3], run.marks[4]));
    expect(copy, run.output.slice(run.marks[3], run.marks[3]! + 600)).not.toBeNull();
    expect(Buffer.from(copy![1]!, 'base64').toString('utf8')).toContain('rm -rf build');
    // eslint-disable-next-line no-control-regex -- the OSC 52 clipboard request is a control sequence.
    const dragged = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/u.exec(run.output.slice(run.marks[4], run.marks[5]));
    expect(dragged, run.output.slice(run.marks[4], run.marks[4]! + 600)).not.toBeNull();
    const selected = Buffer.from(dragged![1]!, 'base64').toString('utf8');
    expect(selected).toMatch(/^What: +A shell command will run\nCommand: +rm -rf build\n +Detailed fields are not available from this service version; the producer's/u); expect(selected).not.toMatch(/Yes, once|Approval needed|│/u);
    // The child writes its decisions to stderr (the same PTY): none before the deliberate n, a deny after it.
    expect(run.output.slice(0, run.marks[5]).includes('DECIDED'), run.output.slice(Math.max(0, run.output.indexOf('DECIDED') - 600), run.output.indexOf('DECIDED') + 40)).toBe(false); expect(run.output.slice(run.marks[5])).toContain('DECIDED deny');
    expect(run.screen(6).join('\n')).not.toContain('Approval needed');
  }, 120_000);

  it('Ctrl+S puts the draft aside and brings it back, Ctrl+_ undoes, and neither key ever answers a card (real TTY: no XOFF freeze)', async () => {
    const run = await pty([['READY', 'draft-abc', 0.2], ['draft-abc', '\u0013', 0.3], ['STASHED', '\u0013', 0.3], ['READY', 'X', 0.2], ['draft-abcX', '\u001f', 0.3],
      ['READY', '\u0013', 0.3], ['STASHED', 'card\r', 0.2], ['Approval needed', '\u0013\u001f', 0.6], ['Approval needed', '', 0.2]]);
    const composer = (mark: number) => run.screen(mark).find(row => row.startsWith('│ > ')) ?? '';
    expect(composer(3)).toContain('draft-abc'); // restored
    expect(composer(5)).toContain('draft-abc'); expect(composer(5)).not.toContain('draft-abcX'); // undone
    expect(run.output.slice(0, run.marks[8]).includes('DECIDED')).toBe(false);
  }, 120_000);

  it('Ctrl+F searches the kept conversation while scrolled back and Ctrl+Up jumps to the person\'s message (real TTY keys)', async () => {
    const run = await pty([['READY', 'alpha\r', 0.2], ['alpha-line-3', 'long\r', 0.2], ['long-line-79', '\u001b[5~\u001b[5~', 0.4], ['BELOW', '\u0006', 0.3],
      ['FIND[', 'alpha-line-1', 0.3], ['FIND[alpha-line-1]', '\u001b', 0.3], ['BELOW', '\u001b[1;5A', 0.4], ['BELOW', '', 0.2]]);
    const found = run.screen(5).join('\n');
    expect(found).toContain('FIND[alpha-line-1]'); expect(found).toMatch(/^ +alpha-line-1$/mu); expect(found).not.toContain('NONE');
    // Ctrl+Up: the person's previous message ("long") is now the view's first row block.
    expect(run.screen(7).slice(0, 3).join('\n')).toMatch(/│ long|you/u);
  }, 120_000);

  it('tool steps stand one blank line apart; drag selects the conversation and the release copies the shown text with OSC 52 (bar fixed)', async () => {
    const PRESS = '\u001b[<0;1;1M', DRAG = '\u001b[<32;40;10M', DRAG_OUT = '\u001b[<32;80;20M', RELEASE = '\u001b[<0;80;20m';
    const run = await pty([['READY', 'long\r', 0.2], ['long-line-79', 'tool\r', 0.2], ['TXT-AFTER', '', 0.8], ['READY', `${PRESS}${DRAG}${DRAG_OUT}${RELEASE}`, 0.8],
      ['COPIED', '', 0.4]]);
    const turn = run.screen(3), bar = barTop(turn);
    const at = (token: string) => turn.findIndex(row => row.includes(token));
    const before = at('TXT-BEFORE'), first = at('TOOL read_file a.ts'), second = at('TOOL grep needle'), after = at('TXT-AFTER');
    expect([before, first, second, after], turn.join('\n')).toEqual([before, before + 2, before + 4, before + 6]);
    for (const row of [before + 1, first + 1, second + 1]) expect(turn[row]).toBe('');
    // The selection ran from the first screen row to past the last conversation line (clamped to it): exactly the rows the screen showed.
    // eslint-disable-next-line no-control-regex -- the OSC 52 clipboard sequence is a control sequence.
    const copy = /\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/u.exec(run.output.slice(run.marks[3]!));
    expect(copy, run.output.slice(run.marks[3]!, run.marks[3]! + 400)).not.toBeNull();
    const pasted = Buffer.from(copy![1]!, 'base64').toString('utf8'), shown = turn.slice(0, bar).map(row => row.trimEnd()).join('\n');
    expect(pasted.replace(/\n+$/u, '')).toBe(shown.replace(/\n+$/u, ''));
    expect(pasted).toContain('TXT-AFTER');
    const copied = run.screen(4);
    expect(copied.join('\n')).toMatch(/COPIED \d+/u);
    expect(barTop(copied)).toBe(bar);
    // The mouse reports never reached the composer as text.
    expect(copied.join('\n')).not.toMatch(/\[<(?:0|32);/u);
  }, 120_000);
});
