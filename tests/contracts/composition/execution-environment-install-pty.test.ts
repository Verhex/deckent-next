import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteAuditStore } from '#adapters/index.js';
import { productResourcePath, resolveProductLayout } from '#platform/index.js';

/**
 * I-D2 on a real pseudo-terminal through the built flow (tests/fixtures/execution-install-driver.mjs): the real SEC-1 terminal witness, a real
 * throwaway installation with the fresh v13 policy, the real foreground spawn, and a FAKE sudo that only records its argv, its environment and
 * the length of what was typed at its own prompt. Docker is never installed; the real sudo is never run. Requires `npm run build`.
 */
const execute = promisify(execFile);
const driver = resolve('tests/fixtures/execution-install-driver.mjs');
const PASSWORD = 'S3cret-PTY-pw-I-D2';
const PTY = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
steps, argv = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 220, 0, 0))
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
    deadline = time.time() + 40
    while wait.encode() not in out[since:]:
        alive = read_for(0.1)
        if wait.encode() in out[since:]: break
        if time.time() > deadline or not alive:
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.4)
    since = len(out)
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.1)
deadline = time.time() + 40
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
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-i-d2-pty-')); roots.push(base);
  const root = join(base, 'project'), work = join(base, 'work'), home = join(base, 'home'), sudo = join(work, 'fake-sudo');
  for (const dir of [root, work, home]) await mkdir(dir, { recursive: true });
  // The fake records argv and environment per call and asks at /dev/tty with echo off, like sudo; it keeps only the typed length.
  await writeFile(sudo, `#!/bin/bash
W='${work}'
printf '%s\\n' "$*" >> "$W/argv.log"
env | sort > "$W/env-$(date +%s%N).log"
case "$1" in -k) rm -f "$W/STAMP"; exit 0;; -n) exit 1;; esac
if [ ! -f "$W/STAMP" ]; then
  printf '[fake-sudo] password for fake: ' > /dev/tty
  IFS= read -rs pw < /dev/tty
  printf '\\n' > /dev/tty
  printf '%s\\n' "\${#pw}" >> "$W/typed-length.log"
  pw=''
  touch "$W/STAMP"
fi
if [ "$2" = apt-get ] && [ "$3" = install ]; then touch "$W/INSTALLED"; fi
printf 'fake-sudo ran: %s\\n' "\${*:2}"
`);
  await chmod(sudo, 0o755);
  // A person's terminal: no AI-agent or CI marker (the test runner may itself run inside one), a real terminal type, no Deckent variables.
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1',
    DECKENT_GLOBAL_HOME: join(home, '.deckent-global'), DECKENT_SECRET_PASSPHRASE: 'must-not-reach-sudo', TMPDIR: work };
  const run = async (name: string, steps: ReadonlyArray<readonly [string, string]>, locale = 'en', extra: Record<string, string> = {}) => {
    const { stdout } = await execute('python3', ['-c', PTY, JSON.stringify(steps), JSON.stringify([process.execPath, driver, root, work, sudo, locale])],
      { cwd: root, env: { ...env, ...extra }, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const result = JSON.parse(stdout) as { status?: number | string; output: string; timeout?: string };
    const transcripts = process.env['DECKENT_I_D2_TRANSCRIPTS'];
    if (transcripts) await writeFile(join(transcripts, `pty-${name}-${locale}.txt`), result.output);
    return result;
  };
  const argv = async () => (await readFile(join(work, 'argv.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const audit = async () => {
    const store = await openSqliteAuditStore(productResourcePath(resolveProductLayout({ projectRoot: root }), 'ledger'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' });
    try { return store.page('installation', 0, 500).map(record => record.event.subject).filter(subject => subject.kind === 'execution-environment-install'); } finally { store.close(); }
  };
  const everyFile = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? everyFile(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)])))).flat();
  return { base, root, work, env, run, argv, audit, everyFile };
}

