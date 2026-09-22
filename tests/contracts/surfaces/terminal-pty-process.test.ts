import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * A real pseudo-terminal (python3 `pty`, POSIX only): the built executable sees TTY stdin/stdout, raw keys and a window
 * size. Each step waits for text on the terminal before typing, with a hard deadline per step.
 */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
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
for wait, send in steps:
    deadline = time.time() + 15
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.3)  # let the view settle (raw mode, input subscription) before typing
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.01)
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

async function project(config: Record<string, unknown> = {}) {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true }), mkdir(home, { recursive: true })]);
  await writeFile(join(projectRoot, '.deckent', 'config.json'), JSON.stringify(config));
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  return { projectRoot, env };
}

async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>) {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)],
    { cwd, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
}

describe.skipIf(process.platform === 'win32')('deckent terminal in a real pseudo-terminal', () => {
  it('renders the workline, routes /workers through policy, surfaces a typed chat block and exits on /exit', async () => {
    const f = await project();
    const result = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'pty-scope'], [
      ['Deckent workline', '/workers\r'],
      ['POLICY_UNAVAILABLE', 'hello\r'],
      ['TERMINAL_CHAT_NOT_CONFIGURED', '/nope\r'],
      ['Unknown command: /nope', '/exit\r'],
    ]);
    expect(result.timeout, result.output).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output).toContain('pty-scope');
    const colour = new RegExp(`${String.fromCharCode(27)}\\[(3[0-7]|9[0-7]|38;)`);
    expect(result.output).not.toMatch(colour);
  });

  it('exits on idle Ctrl+C in a real terminal', async () => {
    const f = await project();
    const result = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'pty-scope'], [['Deckent workline', '\u0003']]);
    expect(result.timeout, result.output).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('degrades when piped: the rich view refuses with a typed usage error, line mode runs', async () => {
    const f = await project();
    const piped = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, 'terminal', 'workline', '--scope', 's'], { cwd: f.projectRoot, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolvePromise({ code, stderr, stdout })); child.stdin.end();
    });
    expect(piped.code).toBe(2); expect(piped.stderr).toContain('TERMINAL_TTY_REQUIRED'); expect(piped.stdout).toBe('');
    const line = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, 'terminal', 'session', '--scope', 's'], { cwd: f.projectRoot, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolvePromise({ code, stderr, stdout })); child.stdin.end('hello\n');
    });
    expect(line.code).toBe(0); expect(`${line.stdout}${line.stderr}`).toContain('TERMINAL_CHAT_NOT_CONFIGURED');
  });
});
