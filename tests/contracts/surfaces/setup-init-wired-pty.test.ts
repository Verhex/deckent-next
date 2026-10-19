import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * I-S3 on a real pseudo-terminal: `deckent init` sets an installation up stage by stage through each stage's existing owner (the compiled
 * CLI), resumes by observing again, and hands the terminal to a stage whose owner takes it (I-D2's Docker install: the window closes, sudo
 * asks on the plain terminal, the window reopens on a fresh observation). The Docker case runs the production window and composition
 * through tests/fixtures/setup-init-handoff-driver.mjs with a FAKE sudo that only records; Docker is never installed and the real sudo
 * never runs. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const driver = resolve('tests/fixtures/setup-init-handoff-driver.mjs');
const PASSWORD = 'Pty-Pw-I-S3';
// The PTY helper is found on the runner's PATH: a case may give the CLI a PATH without it (no docker anywhere on it).
const python = (process.env['PATH'] ?? '').split(':').map(dir => join(dir, 'python3')).find(path => existsSync(path)) ?? 'python3';
const ROWS = 50, COLUMNS = 110;
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
deadline = time.time() + 90
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
type Steps = ReadonlyArray<readonly [string, string]>;
type Run = { status?: number | string; output: string; timeout?: string };

async function fixture(name = 'erp-demo') {
  const base = await mkdtemp(join(tmpdir(), 'deckent-i-s3-pty-')); roots.push(base);
  const root = join(base, name), home = join(base, 'home'), work = join(base, 'work');
  for (const dir of [root, home, join(work, 'bin')]) await mkdir(dir, { recursive: true });
  // A person's terminal: no AI-agent or CI marker (the runner may itself run inside one), English, a real terminal type, no Deckent variables.
  const env: NodeJS.ProcessEnv = { PATH: `${resolve(process.execPath, '..')}:/usr/local/bin:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
  const transcript = async (label: string, run: Run) => { const dir = process.env['DECKENT_I_S3_TRANSCRIPTS']; if (dir) await writeFile(join(dir, `pty-${label}.txt`), run.output); };
  const pty = async (label: string, argv: readonly string[], steps: Steps, extra: NodeJS.ProcessEnv = {}): Promise<Run> => {
    const { stdout } = await execute(python, ['-c', PTY, JSON.stringify(steps), JSON.stringify(argv), root], { env: { ...env, ...extra }, timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const run = JSON.parse(stdout) as Run;
    await transcript(label, run);
    return run;
  };
  const deckent = (args: readonly string[]) => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...env, TERM: 'dumb' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    .then(result => ({ code: 0, ...result }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  const plan = async (args: readonly string[] = []) => {
    const result = await deckent(['init', '--json', ...args]);
    const at = result.stdout.indexOf('{"schemaVersion":1,"planSchemaVersion"');
    const doc = JSON.parse(result.stdout.slice(at, result.stdout.indexOf('\n', at) < 0 ? undefined : result.stdout.indexOf('\n', at))) as { stages: { id: string; state: string; reason: { code: string } }[] };
    return Object.fromEntries(doc.stages.map(stage => [stage.id, `${stage.state}:${stage.reason.code}`]));
  };
  return { base, root, home, work, env, pty, deckent, plan };
}
const screen = (output: string) => terminalBuffers(output, COLUMNS, ROWS).text;

describe.skipIf(process.platform !== 'linux')('I-S3 deckent init on a real PTY (compiled CLI)', () => {
  it('sets up an empty folder stage by stage through each owner; the final check runs the human doctor between windows; a re-run reads done', async () => {
    await access(cli);
    const f = await fixture();
    const run = await f.pty('full-init', [process.execPath, cli, 'init'], [['Enter confirm', '1\r'], ['> 3. Folder', '1\r'], ['> 5. Who uses', '1\r'], ['> 6. Permissions', '1\r'],
      ['Apply now', '1\r'], ['> 2. Language', '1\r'], ['> 9. Model connection', '2\r'], ['> 11. Project instructions', '2\r'], ['> 12. Final check', '1\r'], ['Enter confirm', '1\r']]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.status, run.output.slice(-2000)).toBe(0);
    // The human doctor ran on the plain terminal between two windows (its summary line, then the window again).
    const doctor = run.output.indexOf('Status: ');
    expect(doctor).toBeGreaterThan(0);
    expect(run.output.indexOf('Deckent setup', doctor)).toBeGreaterThan(doctor);
    const summary = screen(run.output);
    for (const line of ['2. Language · done', '6. Permissions · done', '3. Folder and scope · done · This folder already uses the scope "erp-demo"', '11. Project instructions · skipped'])
      expect(summary).toContain(line);
    expect(summary).toContain('core:policy: applied'); expect(summary).toContain('core:language: applied'); expect(summary).toContain('core:final-check: applied');
    // No hand-written JSON: the folder holds the installation the owners wrote; nothing else (no DECKENT.md: the bridges were declined).
    expect((await readdir(f.root)).sort()).toEqual(['.deckent']);
    // Done stages are detected again on the next run, not remembered.
    const again = await f.plan();
    expect(again).toMatchObject({ 'core:language': 'done:setup.reason.languageConfigured', 'core:folder': 'done:setup.reason.scopeConfigured', 'core:policy': 'done:setup.reason.policyCurrent' });
    expect((await f.deckent(['doctor'])).code).toBe(0);
  }, 240_000);

  it('interrupted after the permissions (Esc): the next run shows them done and asks the rest again', async () => {
    await access(cli);
    const f = await fixture();
    const run = await f.pty('interrupt', [process.execPath, cli, 'init'], [['Enter confirm', '1\r'], ['> 3. Folder', '1\r'], ['> 5. Who uses', '1\r'], ['> 6. Permissions', '1\r'],
      ['Apply now', '1\r'], ['Permissions: applied', '\u001b']]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.status).toBe(0);
    const again = await f.plan();
    expect(again).toMatchObject({ 'core:policy': 'done:setup.reason.policyCurrent', 'core:folder': 'done:setup.reason.scopeConfigured',
      'core:language': 'needs-answer:setup.reason.languageDetected' });
  }, 240_000);

  it('a crash in the middle of the permissions: the next run shows an unknown result to complete (never by --yes); the window completes it', async () => {
    await access(cli);
    const f = await fixture('erp');
    // The ledger's folder refuses writes: the journal and the first two documents land, then the install stops (as a crash would).
    const state = join(f.root, '.deckent', 'state');
    await mkdir(state, { recursive: true }); await chmod(state, 0o555);
    const crashed = await f.deckent(['init', '--yes', '--scope', 'erp', '--json']);
    await chmod(state, 0o755);
    expect(crashed.code).not.toBe(0);
    expect(crashed.stderr).toContain('core:policy');
    expect(await readFile(join(f.root, '.deckent', 'installation', 'journal.json'), 'utf8')).toContain('pending');
    expect(await f.plan(['--scope', 'erp'])).toMatchObject({ 'core:policy': 'needs-answer:setup.reason.policyPending' });
    // `--yes` never resumes a pending install (INIT-D5): the policy stays pending.
    await f.deckent(['init', '--yes', '--scope', 'erp', '--json']);
    expect(await f.plan(['--scope', 'erp'])).toMatchObject({ 'core:policy': 'needs-answer:setup.reason.policyPending' });
    const run = await f.pty('resume-pending', [process.execPath, cli, 'init'], [['Enter confirm', '1\r'], ['> 3. Folder', '1\r'], ['> 5. Who uses', '1\r'],
      ['> 6. Permissions', '1\r'], ['Apply now', '1\r'], ['Permissions: applied', '\u001b']]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(await f.plan()).toMatchObject({ 'core:policy': 'done:setup.reason.policyCurrent', 'core:folder': 'done:setup.reason.scopeConfigured' });
    expect(await readFile(join(f.root, '.deckent', 'installation', 'journal.json'), 'utf8').catch(() => '')).not.toContain('"pending"');
  }, 240_000);

  it('a team profile is saved as the installation-wide selection (global layer, as `config set identity.profile --global`); doctor reads it', async () => {
    await access(cli);
    const f = await fixture();
    const run = await f.pty('team-profile', [process.execPath, cli, 'init'], [['Enter confirm', '1\r'], ['> 3. Folder', '1\r'], ['> 5. Who uses', '4\r'],
      ['> 6. Permissions', '1\r'], ['Apply now', '1\r'], ['> 2. Language', '1\r'], ['> 5. Who uses this installation · ready', '1\r'], ['Who uses this installation: applied', '\u001b']]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(screen(run.output)).toContain('core:profile: applied');
    expect(JSON.parse(await readFile(join(f.home, '.deckent', 'config.json'), 'utf8'))).toMatchObject({ identity: { profile: { id: 'core:team', version: 1 } } });
    expect((await f.deckent(['doctor'])).stdout).toMatch(/ok\s+Identity profile: core:team/u);
  }, 240_000);

  it('an older first-run policy: the window closes for the upgrade card (each added rule), the witnessed apply upgrades, the window reopens', async () => {
    await access(cli);
    const f = await fixture('erp');
    expect((await f.deckent(['init', '--yes', '--scope', 'erp'])).code).toBe(0);
    // The installation as v12 left it: the same first-run policy without the v13 rules.
    const path = join(f.root, '.deckent', 'policy.json'), current = JSON.parse(await readFile(path, 'utf8')) as { grants: { id: string }[] };
    const delta: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
    await writeFile(path, JSON.stringify({ ...current, revision: 'first-run-template-v12', grants: current.grants.filter(rule => !delta.includes(rule.id)) }), { mode: 0o600 });
    expect(await f.plan()).toMatchObject({ 'core:policy': 'needs-answer:setup.reason.policyUpgrade' });
    const run = await f.pty('policy-upgrade', [process.execPath, cli, 'init'], [['> 5. Who uses', '1\r'], ['> 6. Permissions', '1\r'], ['Apply now', '1\r'],
      ['Add these rules', 'y'], ['Permissions: applied', '\u001b']]);
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    const card = run.output.indexOf('Upgrade the permissions'), reopened = run.output.indexOf('Permissions: applied', card);
    expect(card).toBeGreaterThan(0); expect(reopened).toBeGreaterThan(card);
    for (const id of delta) expect(run.output.slice(card, reopened)).toContain(id);
    expect(await f.plan()).toMatchObject({ 'core:policy': 'done:setup.reason.policyCurrent' });
    const upgraded = JSON.parse(await readFile(path, 'utf8')) as { grants: { id: string }[] };
    expect(delta.every(id => upgraded.grants.some(rule => rule.id === id))).toBe(true);
  }, 240_000);

  it('Docker install stage: the window closes, sudo asks on the plain terminal (fake sudo), detection runs again, the window reopens', async () => {
    await access(driver);
    const f = await fixture('project');
    const sudo = join(f.work, 'fake-sudo'), work = f.work;
    await writeFile(join(work, 'docker.sock'), '');
    // The fake records argv and environment per call and asks at /dev/tty with echo off, like sudo; it keeps only the typed length. Its
    // `apt-get install` puts a fake `docker` on PATH (version/context/info answers), so the real detection then finds it.
    const docker = `#!/bin/bash\ncase "$1" in version) echo '{"Client":{"Version":"29.0.0"},"Server":{"Version":"29.0.0"}}';; context) echo '{"Host":"unix://${work}/docker.sock"}';; info) echo '{"OperatingSystem":"Ubuntu 24.04","SecurityOptions":[]}';; esac\n`;
    await writeFile(join(work, 'docker.fake'), docker);
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
if [ "$2" = apt-get ] && [ "$3" = install ]; then cp "$W/docker.fake" "$W/bin/docker"; chmod 755 "$W/bin/docker"; fi
printf 'fake-sudo ran: %s\\n' "\${*:2}"
`);
    await chmod(sudo, 0o755);
    // PATH without any docker; the caller's environment carries a secret that must never reach sudo.
    const run = await f.pty('docker-handoff', [process.execPath, driver, f.root, work, sudo], [['Enter confirm', '1\r'], ['Apply now', '1\r'], ['> 5. Who uses', '1\r'],
      ['> 8. Execution environment', '1\r'], ['Apply now', '1\r'], ['apt-get install -y docker-ce', 'y'], ['[fake-sudo] password for fake:', `${PASSWORD}\r`],
      ['> 9. Model connection', '\u001b']], { PATH: join(work, 'bin'), TMPDIR: work, DECKENT_SECRET_PASSPHRASE: 'must-not-reach-sudo' });
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.output).toContain('DRIVER-STATUS=closed');
    // Order on the terminal: the window offers the stage → the window closes → the card → sudo's own prompt → re-detection → the window again.
    const at = (text: string, from = 0) => run.output.indexOf(text, from);
    const offered = at('Install Docker Engine now?'), card = at('Install Docker Engine (administrator rights)', offered), prompt = at('[fake-sudo] password for fake:', card);
    const ready = at('Docker 29.0.0 is ready', prompt), reopened = at('Deckent setup', ready);
    expect([offered, card, prompt, ready, reopened].every(index => index > 0)).toBe(true);
    expect(offered < card && card < prompt && prompt < ready && ready < reopened).toBe(true);
    expect(screen(run.output.slice(0, at('\u001b[?2026l', reopened) + 8))).toContain('8. Execution environment · done');
    // sudo read the password from the terminal itself: the window had released it (the typed length arrived, nothing echoed).
    expect((await readFile(join(work, 'typed-length.log'), 'utf8')).trim()).toBe(String(PASSWORD.length));
    expect(run.output).not.toContain(PASSWORD);
    const argv = (await readFile(join(work, 'argv.log'), 'utf8')).split('\n').filter(Boolean);
    expect(argv[0]).toBe('-k');
    expect(argv.slice(1).map(line => line.split(' ').slice(0, 3).join(' '))).toEqual(['-- install -m', '-- install -m', '-- install -m', '-- apt-get update', '-- apt-get install', '-- usermod -aG']);
    for (const file of (await readdir(work)).filter(name => name.startsWith('env-'))) {
      const names = (await readFile(join(work, file), 'utf8')).split('\n').filter(Boolean).map(line => line.slice(0, line.indexOf('=')));
      expect(names.filter(name => !['PWD', 'SHLVL', '_'].includes(name)).sort(), file).toEqual(['LANG', 'PATH', 'TERM']);
    }
  }, 240_000);
});
