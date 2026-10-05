import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { terminalScreen } from '../../fixtures/terminal-screen.js';

it.skipIf(process.platform === 'win32')('replays a real Ink PTY redraw without duplicating its visible notice', async () => {
  const driver = String.raw`
import errno, fcntl, os, pty, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 30, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
out = b''
while True:
    try: chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO: break
        raise
    if not chunk: break
    out += chunk
os.close(master)
sys.stdout.buffer.write(out)
sys.exit(child.wait())
`;
  const { stdout } = await promisify(execFile)('python3', ['-c', driver, process.execPath, resolve('tests/fixtures/terminal-redraw.mjs')],
    { timeout: 5_000, env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' } });
  expect(stdout.split('full-auto').length - 1).toBeGreaterThan(1);
  const screen = terminalScreen(stdout, 30);
  expect(screen).toContain('Permission mode: full-auto\nReady again');
  expect(screen.split('full-auto').length - 1, stdout).toBe(1);
});

it('replays Ink erasure and redraw instead of counting the PTY byte stream', () => {
  const frame = 'Permission mode: full-auto\r\nReady\r\n';
  const raw = frame + '\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G' + frame;
  expect(raw.split('full-auto')).toHaveLength(3);
  expect(terminalScreen(raw, 30)).toBe('Permission mode: full-auto\nReady');
  expect(terminalScreen(raw, 30).split('full-auto')).toHaveLength(2);
  // A real extra notice or a mode wrongly retained in the status row must still fail the one-occurrence assertion.
  expect(terminalScreen(frame + frame, 30).split('full-auto')).toHaveLength(3);
  expect(terminalScreen('Permission mode: full-auto\r\nReady · full-auto', 30).split('full-auto')).toHaveLength(3);
});

it('honors cursor movement, line/display erasure and delayed wrapping in display cells', () => {
  expect(terminalScreen('12345\r\nnext', 5)).toBe('12345\nnext');
  expect(terminalScreen('123456', 5)).toBe('12345\n6');
  expect(terminalScreen('界界x!\r\nlast', 5)).toBe('界界x\n!\nlast');
  expect(terminalScreen('abcde\r12\u001b[K', 5)).toBe('12');
  expect(terminalScreen('old\r\nline\u001b[2J\u001b[Hnew', 30)).toBe('new');
  expect(terminalScreen('one\r\ntwo\r\nthree', 30, 2)).toBe('one\ntwo\nthree');
  expect(terminalScreen('\u001b[?25l\u001b[?2026h\u001b[31mred\u001b[0m\u001b[?2026l\u001b[?25h', 30)).toBe('red');
  expect(() => terminalScreen('\u001b[99z', 30)).toThrow('VT_UNSUPPORTED_CSI');
});
