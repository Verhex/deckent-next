import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// PERSISTENT-APPROVALS G6 on a real pseudo-terminal: the built workline shows a scoped approval card (what a standing answer covers, the offered
// keys); a raw `a`/`s`/`y` keystroke reaches the ledger port as a typed scope; a scope the card did not offer is not a key; the view prints
// what the port answered (saved, or why not). Ports are in-process (the same surface boundary as the Ink tests); no runtime service starts.
const execute = promisify(execFile);
const built = resolve('dist/surfaces/core/terminal/index.js');
const fixture = resolve('tests/contracts/surfaces/terminal-standing-card-pty.fixture.mjs');

const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
keys = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
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
def typed(text):
    for ch in text:
        os.write(fd, ch.encode())
        time.sleep(0.03)
wait('READY')
typed('go\r')
wait('remembered for npm test')
read_for(0.4)
for group in keys.split(';'):
    token, _, expect = group.partition('=')
    typed(token)
    if expect: wait(expect)
    # Always drain the terminal while waiting: a full pty buffer would block the child's repaint and with it the next key.
    read_for(0.8)
os.write(fd, b'\x03'); time.sleep(0.2); os.write(fd, b'\x03')
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

async function run(keys: string, env: Record<string, string>) {
  await access(built);
  const dir = await mkdtemp(join(tmpdir(), 'deckent-standing-pty-'));
  const decisions = join(dir, 'decisions.log');
  try {
    const { stdout } = await execute('python3', ['-c', DRIVER, keys, process.execPath, fixture], { env: { ...process.env, DECISIONS: decisions, TERM: 'xterm-256color', ...env }, timeout: 60_000 })
      .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const result = JSON.parse(stdout) as { status: unknown; output: string; timeout?: string };
    expect(result.timeout, result.output.slice(-1500)).toBeUndefined();
    return { output: result.output, decisions: (await readFile(decisions, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe.skipIf(process.platform === 'win32')('scoped approval card on a real pseudo-terminal (G6)', () => {
  it('a raw a keystroke decides allow with the always scope and the view prints what the port saved', async () => {
    const result = await run('a=S-SAVED-ALWAYS appr-pty', { SCOPES: 'session,always' });
    expect(result.output).toContain('y once · s this session · a always in this project · n deny');
    expect(result.decisions).toEqual(['appr-pty allow always']);
  });
  it('a scope the card did not offer is not a key (a does nothing), s is the session scope, and a refused save is shown with its reason', async () => {
    const result = await run('a;s=S-NOT-SAVED-SESSION appr-pty STANDING_DELEGATION', { SCOPES: 'session', SAVED: 'no' });
    expect(result.output).toContain('y once · s this session · n deny'); expect(result.output).not.toContain('a always in this project');
    expect(result.decisions).toEqual(['appr-pty allow session']);
  });
  it('y stays a single allow without a scope', async () => {
    const result = await run('y=A-ALLOWED appr-pty', { SCOPES: 'session,always' });
    expect(result.decisions).toEqual(['appr-pty allow once']);
  });
});
