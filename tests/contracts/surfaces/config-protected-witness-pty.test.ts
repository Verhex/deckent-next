import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * alpha.55.1 hotfix on the built CLI: the person at a real pseudo-terminal (its controlling terminal on input and output, no AI marker) still
 * writes a protected switch with `deckent config set`; the same command on the same kind of terminal under an AI marker is refused with
 * AUTHORITY_WITNESS_REQUIRED and writes nothing (the marker, not only the terminal, decides). Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const python = (process.env['PATH'] ?? '').split(':').map(dir => join(dir, 'python3')).find(path => existsSync(path)) ?? 'python3';
// pty.fork makes the pseudo-terminal the child's controlling terminal (setsid + TIOCSCTTY), as a person's terminal is.
const PTY = String.raw`
import json, os, pty, select, sys, time
argv, cwd, env = json.loads(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)
out, status, deadline = b'', None, time.time() + 90
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try: chunk = os.read(fd, 65536)
        except OSError: chunk = b''
        out += chunk
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code); break
if status is None: os.kill(pid, 9); status = 'killed'
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('config set of a protected switch on a real terminal (built CLI)', () => {
  it('the person writes it; an AI marker on the same terminal is refused and nothing is written', async () => {
    const base = await mkdtemp(join(tmpdir(), 'deckent-config-witness-pty-')); roots.push(base);
    const root = join(base, 'erp-demo'), home = join(base, 'home');
    for (const dir of [root, home]) await mkdir(dir, { recursive: true });
    // A clean environment (the runner may itself run inside an AI agent or CI): no agent marker, English, no Deckent variables.
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
    const init = await execute(process.execPath, [cli, 'init', '--yes', '--scope', 'erp-demo'], { cwd: root, env: { ...env, TERM: 'dumb' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    expect(init.stderr).toBe('');
    const configPath = join(root, '.deckent', 'config.json'), before = await readFile(configPath, 'utf8');
    const onTerminal = async (extra: Record<string, string>) => JSON.parse((await execute(python, ['-c', PTY,
      JSON.stringify([process.execPath, cli, 'config', 'set', 'memoryAutomation.extraction.mode', '"shadow"', '--scope', 'erp-demo']), root, JSON.stringify({ ...env, ...extra })],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout) as { status: number | string; output: string };
    const ai = await onTerminal({ CLAUDECODE: '1' });
    expect(ai.status, ai.output).not.toBe(0); expect(ai.output).toContain('The setting memoryAutomation.extraction.mode is protected');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    const person = await onTerminal({});
    expect(person.status, person.output).toBe(0);
    expect((JSON.parse(await readFile(configPath, 'utf8')) as { memoryAutomation: { extraction: { mode: string } } }).memoryAutomation.extraction.mode).toBe('shadow');
  }, 240_000);
});
