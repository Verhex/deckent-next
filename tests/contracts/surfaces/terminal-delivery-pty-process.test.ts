import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateTask, inspectConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';

// TESLIM-PENCERESI at the real boundary: the built Workline on its own controlling PTY with the built delivery port over the real configured
// composition and real Git (Docker executes the coding attempt). Only the Run view that triggers the window is a fixture ledger port.
const execute = promisify(execFile);
const program = resolve('tests/fixtures/delivery-window-application.mjs');
const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** python3 `pty` driver: each step waits for a text in the output so far, then types its keys 10 ms apart; the view is stopped after the last step. */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
argv, steps, mode = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    if mode == 'piped-input': os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
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
    deadline = time.time() + 40
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            os.kill(pid, 9); os.waitpid(pid, 0)
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(0)
    read_for(0.4)
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.01)
status = None
deadline = time.time() + 2
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, signal.SIGTERM); time.sleep(0.3)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if not finished: os.kill(pid, 9); os.waitpid(pid, 0)
    status = 'stopped'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace')}))
`;
async function inPty(project: string, env: NodeJS.ProcessEnv, mode: string, steps: ReadonlyArray<readonly [string, string]>, stdin = 'tty') {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, program, mode]), JSON.stringify(steps), stdin],
    { cwd: project, env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-6000)}`);
  return result;
}
const CTRL_O = '\u000f', ESC = '\u001b';
const WINDOW = 'Delivery · Ship useful change', READY_HINT = 'y check, prepare and deliver';
/** /do admits the fixture Run; its result window is closed explicitly; the delivery window then appears by itself (composer keeps focus). */
const opening: ReadonlyArray<readonly [string, string]> = [['READY', '/do ship it\r'], ['PLAN-RESULT', CTRL_O], ['WINDOW-FOCUS', ESC]];

