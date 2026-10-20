import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

// CONFIG-PARTIAL-NOTICE (toplu 2026-10-20): the built `deckent config set execution.docker.imageId` window in a pseudo-terminal, with a slow
// fake `docker` first on PATH. It lists twelve local images and answers `context inspect`/`info` at once; `image inspect` answers at once
// for the chunk holding the first image and never for the others, so the discovery deadline cuts the list short. The key's focus lines say
// so once ("Showing the N found before the time limit"), on the key and on its values; with every chunk answering, nothing is said.
// The fixture sets the discovery limit (`toolchains.currency.timeoutMs`) to 2 s so the slow case waits 2 s, not the 5 s default.
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [];
beforeEach(context => { if (process.platform === 'win32') context.skip('POSIX pty driver and shell fake docker'); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** python3 `pty`: each step waits for its text (after the previous mark), lets the screen settle, records the output length, then types. */
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

const ids = Array.from({ length: 12 }, (_, n) => `sha256:${(n + 1).toString(16).padStart(2, '0').repeat(32)}`);
/** A read-only fake of the Docker CLI calls discovery makes; `slow`: every inspect chunk without the first image sleeps past the deadline. */
const fakeDocker = (slow: boolean) => `#!/bin/sh
case "$1 $2" in
  "image ls") printf '%s\\n' ${ids.join(' ')}; exit 0 ;;
  "context inspect") printf '%s\\n' '{"Host":"unix:///var/run/docker.sock"}'; exit 0 ;;
esac
case "$3" in info) echo fake-daemon-1; exit 0 ;; esac
shift 4
ids=""
for arg in "$@"; do case "$arg" in sha256:*) ids="$ids $arg" ;; esac; done
case "$ids" in *${ids[0]}*) ;; *) ${slow ? 'exec sleep 30' : ':'} ;; esac
for id in $ids; do echo "$id"; done
`;

async function run(slow: boolean, rows: number, columns: number) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-partial-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), bin = join(root, 'bin');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'docker'), fakeDocker(slow), { mode: 0o700 }); await chmod(join(bin, 'docker'), 0o700);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] } }, toolchains: { currency: { timeoutMs: 2000 } } }), { mode: 0o600 });
  const env = { PATH: dirname(process.execPath), HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  await execute(process.execPath, [cli, 'init', 'policy', '--scope', 'pty', '--apply'], { cwd: project, env, timeout: 60_000 });
  // The window narrowed to the key: its section · Enter (the key, with its focus lines) · Enter (the key's values) · Esc · Esc · Esc (close).
  const steps: [string, string, string][] = [['Configuration ·', '\r', 'section'], ['docker.imageId ›', '\r', 'key'], ['Docker ·', '\u001b', 'values'], ['docker.imageId ›', '\u001b', 'key (back)']];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'config', 'set', 'execution.docker.imageId']),
    JSON.stringify(steps.map(([wait, send]) => [wait, send])), String(rows), String(columns)],
  { cwd: project, env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CHILD_PATH: `${dirname(process.execPath)}:${bin}:/usr/bin:/bin` }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { marks?: number[]; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-4000)}`);
  const screens = result.marks!.map((mark, index) => ({ label: steps[index]![2], text: terminalBuffers(result.output.slice(0, mark).replace(/\r?\n/g, '\r\n'), columns, rows).text }));
  if (process.env['DECKENT_CONFIG_PARTIAL_SCREENS']) {
    await writeFile(`${process.env['DECKENT_CONFIG_PARTIAL_SCREENS']}-${slow ? 'slow' : 'complete'}-${rows}x${columns}.txt`, screens.map(screen => `===== ${screen.label}\n${screen.text}`).join('\n'));
  }
  return screens;
}
const count = (text: string, part: string) => text.split(part).length - 1;

// 24×80: the notice wraps to two rows and still shows, first, in the key's focus area (which does not scroll while the list has the keys).
it('a deadline-cut image list says it is partial once, on the key and on its values, and still offers the images found (PTY 24×80, built binary)', async () => {
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  const [, key, values, back] = await run(true, 24, 80);
  for (const screen of [key!, values!, back!]) {
    const where = `${screen.label}\n${screen.text}`, joined = screen.text.split('\n').map(line => line.replace(/^│ ?| *│$/gu, '').trimEnd()).join(' ');
    expect(count(joined, 'Showing the 3 found before the time limit; set another with config set execution.docker.imageId <json>.'), where).toBe(1);
    expect(joined.indexOf('Showing the 3'), where).toBeLessThan(joined.indexOf('Pinned Docker'));
  }
  expect(count(values!.text, 'Docker · '), values!.text).toBe(3); expect(values!.text).toContain(`Docker · ${ids[0]!.slice(7, 19)}`);
}, 150_000);

it('a complete image list says nothing about a time limit (PTY, built binary)', async () => {
  await access(cli).catch(() => { throw new Error(`BUILD_REQUIRED: ${cli}`); });
  const [, key, values] = await run(false, 24, 80);
  for (const screen of [key!, values!]) expect(screen.text, screen.text).not.toContain('time limit');
  expect(values!.text).toContain('of 12'); // all twelve offered (the body pages them)
}, 150_000);
