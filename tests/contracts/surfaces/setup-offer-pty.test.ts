import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { clearConfigCache } from '#platform/index.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * I-S5 (owner D8) on a real pseudo-terminal through the production entry (compiled CLI): bare `deckent` in a folder with no installation asks
 * a person "There is no Deckent installation here. Start setup?". Yes opens the same guided `deckent init` window; closing it with no scope
 * gives the human answer naming `deckent init`; a scope set in the window continues into the terminal. No or Esc writes nothing (folder and
 * HOME stay empty) and exits 2 as before. An AI agent, CI, a dumb terminal or a pipe never sees the card and keeps today's answer; an
 * installation with no scope keeps TERMINAL_SCOPE_REQUIRED. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const python = (process.env['PATH'] ?? '').split(':').map(dir => join(dir, 'python3')).find(path => existsSync(path)) ?? 'python3';
const ROWS = 40, COLUMNS = 110;
const CARD = 'There is no Deckent installation here. Start setup?';
const MISSING = 'No Deckent installation in this folder. Run `deckent init` to set it up. [CLI_INSTALLATION_MISSING]';
const SCOPE_REQUIRED = 'Select a scope: run `deckent init policy --scope <id> --apply`, then `deckent --scope <id>`. [TERMINAL_SCOPE_REQUIRED]';
/** Waits for each `[text, keys]` step's text in the output since the previous step, then types the keys one by one (never a burst). */
const PTY = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
steps, argv, cwd = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ${ROWS}, ${COLUMNS}, 0, 0))
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
since = 0
for wait, send in steps:
    deadline = time.time() + 60
    while wait.encode() not in out[since:]:
        alive = read_for(0.1)
        if wait.encode() in out[since:]: break
        if time.time() > deadline or not alive:
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.5)
    since = len(out)
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.12)
deadline = time.time() + 60
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
const roots: string[] = [];
const services: { pid: number; root: string }[] = [];
const running = (pid: number) => readFile(`/proc/${pid}/cmdline`, 'utf8').then(() => true, () => false);
// A runtime service the terminal started, identified by its own printed pid and this case's root only. It may still be writing its
// state after an accepted shutdown, so the caller removes the root only when this answers 'absent'.
async function stopOwnService(pid: number, root: string, waitMs = 10_000, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill) {
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  if (!command.includes('runtime') || !(await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')).includes(root)) return 'absent';
  try { kill(pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent';
    throw error;
  }
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    if (!await running(pid)) return 'absent';
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return await running(pid) ? 'alive' : 'absent';
}
afterEach(async () => {
  clearConfigCache();
  const kept: string[] = [];
  for (const { pid, root } of services.splice(0)) if (await stopOwnService(pid, root) === 'alive') kept.push(root);
  const removable = roots.splice(0).filter(root => !kept.some(home => home === root || home.startsWith(`${root}/`)));
  await Promise.all(removable.map(root => rm(root, { recursive: true, force: true })));
  if (kept.length) throw new Error(`Runtime service still running after shutdown; root kept: ${kept.join(', ')}`);
});

describe('stopOwnService', () => {
  it('treats a service that exits between the identity read and SIGTERM as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-i-s5-stop-')); roots.push(root);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'runtime'], { env: { ...process.env, I_S5_ROOT: root } });
    await new Promise(resolve => child.once('spawn', resolve));
    const gone = (pid: number) => { process.kill(pid, 'SIGKILL'); throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
    await expect(stopOwnService(child.pid!, root, 1000, gone)).resolves.toBe('absent');
  });

  it('reports a service still alive at the deadline so its root is kept', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-i-s5-stop-')); roots.push(root);
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', 'runtime'],
      { env: { ...process.env, I_S5_ROOT: root } });
    await new Promise(resolve => setTimeout(resolve, 300));
    try { await expect(stopOwnService(child.pid!, root, 300)).resolves.toBe('alive'); }
    finally { child.kill('SIGKILL'); }
  });
});
type Steps = ReadonlyArray<readonly [string, string]>;
type Run = { status?: number | string; output: string; timeout?: string };