/** The fixture's grants plus `inspect` on the scope: the window resolves the newest attempt through the inventory, as `deckent task … --run --task` does. */
async function grant(f: Awaited<ReturnType<typeof readyDeliveryFixture>>, attempt: readonly string[]) {
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'delivery-window', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attempt, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
}
async function fixture(options: Parameters<typeof readyDeliveryFixture>[1] = {}) {
  const f = await readyDeliveryFixture(track, options);
  await grant(f, ['read-output', 'prepare-integration', 'deliver-integration']);
  const refs = async () => ({ refs: await f.git('for-each-ref', '--format=%(refname) %(objectname)'), objects: await f.git('count-objects', '-v') });
  const source = async () => ({ head: await f.git('rev-parse', 'HEAD'), index: (await readFile(join(f.project, '.git/index'))).toString('base64'),
    status: await f.git('--no-optional-locks', 'status', '--porcelain') });
  const deliveries = async () => (await f.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/deckent/deliveries/')).split('\n').filter(Boolean);
  return { ...f, refs, source, deliveries };
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('terminal delivery window — real controlling PTY, composition and Git', { timeout: 240_000 }, () => {
  it('appears by itself; Ctrl+O then y checks, prepares and delivers one dedicated ref; source HEAD, index and worktree unchanged', async () => {
    const f = await fixture(), before = await f.source();
    expect(await f.deliveries()).toEqual([]);
    const result = await inPty(f.project, f.options.env, 'window', [...opening, [READY_HINT, `${CTRL_O}y`], ['branches and working tree unchanged.', '']]);
    expect(result.output).toContain(WINDOW); expect(result.output).toContain('Integration check: affected files match base');
    expect(result.output).toContain('note.txt | +1 -1'); expect(result.output).toContain('Writes only a dedicated reference under refs/deckent/deliveries/');
    expect(result.output).not.toContain('y adopt into the selected branch'); // no execution.adoption.targets: no branch choice
    const [line] = await f.deliveries(); expect(line).toBeDefined();
    const [ref, commit] = line!.split(' ');
    expect(result.output).toContain(`Delivered: commit ${commit} → ${ref}`);
    expect(await f.git('rev-parse', `${commit}^`)).toBe(f.base);
    expect((await f.git('show', '--name-only', '--format=', commit!)).split('\n').sort()).toEqual(['added.txt', 'note.txt', 'removed.txt']);
    expect(await f.source()).toEqual(before);
  });

  it('n writes nothing: no candidate, no reference, no object', async () => {
    const f = await fixture(), before = await f.refs(), source = await f.source();
    const result = await inPty(f.project, f.options.env, 'window', [...opening, [READY_HINT, `${CTRL_O}n`], ['Delivery left waiting: Ship useful change', '']]);
    expect(result.output).toContain(WINDOW);
    expect(await f.refs()).toEqual(before); expect(await f.source()).toEqual(source);
  });

  it('a source changed after the patch is refused in human words with the next step; nothing is written', async () => {
    const f = await fixture();
    // The owner commits a change to an affected file after the patch was made: the base the patch was made on is no longer the source.
    await writeFile(join(f.project, 'note.txt'), 'changed by the owner\n'); await f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'moved base');
    const before = await f.refs();
    const result = await inPty(f.project, f.options.env, 'window', [...opening, [WINDOW, ''], ['Next: ', `${CTRL_O}y`], ['Enter/Esc close', '']]);
    expect(result.output).toMatch(/ERR PATCH_(?:BASE_ADVANCED|CONFLICT)/u);
    expect(await f.refs()).toEqual(before); expect(await f.deliveries()).toEqual([]);
  });

  it('with a configured target, adoption needs a second y: n keeps the branch, y moves it to the delivered commit', async () => {
    for (const answer of ['n', 'y'] as const) {
      const f = await fixture({ adoptionTargets: ['refs/heads/adopted'] });
      await f.git('branch', 'adopted', f.base);
      // The coding attempt is evaluated (accepted) first: adoption requires the accepted Task, as on the CLI.
      await grant(f, ['read-output', 'evaluate']);
      await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: (await f.runtime.store.loadRun('s', 'r'))!.revision }, f.options);
      await grant(f, ['read-output', 'prepare-integration', 'deliver-integration', 'adopt-integration']);
      const source = await f.source();
      const steps: Array<readonly [string, string]> = [...opening, [READY_HINT, `${CTRL_O}y`], ['y adopt into the selected branch', answer]];
      steps.push(answer === 'y' ? ['Adopted into refs/heads/adopted', ''] : ['Not adopted into a branch; the delivery stays at', '']);
      const result = await inPty(f.project, f.options.env, 'window', steps);
      expect(result.output).toContain('After delivery, adopting into a branch is a separate choice: refs/heads/adopted');
      const [line] = await f.deliveries(); const commit = line!.split(' ')[1]!;
      expect(await f.git('rev-parse', 'refs/heads/adopted')).toBe(answer === 'y' ? commit : f.base);
      if (answer === 'y') expect(result.output).toContain(`Adopted: refs/heads/adopted ${f.base} → ${commit}`);
      expect((await f.source()).head).toBe(source.head); expect((await f.source()).status).toBe(source.status);
      for (const close of track.cleanup.splice(0).reverse()) await close();
    }
  });

  it('a session that is not a verified terminal is refused before any candidate is prepared, even when the answer would be yes', async () => {
    const f = await fixture(), before = await f.refs();
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, program, 'port-direct']), JSON.stringify([['"response"', '']]), 'piped-input'],
      { cwd: f.project, env: { ...process.env, ...f.options.env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const output = (JSON.parse(stdout) as { output: string }).output, line = output.split(/\r?\n/u).find(value => value.startsWith('{"response"'));
    expect(JSON.parse(line!)).toEqual({ response: { ok: false, code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    expect(await f.refs()).toEqual(before);
    expect((await inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: f.identity, commandId: 'direct-candidate' }, f.options)).status).toBe('absent');
  });
});
