import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Real pseudo-terminal: the built workline sees a TTY, raw arrow keys and a window size. Ports are in-process
// (the same surface boundary as the Ink tests); this does not start the runtime service.
const execute = promisify(execFile);
const built = resolve('dist/surfaces/core/terminal/index.js');
const fixture = resolve('tests/contracts/surfaces/terminal-arrow-pickers-pty.fixture.mjs');

const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
columns = int(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, columns, 0, 0))
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
def wait(token, seconds=20):
    deadline = time.time() + seconds
    while token.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            sys.stdout.write(json.dumps({'timeout': token, 'output': out.decode('utf8', 'replace')}))
            sys.exit(3)
    read_for(0.15)
def put(data):
    os.write(fd, data)
    time.sleep(0.05)
def typed(text):
    for ch in text:
        os.write(fd, ch.encode())
        time.sleep(0.02)
wait('READY')
typed('/resume\r')
wait('PREVIEW-TOKEN-SECOND')
put(b'\x1b')
time.sleep(0.35)
typed('qq')
wait('qq')
put(b'\x15')
time.sleep(0.15)
typed('/resume\r')
time.sleep(0.5)
put(b'\x1b[B')
time.sleep(0.2)
put(b'\r')
wait('RESUMED 3')
typed('/approvals\r')
time.sleep(0.5)
put(b'\x1b[B')
time.sleep(0.2)
put(b'\r')
wait('A-SUBJECT ap-2')
put(b'\x1b')
time.sleep(0.3)
put(b'\x03')
time.sleep(0.2)
put(b'\x03')
deadline = time.time() + 15
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'narrow': False}))
`;

const NARROW = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
columns = int(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, columns, 0, 0))
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
def wait(token, seconds=20):
    deadline = time.time() + seconds
    while token.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            sys.stdout.write(json.dumps({'timeout': token, 'output': out.decode('utf8', 'replace')}))
            sys.exit(3)
    read_for(0.15)
def put(data):
    os.write(fd, data)
    time.sleep(0.05)
def typed(text):
    for ch in text:
        os.write(fd, ch.encode())
        time.sleep(0.02)
wait('READY')
typed('/resume\r')
wait('SESSION')
time.sleep(0.3)
put(b'\x1b[B')
time.sleep(0.2)
put(b'\r')
wait('RESUMED 3')
put(b'\x03'); time.sleep(0.2); put(b'\x03')
deadline = time.time() + 15
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

async function pty(driver: string, columns: number) {
  await access(built);
  const { stdout } = await execute('python3', ['-c', driver, String(columns), process.execPath, fixture], {
    cwd: process.cwd(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env['PATH'] ?? '', TERM: 'xterm-256color', NO_COLOR: '1' },
  }).catch(error => ({ stdout: String((error as { stdout?: string }).stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
}

describe('arrow pickers on a real PTY', () => {
  it('Esc returns to the composer, Enter resumes the highlighted session and opens the highlighted approval', async () => {
    const result = await pty(DRIVER, 100);
    expect(result.timeout, result.output?.slice(-500)).toBeUndefined();
    const out = result.output;
    const closed = out.indexOf('qq');
    const resumed = out.indexOf('RESUMED 3');
    expect(closed).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(closed);
    expect(out).toContain('A-SUBJECT ap-2');
    expect(out).not.toContain('A-SUBJECT ap-1');
    expect(out).not.toContain('RESUMED 1 aaaaaaaa');
  });

  it('a narrow PTY still opens the picker and Enter resumes the highlighted session', async () => {
    const result = await pty(NARROW, 20);
    expect(result.timeout, result.output?.slice(-500)).toBeUndefined();
    expect(result.output).not.toContain('PREVIEW-TOKEN-FIRST');
    expect(result.output).toContain('RESUMED 3');
    expect(result.output).not.toMatch(/Error:|TypeError/);
  });
});
