import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';
/** Lead-only: requires a fresh dist binary. No author-lane build/PTY execution. No model or external command is admitted. */
const execute = promisify(execFile), roots: string[] = [], cli = resolve('dist/composition/core/cli/internal/entry.js');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps, cwd = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 80, 0, 0))
out = b''
def read_once():
    global out
    if select.select([fd], [], [], .05)[0]:
        try: data = os.read(fd, 65536)
        except OSError: return False
        if not data: return False
        out += data
    return True
since = 0
for wanted, key in steps:
    end = time.monotonic() + 30
    while wanted.encode() not in out[since:]:
        if time.monotonic() > end or not read_once():
            os.kill(pid, 9); raise RuntimeError('missing: '+wanted+'\n'+out.decode('utf8','replace'))
    while termios.tcgetattr(fd)[3] & termios.ICANON:
        if time.monotonic() > end: os.kill(pid,9); raise RuntimeError('not raw')
        read_once()
    time.sleep(.15); since=len(out); os.write(fd,key.encode())
end=time.monotonic()+30
while time.monotonic()<end:
    read_once()
    ended,status=os.waitpid(pid,os.WNOHANG)
    if ended:
        print(json.dumps({'code':os.waitstatus_to_exitcode(status),'output':out.decode('utf8','replace')})); sys.exit(0)
os.kill(pid,9); raise RuntimeError('child did not exit')
`;
it.skipIf(process.platform !== 'linux').each(['tr', 'en'] as const)('U4-2 PTY %s: sequential screens precede Workline, Esc defers and /setup restores focus without policy/budget writes', async locale => {
  const base = await mkdtemp(join(tmpdir(), 'onboarding-pty-')); roots.push(base);
  const root = join(base, 'customer'), home = join(base, 'home'); await mkdir(root); await mkdir(home);
  const env = { PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: join(home, 'global'), TERM: 'xterm-256color', LANG: 'tr_TR.UTF-8', NO_COLOR: '1' };
  await applyPolicyTemplateInstallation(root, 's', { env });
  const configPath = join(root, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  config.language = locale; config.terminal = { ...config.terminal, scopeId: 's', autostartService: false, layout: 'inline', notify: 'off' };
  await writeFile(configPath, JSON.stringify(config)); const before = await readFile(configPath, 'utf8');
  const step = locale === 'tr' ? 'Adım 1/' : 'Step 1/', permission = locale === 'tr' ? 'İzin ayarları' : 'Permission settings', ready = locale === 'tr' ? 'Hazır!' : 'Ready!', hint = locale === 'tr' ? 'Enter gönder' : 'Enter send';
  // A fresh non-Git folder installed without a person (no saved profile, as after `init --yes`): U4E G2 puts the pending profile/permission
  // screen first, before the model step (Esc = later, nothing written), then model, project instructions (no DECKENT.md yet), then Ready.
  const instructions = locale === 'tr' ? 'Proje yönergeleri' : 'Project instructions', second = locale === 'tr' ? 'Adım 2/' : 'Step 2/';
  // Waits name the step counter: the Workline's deferred note also names the screen titles.
  const steps = [[step, '\u001b'], [second, '\u001b'], [instructions, '\u001b'], [ready, '\u001b'], [hint, '/setup\r'], [step, '\u001b'],
    [second, '\u001b'], [instructions, '\u001b'], [ready, '\u001b'], [hint, '/exit\r']];
  const result = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli]), JSON.stringify(steps), root], { env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const run = JSON.parse(result.stdout) as { code: number; output: string };
  expect(run.code).toBe(0); expect(run.output.indexOf(step)).toBeLessThan(run.output.indexOf(ready));
  expect(run.output.indexOf(step)).toBeLessThan(run.output.indexOf(permission)); expect(run.output.indexOf(permission)).toBeLessThan(run.output.indexOf(second));
  expect(run.output).not.toContain('^['); expect(await readFile(configPath, 'utf8')).toBe(before);
  const history = JSON.parse(await readFile(join(root, '.deckent/state/onboarding.json'), 'utf8'));
  expect(history.schemaVersion).toBe(2); expect(history.entries.every((row: { folder: string }) => row.folder === '')).toBe(true);
  // Screen buffers retain the actual layout for the lead's focus/footer review; no snapshot-only acceptance claim.
  expect(terminalBuffers(run.output, 80, 32)).toBeDefined();
}, 180_000);
it.skipIf(process.platform !== 'linux')('N1 PTY: keys typed in a /setup window opened from the Workline never reach the composer; Enter afterwards sends nothing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'onboarding-pty-')); roots.push(base);
  const root = join(base, 'customer'), home = join(base, 'home'); await mkdir(root); await mkdir(home);
  const env = { PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: join(home, 'global'), TERM: 'xterm-256color', LANG: 'en_US.UTF-8', NO_COLOR: '1' };
  await applyPolicyTemplateInstallation(root, 's', { env });
  const configPath = join(root, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  // Attention notices stay on (the default): the Workline then reads the TTY through the filtered input the leak went through.
  config.language = 'en'; config.terminal = { ...config.terminal, scopeId: 's', autostartService: false, layout: 'inline' };
  await writeFile(configPath, JSON.stringify(config));
  const steps = [['Step 1/', '\u001b'], ['Step 2/', '\u001b'], ['Project instructions', '\u001b'], ['Ready!', '\u001b'], ['Enter send', '/setup\r'],
    ['Step 1/', 'abc'], ['', '\u001b'], ['Step 2/', '\u001b'], ['Project instructions', '\u001b'], ['Ready!', '\u001b'], ['Enter send', '\r'], ['', '/exit\r']];
  const result = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli]), JSON.stringify(steps), root], { env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const run = JSON.parse(result.stdout) as { code: number; output: string };
  expect(run.code).toBe(0);
  // Everything after the reopened window closed is the Workline: the typed text is not in its composer and no turn was sent.
  expect(run.output.slice(run.output.lastIndexOf('Ready!'))).not.toContain('abc');
}, 180_000);