async function fixture(repository = false) {
  const base = await mkdtemp(join(tmpdir(), 'deckent-i-s5-pty-')); roots.push(base);
  const root = join(base, 'erp-demo'), home = join(base, 'home'), bin = join(base, 'bin');
  for (const dir of [root, home, bin]) await mkdir(dir, { recursive: true });
  // Only this node, never its install directory: coding CLIs installed globally there (claude, codex) are host state that adds the work-kind screen.
  await symlink(process.execPath, join(bin, 'node'));
  // A person's terminal: no AI-agent or CI marker (the runner may itself run inside one), a real terminal type, no Deckent variables.
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  // U7 recommends the nearest Git top: keep positive setup cases inside their own repository, never an ambient parent (such as /tmp).
  if (repository) await execute('git', ['init', '--quiet', root], { env, timeout: 10_000 });
  const pty = async (label: string, steps: Steps, extra: NodeJS.ProcessEnv = {}, argv: readonly string[] = []): Promise<Run> => {
    const { stdout } = await execute(python, ['-c', PTY, JSON.stringify(steps), JSON.stringify([process.execPath, cli, ...argv]), root], { env: { ...env, ...extra },
      timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const run = JSON.parse(stdout) as Run;
    const dir = process.env['DECKENT_I_S5_TRANSCRIPTS'];
    if (dir) {
      await writeFile(join(dir, `pty-${label}.raw.txt`), run.output);
      let rendered: string; try { rendered = terminalBuffers(run.output, COLUMNS, ROWS).main; } catch (error) { rendered = `(not rendered: ${String(error)})`; }
      await writeFile(join(dir, `pty-${label}.rendered.txt`), `exit: ${String(run.status)}\n${rendered}`);
    }
    return run;
  };
  const deckent = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...env, TERM: 'dumb', ...extra },
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    .then(result => ({ code: 0, ...result }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  const empty = async () => ({ root: await readdir(root), home: await readdir(home) });
  return { root, home, env, pty, deckent, empty };
}

describe.skipIf(process.platform !== 'linux')('I-S5 bare `deckent` in a folder with no installation (real PTY, compiled CLI)', () => {
  it.each([
    { label: 'no', key: 'n', lang: 'en_US.UTF-8', card: CARD, missing: MISSING },
    { label: 'esc', key: '\u001b', lang: 'en_US.UTF-8', card: CARD, missing: MISSING },
    { label: 'no-tr', key: 'n', lang: 'tr_TR.UTF-8', card: 'Burada Deckent kurulumu yok. Kuruluma başla?',
      missing: 'Bu klasörde Deckent kurulumu yok. Kurmak için `deckent init` çalıştırın. [CLI_INSTALLATION_MISSING]' },
  ])('NEGATIVE: the card, then $label: nothing is written in the folder or HOME, the human answer names `deckent init`, exit 2 as before', async ({ label, key, lang, card, missing }) => {
    await access(cli);
    const f = await fixture();
    const run = await f.pty(`card-${label}`, [[card, key]], { LANG: lang });
    expect(run.timeout, run.output.slice(-2000)).toBeUndefined();
    expect(run.output).toContain(card);
    expect(run.output).toContain(missing);
    expect(run.output).not.toMatch(/init policy|TERMINAL_SCOPE_REQUIRED|Deckent setup|Deckent kurulumu plan/u);
    expect(run.status, run.output.slice(-2000)).toBe(2);
    expect(await f.empty()).toEqual({ root: [], home: [] });
  }, 120_000);

  it('Yes opens the guided setup window (its first question, the language); closing it with no scope gives the same human answer, exit 2', async () => {
    await access(cli);
    const f = await fixture(true);
    const run = await f.pty('yes-close', [[CARD, 'y'], ['Continue in English?', '\u001b']]);
    expect(run.timeout, run.output.slice(-2000)).toBeUndefined();
    expect(run.output).toContain(`Folder: ${f.root}`);
    // One Ink owner at a time: the card closed before the setup window drew its title.
    expect(run.output.indexOf('Deckent setup')).toBeGreaterThan(run.output.indexOf(CARD));
    expect(run.output).toContain('Nothing was applied.');
    expect(run.output.indexOf(MISSING)).toBeGreaterThan(run.output.indexOf('Nothing was applied.'));
    expect(run.output).not.toContain('TERMINAL_SCOPE_REQUIRED');
    expect(run.status, run.output.slice(-2000)).toBe(2);
    // The window applied nothing: no installation in the folder (I-S3: its observation may create HOME's instruction-trust directory only).
    expect(await readdir(f.root)).toEqual(['.git']);
  }, 180_000);

  it('Yes, then the minimal setup (language, folder, solo, permissions applied, Esc): the terminal opens on the new scope; /exit leaves with 0', async () => {
    await access(cli);
    const f = await fixture(true);
    const run = await f.pty('yes-setup-terminal', [[CARD, 'y'], ['Continue in English?', '1\r'], ['> 3. Folder', '1\r'], ['> 5. Who uses', '1\r'],
      ['> 6. Permissions', '1\r'], ['Apply now', '1\r'], ['Permissions: applied', '\u001b'],
      // U4: a first launch opens the sequential onboarding before the Workline; Esc ("Later") defers each screen. U4E G2: the window closed before
      // the profile was saved, so the pending permission screen comes first (permissions, model, first commit, instructions, then Ready!); with no
      // coding CLI on PATH the folder is not a coding folder, so no work-kind screen.
      // BeUser ZEY-02: the person's management rights follow the permission screen (Esc = later).
      ['Step 1/', '\u001b'], ['Step 2/', '\u001b'], ['Step 3/', '\u001b'], ['Step 4/', '\u001b'], ['Step 5/', '\u001b'], ['Ready!', '\u001b'], ['Deckent workline', '/exit\r']]);
    const pid = /Runtime service started in the background \(pid (\d+)/u.exec(run.output)?.[1];
    if (pid) services.push({ pid: Number(pid), root: f.home });
    expect(run.timeout, run.output.slice(-3000)).toBeUndefined();
    expect(run.output).toContain(`Folder: ${f.root}`);
    expect(run.status, run.output.slice(-3000)).toBe(0);
    // The setup summary (the same flow as `deckent init`), then the terminal on the scope the window wrote; no card again, no error.
    expect(run.output).toContain('Permissions: applied');
    expect(run.output).toContain('Authority pending. Open deckent terminal'); expect(run.output.indexOf('Permission settings')).toBeGreaterThan(run.output.indexOf('Step 1/'));
    expect(run.output.indexOf('Deckent workline')).toBeGreaterThan(run.output.indexOf('Permissions: applied'));
    expect(run.output.indexOf('Step 1/')).toBeGreaterThan(run.output.indexOf('Permissions: applied'));
    expect(run.output.indexOf('Deckent workline')).toBeGreaterThan(run.output.indexOf('Ready!'));
    expect(run.output.slice(run.output.indexOf('Permissions: applied'))).not.toContain(CARD);
    expect(run.output).not.toMatch(/CLI_INSTALLATION_MISSING|TERMINAL_SCOPE_REQUIRED/u);
    expect((await readdir(f.root)).sort()).toEqual(['.deckent', '.git']);
    expect(JSON.parse(await readFile(join(f.root, '.deckent/config.json'), 'utf8'))).toMatchObject({ terminal: { scopeId: 'erp-demo' } });
    // The service the terminal started (owner 2026-09-23) is stopped through the product command, with its audited reason.
    if (pid) {
      const stop = await f.deckent(['runtime', 'shutdown', '--reason', 'I-S5 test cleanup']);
      expect(stop.stdout + stop.stderr).toContain('shutdown accepted');
    }
  }, 240_000);

  it.each([
    { label: 'agent', extra: { CLAUDECODE: '1' } },
    { label: 'ci', extra: { CI: '1' } },
  ])('NEGATIVE: $label on a real terminal never sees the card: TERMINAL_SCOPE_REQUIRED unchanged, exit 2, nothing written', async ({ label, extra }) => {
    await access(cli);
    const f = await fixture();
    const run = await f.pty(`negative-${label}`, [], extra);
    expect(run.output).not.toContain(CARD);
    expect(run.output).toContain(SCOPE_REQUIRED);
    expect(run.status, run.output).toBe(2);
    expect(await f.empty()).toEqual({ root: [], home: [] });
  }, 120_000);

  it('NEGATIVE: a dumb terminal and a pipe never see the card: bare `deckent` prints the help as before (exit 0), nothing written', async () => {
    await access(cli);
    const f = await fixture();
    const dumb = await f.pty('negative-dumb', [], { TERM: 'dumb' });
    expect(dumb.output).not.toContain(CARD);
    expect(dumb.output).toContain('Exit codes:');
    expect(dumb.status, dumb.output).toBe(0);
    const piped = await f.deckent([], { TERM: 'xterm-256color' });
    expect(piped.stdout + piped.stderr).not.toContain(CARD);
    expect(piped.stdout).toContain('Exit codes:');
    expect(piped.code).toBe(0);
    // The terminal itself from a pipe keeps its typed answer (no card): `deckent terminal session` with no scope.
    const session = await f.deckent(['terminal', 'session'], { TERM: 'xterm-256color' });
    expect(session.stdout + session.stderr).not.toContain(CARD);
    expect(session.stderr).toContain('[TERMINAL_SCOPE_REQUIRED]');
    expect(session.code).toBe(2);
    expect(await f.empty()).toEqual({ root: [], home: [] });
  }, 120_000);

  it('NEGATIVE: an installation with no scope chosen is not "no installation": no card, TERMINAL_SCOPE_REQUIRED unchanged', async () => {
    await access(cli);
    const f = await fixture();
    await applyPolicyTemplateInstallation(f.root, 'installation');
    const file = join(f.root, '.deckent/config.json'), config = JSON.parse(await readFile(file, 'utf8')) as { terminal?: Record<string, unknown> };
    delete config.terminal?.['scopeId']; await writeFile(file, JSON.stringify(config)); clearConfigCache();
    const run = await f.pty('negative-installation-no-scope', []);
    expect(run.output).not.toContain(CARD);
    expect(run.output).toContain(SCOPE_REQUIRED);
    expect(run.status, run.output).toBe(2);
  }, 120_000);
});