describe.skipIf(process.platform !== 'linux')('I-D2: the Docker install card on a real PTY (fake sudo)', () => {
  it('drives the card to the confirm step and stops (TR): every command shown, nothing privileged ran, nothing audited as started', async () => {
    await access(resolve('dist/composition/core/setup/index.js'));
    const f = await fixture();
    const run = await f.run('confirm-stop', [['apt-get install -y docker-ce', 'n']], 'tr');
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.output).toContain('Docker Engine kurulumu');
    for (const text of ['sudo install -m 0755 -d /etc/apt/keyrings', 'sudo apt-get update', 'sudo usermod -aG docker fake', '9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88',
      'root yetkisine eşittir', 'Deckent onu hiç görmez']) expect(run.output, text).toContain(text);
    expect(run.output).toContain('DRIVER-STATUS=declined');
    // Only the NOPASSWD probe ran before the card (`-k`, then `-n -v`: never prompts, runs no command); no step, no prompt.
    expect(await f.argv()).toEqual(['-k', '-n -v']);
    expect(run.output).not.toContain('[fake-sudo] password');
    expect(await f.audit()).toEqual([]);
  }, 160_000);

  it('approved: sudo -k, then every step in the foreground; sudo asks on the terminal itself; the password reaches no argv, env, file, audit or output', async () => {
    const f = await fixture();
    const run = await f.run('approved-fake-sudo', [['apt-get install -y docker-ce', 'y'], ['[fake-sudo] password for fake:', `${PASSWORD}\r`]]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.output).toContain('DRIVER-STATUS=succeeded');
    expect(run.output).toContain('Docker 5:29.0.0-1~ubuntu.24.04~noble is installed.');
    expect(run.output).toContain('Docker 29.0.0 is ready');
    const argv = await f.argv();
    expect(argv.slice(0, 3)).toEqual(['-k', '-n -v', '-k']);
    expect(argv.slice(3)).toEqual([expect.stringMatching(/^-- install -m 0755 -d \/etc\/apt\/keyrings$/u), expect.stringMatching(/^-- install -m 0644 \/.+\/docker\.asc \/etc\/apt\/keyrings\/docker\.asc$/u),
      expect.stringMatching(/^-- install -m 0644 \/.+\/docker\.sources \/etc\/apt\/sources\.list\.d\/docker\.sources$/u), '-- apt-get update',
      '-- apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', '-- usermod -aG docker fake']);
    expect((await readFile(join(f.work, 'typed-length.log'), 'utf8')).trim()).toBe(String(PASSWORD.length));
    // The environment every sudo call got: the fixed PATH, terminal type and language (bash adds PWD, SHLVL and _ itself).
    for (const file of (await readdir(f.work)).filter(name => name.startsWith('env-'))) {
      const names = (await readFile(join(f.work, file), 'utf8')).split('\n').filter(Boolean).map(line => line.slice(0, line.indexOf('=')));
      expect(names.filter(name => !['PWD', 'SHLVL', '_'].includes(name)).sort(), file).toEqual(['LANG', 'PATH', 'TERM']);
    }
    for (const file of await f.everyFile(f.base)) expect((await readFile(file)).includes(PASSWORD), file).toBe(false);
    expect(run.output).not.toContain(PASSWORD);
    expect(run.output).not.toContain('must-not-reach-sudo');
    const audit = await f.audit();
    expect(audit.map(subject => subject.phase)).toEqual(['intent', 'succeeded']);
    expect(audit[1]).toMatchObject({ environment: 'docker', version: '5:29.0.0-1~ubuntu.24.04~noble', exitCode: 0,
      source: { distribution: 'ubuntu', codename: 'noble', fingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' }, decision: { effect: 'allow', ruleId: 'first-run-execution-environment-install' } });
  }, 160_000);

  it('an AI agent on a real terminal and a pipe are refused before anything is detected or run', async () => {
    const f = await fixture();
    const agent = await f.run('agent-refused', [], 'en', { CLAUDECODE: '1' });
    expect(agent.output).toContain('DRIVER-ERROR=TERMINAL_TTY_REQUIRED');
    const { stdout } = await execute(process.execPath, [driver, f.root, f.work, join(f.work, 'fake-sudo'), 'en'], { env: f.env, timeout: 60_000 });
    expect(stdout).toContain('DRIVER-ERROR=TERMINAL_TTY_REQUIRED');
    expect(await f.argv()).toEqual([]);
    expect(await f.audit()).toEqual([]);
  }, 160_000);
});
