import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { clearConfigCache } from '#platform/index.js';

/**
 * J2c/J2d on a real pseudo-terminal through the production entry (compiled CLI): in a folder with no Deckent installation, the task menu
 * and the task pick (`deckent task`, `deckent task inspect` without ids) name only the one setup command, `deckent init`
 * (CLI_INSTALLATION_MISSING, exit 2), never a raw file-system error or the advanced `deckent init policy …` path, and write nothing.
 * With an installation and no scope chosen, the scope picker and the existing TERMINAL_SCOPE_REQUIRED answer stay. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
/** python3 `pty` driver: runs the command on a 100x30 terminal with nothing typed and returns its exit status and output. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, cwd = json.loads(sys.argv[1]), sys.argv[2]
# Optional: once the output shows key['after'], type key['send'] once (e.g. Esc to cancel a card).
key = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
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
deadline = time.time() + 25
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    if key and key['after'].encode('utf8') in out:
        os.write(fd, key['send'].encode('utf8')); key = None
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Runs the compiled CLI on a PTY in `root` with a clean environment: no AI-agent or CI marker, so the TTY path is taken. */
async function onTerminal(argv: readonly string[], root: string, home: string, key?: Readonly<{ after: string; send: string }>) {
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...argv]), root, ...(key ? [JSON.stringify(key)] : [])],
    { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
  return JSON.parse(stdout) as { status?: number | string; output: string };
}
async function folders(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'deckent-task-pty-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-task-pty-root-'));
  roots.push(home, root);
  return { home, root };
}

describe.skipIf(process.platform === 'win32')('deckent task on a real PTY in a folder with no installation (production entry)', () => {
  it.each([
    { argv: ['task'], next: 'No Deckent installation in this folder. Run `deckent init` to set it up.' },
    { argv: ['task', 'inspect'], next: 'No Deckent installation in this folder. Run `deckent init` to set it up.' },
    { argv: ['task', 'transcript'], next: 'No Deckent installation in this folder. Run `deckent init` to set it up.' },
    { argv: ['task', '--lang', 'tr'], next: 'Bu klasörde Deckent kurulumu yok. Kurmak için `deckent init` çalıştırın.' },
  ])('NEGATIVE: deckent $argv names only `deckent init` with a typed code, exit 2, and writes nothing', async ({ argv, next }) => {
    await access(cli);
    const { home, root } = await folders();
    const run = await onTerminal(argv, root, home);
    expect(run.output, run.output).toContain('[CLI_INSTALLATION_MISSING]');
    expect(run.output).toContain(next);
    expect(run.output).toContain('deckent init');
    expect(run.output).not.toMatch(/init policy|TERMINAL_SCOPE_REQUIRED|ENOENT|\[UNKNOWN\]/u);
    expect(run.status, run.output).toBe(2);
    expect(await readdir(root)).toEqual([]);
  }, 90_000);

  it('NEGATIVE: with an installation and no scope chosen, `deckent task` offers the scope picker and bare `deckent` keeps TERMINAL_SCOPE_REQUIRED', async () => {
    await access(cli);
    const { home, root } = await folders();
    await applyPolicyTemplateInstallation(root, 'installation');
    // The first-session config pins the terminal scope; drop it so no scope is chosen.
    const file = join(root, '.deckent/config.json'), config = JSON.parse(await readFile(file, 'utf8')) as { terminal?: Record<string, unknown> };
    delete config.terminal?.['scopeId']; await writeFile(file, JSON.stringify(config)); clearConfigCache();
    const task = await onTerminal(['task'], root, home, { after: 'Esc', send: '\u001b' });
    expect(task.output, task.output).toContain('Scope for deckent task');
    expect(task.output).not.toMatch(/CLI_INSTALLATION_MISSING|No Deckent installation/u);
    const bare = await onTerminal([], root, home);
    expect(bare.output, bare.output).toContain('Select a scope: run `deckent init policy --scope <id> --apply`, then `deckent --scope <id>`. [TERMINAL_SCOPE_REQUIRED]');
    expect(bare.output).not.toMatch(/CLI_INSTALLATION_MISSING|No Deckent installation/u);
    expect(bare.status, bare.output).toBe(2);
  }, 120_000);
});
