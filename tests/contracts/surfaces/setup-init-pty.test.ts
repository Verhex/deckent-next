import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_ENVIRONMENT } from '#surfaces/core/cli-human/index.js';
import { personEnv } from '../support/person-env.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/**
 * I-S4 on a real pseudo-terminal through the production entry (compiled CLI): bare `deckent init` opens the guided window, answers move
 * from stage to stage, the window keeps one height (its bottom border row never moves), Esc closes it, and nothing is written to the
 * folder. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const ROWS = 40, COLUMNS = 100;
/** python3 `pty` driver: each step waits for its text in the output written after the previous step's keys, then sends its keys one per write. */
const DRIVER = String.raw`
import fcntl, hashlib, json, os, pty, select, struct, sys, termios, time
steps, argv, cwd = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
size = json.loads(sys.argv[4]) if len(sys.argv) > 4 else [${ROWS}, ${COLUMNS}]
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', size[0], size[1], 0, 0))
out = b''
snapshots = []
marks = []
def snapshot():
    result = {}
    root = os.path.join(cwd, '.deckent')
    for directory, dirs, files in os.walk(root):
        for name in dirs:
            result[os.path.relpath(os.path.join(directory, name), root) + '/'] = None
        for name in files:
            path = os.path.join(directory, name)
            with open(path, 'rb') as source:
                result[os.path.relpath(path, root)] = hashlib.sha256(source.read()).hexdigest()
    return result
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
for step in steps:
    wait, send = step[:2]
    deadline = time.time() + 25
    while wait.encode() not in out[since:]:
        alive = read_for(0.1)
        if wait.encode() in out[since:]: break
        if time.time() > deadline or not alive:
            os.kill(pid, 9); sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(step[2] if len(step) > 2 else 0.4)
    marks.append(len(out.decode('utf8', 'replace')))
    since = len(out)
    if send == 'SNAPSHOT':
        snapshots.append(snapshot())
    elif send.startswith('RESIZE:'):
        rows, columns = json.loads(send[7:])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(pid, 28)
    elif send.startswith('SIGNAL:'):
        os.kill(pid, int(send[7:]))
    elif send.startswith('RAW:'):
        os.write(fd, send[4:].encode())
    elif send.startswith('\x1b['):
        os.write(fd, send.encode()); time.sleep(0.15)
    else:
        for char in send:
            os.write(fd, char.encode()); time.sleep(0.15)
deadline = time.time() + 25
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'marks': marks, 'snapshots': snapshots}))
`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('bare deckent init on a real PTY (production entry)', () => {
  it('107/108: separate /task /policy keys then Enter leave the folder question open with an EN/TR hint; Enter again answers', async () => {
    await access(cli);
    for (const locale of ['en', 'tr'] as const) {
      const home = await mkdtemp(join(tmpdir(), 'deckent-init-consent-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-init-consent-root-'));
      roots.push(home, root);
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'erp-demo' }));
      const copy = locale === 'en' ? { keys: 'Enter confirm', folder: '> 3. Folder and scope', hint: 'Text typed here is not an answer.', unchosen: 'Nothing was chosen.', profile: '> 5. Who uses this installation', yes: 'Yes (y)' }
        : { keys: 'Enter onayla', folder: '> 3. Klasör ve kapsam', hint: 'Buraya yazılan metin bir cevap değildir.', unchosen: 'Hiçbir şey seçilmedi.', profile: '> 5. Kurulumu kim kullanacak', yes: 'Evet (y)' };
      // DRIVER writes each character separately, waits for armed hints and leaves 150 ms between stdin reads.
      // A fresh home opens on the language step: Enter accepts its recommended answer, then the folder question takes the typed text.
      const steps = [[copy.keys, '\r'], [copy.folder, '/task /policy'], [copy.hint, '\r'], [copy.unchosen, '\r'], [copy.profile, '\u001b']];
      const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
      const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify([process.execPath, cli, 'init', '--lang', locale]), root],
        { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
      const run = JSON.parse(stdout) as { status?: number | string; output: string; marks: number[]; timeout?: string };
      expect(run.timeout, run.output?.slice(-3000)).toBeUndefined(); expect(run.status, run.output?.slice(-2000)).toBe(0);
      const screen = (mark: number) => terminalBuffers(run.output.slice(0, run.marks[mark]!), COLUMNS, ROWS).text;
      expect(screen(1)).toContain(copy.folder); expect(screen(1)).toContain(copy.yes);
      expect(screen(2)).toContain(copy.folder); expect(screen(2)).toContain(copy.hint); expect(screen(2)).toContain(copy.yes);
      expect(screen(3)).toContain(copy.folder); expect(screen(3)).toContain(copy.unchosen); expect(screen(3)).toContain(copy.keys); expect(screen(3)).not.toContain(copy.hint);
      expect(screen(4)).toContain(copy.profile);
      expect(await readdir(root)).toEqual(['package.json']);
    }
  }, 240_000);

  it('guides stage by stage in one fixed-height window, closes on Esc and writes nothing', async () => {
    await access(cli);
    const home = await mkdtemp(join(tmpdir(), 'deckent-init-pty-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-init-pty-root-'));
    roots.push(home, root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'erp-demo' }));
    // A clean environment: no AI-agent or CI marker (the test runner may itself run inside one), English, a real terminal type.
    const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
    // Owner 2026-10-26: each step highlights its recommended answer (the detected English, the suggested scope), so Enter alone accepts it.
    const steps = [['Enter confirm', '\r'], ['> 3. Folder and scope', '\r'], ['> 5. Who uses', '\u001b']];
    const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify([process.execPath, cli, 'init']), root],
      { env: { ...env, PATH: process.env['PATH'] ?? '' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
    const run = JSON.parse(stdout) as { status?: number | string; output: string; marks: number[]; timeout?: string };
    expect(run.timeout, run.output?.slice(-3000)).toBeUndefined();
    expect(run.status, run.output.slice(-2000)).toBe(0);
    expect(run.output).not.toContain('^[[B');
    // Cut at the last complete frame (synchronized-output end) before the mark: a mark can fall inside a frame being written.
    const complete = (end: number) => { const at = run.output.lastIndexOf('\u001b[?2026l', end); return at < 0 ? end : at + '\u001b[?2026l'.length; };
    const screen = (mark: number) => terminalBuffers(run.output.slice(0, complete(run.marks[mark]!)), COLUMNS, ROWS).text.split('\n');
    const bottom = (rows: readonly string[]) => rows.findLastIndex(row => /^[╰+└]/u.test(row));
    const rows = [0, 1, 2].map(mark => bottom(screen(mark)));
    expect(screen(0).join('\n')).toMatch(/[›>] 1\. English/u);
    // I-S3: the detection families are registered (12 stages: Git repository after the folder, execution environment, sign-ins).
    // The language, folder and profile steps: the same window, the same bottom border row.
    expect(rows[0]).toBeGreaterThan(5);
    expect(rows).toEqual([rows[0], rows[0], rows[0]]);
    expect(screen(1).join('\n')).toContain('> 3. Folder and scope');
    expect(screen(2).join('\n')).toContain('> 5. Who uses this installation'); expect(screen(2).join('\n')).toMatch(/1\. Solo/u);
    // After Esc the plain summary stays in the scrollback; the folder holds only what the test put there.
    expect(run.output.slice(run.marks[2])).toContain('deckent setup plan'); expect(run.output).toContain('Nothing was applied.');
    expect(await readdir(root)).toEqual(['package.json']);
  }, 150_000);
});


describe.skipIf(process.platform !== 'linux')('119-F1b execution consent on the production init PTY', () => {
  it('EN/TR: guarded quiet Enter adds exactly six cells once; rollback and missing history preselect not-now; skips write nothing', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const home = await mkdtemp(join(tmpdir(), 'deckent-init-execution-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-init-execution-root-'));
      roots.push(home, root);
      const env = personEnv({ PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1', DOCKER_HOST: 'unix:///nonexistent/docker.sock' });
      const run = async (args: string[], steps: unknown[], size = [24, 60], argv = [process.execPath, cli, ...args]) => {
        const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify(argv), root, JSON.stringify(size)],
          { env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
        const result = JSON.parse(stdout) as { status: number; output: string; marks: number[]; snapshots: Record<string, string | null>[]; timeout?: string };
        expect(result.timeout, result.output?.slice(-4000)).toBeUndefined(); expect(result.status, result.output?.slice(-4000)).toBe(0);
        return result;
      };
      await execute(process.execPath, [cli, 'init', '--yes', '--scope', 'erp', '--lang', locale, '--json'], { cwd: root, env: { ...env, TERM: 'dumb' }, timeout: 120_000 });
      const observed = await execute(process.execPath, [cli, 'policy', 'upgrade', '--template', 'current', '--only', 'ai-execution', '--scope', 'erp', '--preview', '--json'], { cwd: root, env, timeout: 120_000 });
      expect(JSON.parse(observed.stdout)).toMatchObject({ executionHistory: 'unknown' }); // Governed CLI stays archive-only.
      // A real, witnessed non-execution write before a second init must preserve the fresh-origin default.
      await run(['init', 'policy', '--modes', 'full-auto', '--scope', 'erp', '--apply', '--lang', locale], [[locale === 'en' ? 'Enter confirm' : 'Enter onayla', 'y']]);
      // The installer grant publication above is keyed; permanent /mode writes are two distinct keyless edges.
      const modes = await execute(process.execPath, ['--input-type=module', '-e', `
        const { FilePolicySource, LocalOsSessionAuthority } = await import(${JSON.stringify(resolve('dist/adapters/index.js'))});
        const { PermissionModeApplication } = await import(${JSON.stringify(resolve('dist/engine/index.js'))});
        const { resolveProductLayout, productResourcePath, getConfigFieldDefault } = await import(${JSON.stringify(resolve('dist/platform/index.js'))});
        const layout = resolveProductLayout({ projectRoot: process.cwd() });
        const source = new FilePolicySource({ path: productResourcePath(layout, 'policy'), bindingsPath: productResourcePath(layout, 'bindings'),
          archivePath: productResourcePath(layout, 'audit') + '/authority-revisions', ownerUid: process.getuid(), maxBytes: getConfigFieldDefault('inspection').policyMaxBytes });
        const clock = { sample: () => ({ wallMs: Date.now(), monotonicMs: 0 }) };
        const sessions = await LocalOsSessionAuthority.create(['erp'], 600000, clock);
        const { principal } = await sessions.verifySession(undefined);
        const app = new PermissionModeApplication(source, () => {}, Date.now);
        for (const mode of ['full-auto', 'standart']) {
          const result = await app.set(principal, { schemaVersion: 1, scopeId: 'erp', mode, expectedRevision: (await source.load()).revision });
          if (!result.changed) throw new Error('mode must write');
        }
        console.log(JSON.stringify(await source.authorityHistory()));
      `], { cwd: root, env, timeout: 120_000 });
      const keyless = (JSON.parse(modes.stdout) as { key: string | null; after: { revision: string } }[]).filter(entry => entry.key === null);
      expect(keyless).toHaveLength(2);
      expect(new Set(keyless.map(entry => entry.after.revision)).size).toBe(2);
      const wizardPreview = await execute(process.execPath, ['--input-type=module', '-e', `
        const { createCliHost } = await import(${JSON.stringify(resolve('dist/composition/core/cli/internal/host.js'))});
        const host = createCliHost({ root: process.cwd(), locale: 'en', signal: new AbortController().signal });
        console.log(JSON.stringify(await host.previewSetupExecutionPermission(process.cwd(), 'erp', { env: process.env })));
      `], { cwd: root, env, timeout: 120_000 });
      expect(JSON.parse(wizardPreview.stdout)).toMatchObject({ executionHistory: 'never' });
      const title = locale === 'en' ? 'Let AI carry out work?' : 'Yapay zekâya işleri yürütme izni verilsin mi?';
      const keys = locale === 'en' ? 'Enter confirm' : 'Enter onayla', profile = locale === 'en' ? '> 5. Who uses' : '> 5. Kurulumu kim';
      const governed = ['policy', 'upgrade', '--template', 'current', '--only', 'ai-execution', '--scope', 'erp', '--apply', '--lang', locale, '--expect', JSON.parse(wizardPreview.stdout).revision];
      const policyFile = join(root, '.deckent/policy.json'), archive = join(root, '.deckent/audit/authority-revisions');
      const before = await readFile(policyFile), historyFiles = await readdir(archive);
      const pipe = await execute(process.execPath, [cli, ...governed, '--json'], { cwd: root, env }).then(result => result, error => ({ stdout: String(error.stdout), stderr: String(error.stderr) }));
      expect(pipe.stdout + pipe.stderr).toContain('AUTHORITY_WITNESS_REQUIRED');
      const marked = await execute('python3', ['-c', DRIVER, '[]', JSON.stringify([process.execPath, cli, ...governed, '--json']), root],
        { env: { ...env, [AGENT_ENVIRONMENT[0]!]: '1' }, timeout: 40_000 });
      const denied = JSON.parse(marked.stdout);
      expect(denied.output).toContain('AUTHORITY_WITNESS_REQUIRED'); expect(denied.output).not.toContain(title);
      expect(await readFile(policyFile)).toEqual(before); expect(await readdir(archive)).toEqual(historyFiles);
      if (locale === 'en') {
        const pipedText = await execute(process.execPath, [cli, ...governed], { cwd: root, env }).then(result => result,
          error => ({ stdout: String(error.stdout), stderr: String(error.stderr) }));
        const markedText = await execute('python3', ['-c', DRIVER, '[]', JSON.stringify([process.execPath, cli, ...governed]), root],
          { env: { ...env, [AGENT_ENVIRONMENT[0]!]: '1' }, timeout: 40_000 });
        for (const text of [pipedText.stdout + pipedText.stderr, JSON.parse(markedText.stdout).output]) {
          expect(text).toMatch(/needs a person at an interactive terminal/u);
          expect(text).not.toContain(title);
        }
        expect(await readFile(policyFile)).toEqual(before); expect(await readdir(archive)).toEqual(historyFiles);
      }
      const interruptible = `process.once('SIGUSR1', () => process.stdin.push(null)); const { main } = await import(${JSON.stringify(resolve('dist/composition/core/cli/internal/cli-main.js'))}); process.exitCode = await main(${JSON.stringify(governed)});`;
      for (const key of ['n', '\u001b', '\u0003', 'SIGNAL:10']) {
        const cancelled = await run(governed, [[keys, key]], [24, 60], key === 'SIGNAL:10' ? [process.execPath, '--input-type=module', '-e', interruptible] : undefined);
        const frame = terminalBuffers(cancelled.output.slice(0, cancelled.marks[0]!), 60, 24).text;
        expect(frame).toContain(title); expect(frame.match(/[›>] 1\./gu)).toHaveLength(1);
        expect(cancelled.output).toContain(locale === 'en' ? 'Cancelled; nothing was written.' : 'İptal edildi; hiçbir şey yazılmadı.');
        expect(await readFile(policyFile)).toEqual(before); expect(await readdir(archive)).toEqual(historyFiles);
      }
      const typed = locale === 'en' ? 'Text typed here is not an answer.' : 'Buraya yazılan metin bir cevap değildir.';
      const unchosen = locale === 'en' ? 'Nothing was chosen.' : 'Hiçbir şey seçilmedi.';
      const grant = locale === 'en' ? 'Grant permission and continue' : 'İzni ver ve devam et';
      const notNow = locale === 'en' ? 'Not now' : 'Şimdi değil';
      // No input, buffered Return/repeat/burst/paste, and text+Enter must all leave this very same card open.
      const accepted = await run(['init', '--lang', locale], [[title, '\r\r\r\r', 0], [keys, 'RAW:\r\r'], ['', 'RAW:\u001b[200~grant\r\u001b[201~'],
        [typed, '\r'], [unchosen, '\u001b[A'], ['', '/policy'], [typed, '\r'], [unchosen, '\u001b[A'],
        ['', '\u001b[6~'], ['', '\u001b[5~'], ['', '\u001b[F'], ['', '\u001b[H'], ['', 'RESIZE:[30,90]'], ['', '\r'], [profile, '\u001b']]);
      const transcripts = process.env['DECKENT_I_S3_TRANSCRIPTS'];
      if (transcripts) await writeFile(join(transcripts, `119-execution-${locale}.json`), JSON.stringify(accepted));
      const first = terminalBuffers(accepted.output.slice(0, accepted.marks[1]!), 60, 24).text;
      expect(first).toContain('PageUp/PageDown');
      expect(first).toContain(grant); expect(first).toContain(notNow); expect(first).toMatch(/[›>] 1\./u); expect(first).toMatch(/\d+-\d+\/\d+/u);
      const fixedHintRows: number[] = [];
      for (const mark of [8, 9, 10, 11]) {
        const screen = terminalBuffers(accepted.output.slice(0, accepted.marks[mark]!), 60, 24).text;
        expect(screen).toContain(grant); expect(screen).toContain(notNow); expect(screen).toContain('PageUp/PageDown');
        fixedHintRows.push(screen.split('\n').findIndex(row => row.includes('PageUp/PageDown')));
      }
      expect(fixedHintRows).toEqual(fixedHintRows.map(() => fixedHintRows[0]));
      const resized = terminalBuffers(accepted.output.slice(0, accepted.marks[13]!), 90, 30).text;
      expect(resized).toContain('PageUp/PageDown'); expect(resized).toContain(grant); expect(resized).toContain(notNow);
      const policyPath = join(root, '.deckent', 'policy.json');
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string; actions: string[]; resource: { kind: string; ids: string[] }; scopes: string[] }[] };
      const rules = policy.grants.filter(rule => rule.id.startsWith('first-run-mcp-progress-'));
      expect(rules).toHaveLength(3);
      expect(rules.flatMap(rule => rule.actions.map(action => `${rule.resource.kind}/${action}`)).sort()).toEqual(['attempt/evaluate', 'attempt/execute', 'attempt/read-output', 'attempt/recover-output', 'run/cancel', 'run/reserve']);
      expect(rules.every(rule => JSON.stringify(rule.scopes) === '["erp"]')).toBe(true);
      expect(accepted.output.match(new RegExp(title.replace('?', '\\?'), 'gu'))?.length).toBeGreaterThan(0);
      expect(accepted.output).not.toContain('Approval required');
      const rollback = await run(['policy', 'upgrade', '--template', 'current', '--scope', 'erp', '--rollback', '--lang', locale], [[locale === 'en' ? 'Withdraw managed permission?' : 'Yönetilen izin kaldırılsın mı?', '\u001b[A'], [keys, '\r']]);
      expect(rollback.output).not.toContain(title);
      const snapshot = async () => {
        const result: Record<string, string | null> = {};
        const walk = async (path: string, prefix = ''): Promise<void> => {
          for (const file of await readdir(path, { withFileTypes: true })) {
            const name = prefix + file.name;
            if (file.isDirectory()) { result[name + '/'] = null; await walk(join(path, file.name), name + '/'); }
            else result[name] = createHash('sha256').update(await readFile(join(path, file.name))).digest('hex');
          }
        };
        await walk(join(root, '.deckent')); return result;
      };
      const withdrawn = locale === 'en' ? 'This permission was withdrawn on this installation earlier.' : 'Bu izin bu kurulumda daha önce geri alınmıştı.';
      const skipped = await run(['init', '--lang', locale], [[title, 'SNAPSHOT'], ['', '\r'], [profile, '\u001b']]);
      const screen = terminalBuffers(skipped.output.slice(0, skipped.marks[0]!), 60, 24).text;
      expect(screen).toContain(withdrawn.slice(0, 35)); expect(screen).toMatch(/[›>] 2\./u); expect(await snapshot()).toEqual(skipped.snapshots[0]);
      // Esc, Ctrl+C and the raw terminal's Ctrl+D cancel without touching any retained installation state.
      for (const key of ['\u001b', '\u0003', '\u0004']) {
        const cancelled = await run(['init', '--lang', locale], [[title, 'SNAPSHOT'], ['', key], [profile, '\u001b']]);
        expect(await snapshot()).toEqual(cancelled.snapshots[0]);
      }
      await rm(join(root, '.deckent', 'audit', 'authority-revisions'), { recursive: true, force: true });
      const unknown = await run(['init', '--lang', locale], [[title, 'SNAPSHOT'], ['', '\r'], [profile, '\u001b']]);
      const unknownScreen = terminalBuffers(unknown.output.slice(0, unknown.marks[0]!), 60, 24).text;
      expect(unknownScreen).toMatch(/[›>] 2\./u);
      const unknownWords = unknownScreen.split('\n').map(line => line.replace(/^│\s*|\s*│$/gu, '').trim()).join(' ').replace(/\s+/gu, ' ');
      expect(unknownWords).toContain(locale === 'en' ? 'The earlier state of this permission could not be verified. Not now is preselected.' : 'Bu iznin önceki durumu doğrulanamadı. Şimdi değil seçili.');
      expect(await snapshot()).toEqual(unknown.snapshots[0]);
      // Deliver actual stream end and AbortSignal to the assembled production card on this owned PTY.
      // init's executable has no signal-to-abort adapter; this tiny driver supplies its existing host signal seam.
      const interrupted = `
        const { createCliHost } = await import(${JSON.stringify(resolve('dist/composition/core/cli/internal/host.js'))});
        const { setupInitCommand } = await import(${JSON.stringify(resolve('dist/surfaces/core/setup/index.js'))});
        const controller = new AbortController();
        process.once('SIGUSR1', () => process.stdin.push(null)); process.on('SIGUSR2', () => controller.abort());
        const host = createCliHost({ root: process.cwd(), locale: ${JSON.stringify(locale)}, signal: controller.signal });
        host.initialize();
        await setupInitCommand(['init', '--lang', ${JSON.stringify(locale)}], host);
      `;
      const eof = await run([], [[title, 'SNAPSHOT'], ['', 'SIGNAL:10']], [24, 60], [process.execPath, '--input-type=module', '-e', interrupted]);
      expect(eof.output).toContain(locale === 'en' ? 'Setup interrupted; the first policy was kept.' : 'Kurulum kesildi; ilk politika korundu.');
      expect(await snapshot()).toEqual(eof.snapshots[0]);
      const aborted = await run([], [[title, 'SNAPSHOT'], ['', 'SIGNAL:12'], [profile, '\u001b']], [24, 60], [process.execPath, '--input-type=module', '-e', interrupted]);
      expect(await snapshot()).toEqual(aborted.snapshots[0]);
    }
  }, 240_000);
});

it.skipIf(process.platform !== 'linux')('walk 119: the inline wizard yields its selection marker to the permission card at 60 columns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deckent-walk-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-walk-root-'));
  roots.push(home, root);
  const env = personEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env['PATH'], TERM: 'xterm-256color', NO_COLOR: '1' });
  const steps = [['Enter confirm', '\r'], ['> 3. Folder', '\r'], ['> 5. Who uses', '\r'], ['> 6. Permissions', '\r'],
    ['Apply now', '\r'], ['Let AI carry out work?', 'SNAPSHOT'], ['', '\u001b'], ['Enter confirm', '\u001b']];
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify([process.execPath, cli, 'init', '--here', '--lang', 'en']), root, '[24,60]'],
    { env, timeout: 100_000, maxBuffer: 8 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '{}') }));
  const result = JSON.parse(stdout);
  expect(result.timeout, result.output?.slice(-2500)).toBeUndefined(); expect(result.status).toBe(0);
  const frame = terminalBuffers(result.output.slice(0, result.marks[5]), 60, 24).text;
  expect(frame).toContain('Grant permission and continue'); expect(frame.match(/[›>] [12]\./gu)).toHaveLength(1);
  expect(frame).not.toContain('Apply now');
  const transcripts = process.env['DECKENT_I_S3_TRANSCRIPTS'];
  if (transcripts) await writeFile(join(transcripts, '119-handoff-frame.txt'), frame);
}, 110_000);

it.skipIf(process.platform !== 'linux')('3280 F4: real CLI prints every long affected scope before the EN/TR rollback card; decline writes nothing; JSON retains scopes', async () => {
  for (const locale of ['en', 'tr'] as const) for (const scopes of [
    ['erp', 'other'], ['erp', 'team,west', 'team\u202eabc', 'team\u200babc', 'team\\u202eabc'], ['erp', ...Array.from({ length: 7 }, (_, i) => `department-${i}-${'x'.repeat(70)}`)],
  ]) {
    const home = await mkdtemp(join(tmpdir(), 'deckent-rollback-home-')), root = await mkdtemp(join(tmpdir(), 'deckent-rollback-root-'));
    roots.push(home, root);
    const env = personEnv({ PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1', DOCKER_HOST: 'unix:///nonexistent/docker.sock' });
    await execute(process.execPath, [cli, 'init', '--yes', '--scope', 'erp', '--lang', locale, '--json'], { cwd: root, env: { ...env, TERM: 'dumb' }, timeout: 120_000 });
    const policyPath = join(root, '.deckent/policy.json'), baseline = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { scopes: 'all' | string[] }[] };
    await writeFile(policyPath, JSON.stringify({ ...baseline, revision: 'a-long-baseline', grants: baseline.grants.map(rule => rule.scopes === 'all' ? rule : { ...rule, scopes }) }));
    const drive = async (args: string[], steps: unknown[]) => {
      const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(steps), JSON.stringify([process.execPath, cli, ...args]), root],
        { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }));
      const result = JSON.parse(stdout) as { status: number; output: string; timeout?: string; snapshots: Record<string, string | null>[] };
      expect(result.timeout, result.output).toBeUndefined(); expect(result.status, result.output).toBe(0);
      return result;
    };
    expect((await drive(['policy', 'upgrade', '--template', 'current', '--scope', 'erp', '--apply', '--lang', locale], [[locale === 'en' ? 'Enter confirm' : 'Enter onayla', 'y']])).output)
      .toContain(locale === 'en' ? 'added' : 'eklendi');
    await execute(process.execPath, ['--input-type=module', '-e', `
      const { FilePolicySource } = await import(${JSON.stringify(resolve('dist/adapters/index.js'))});
      const { resolveProductLayout, productResourcePath, getConfigFieldDefault } = await import(${JSON.stringify(resolve('dist/platform/index.js'))});
      const layout = resolveProductLayout({ projectRoot: process.cwd() });
      const source = new FilePolicySource({ path: productResourcePath(layout, 'policy'), bindingsPath: productResourcePath(layout, 'bindings'),
        archivePath: productResourcePath(layout, 'audit') + '/authority-revisions', ownerUid: process.getuid(), maxBytes: getConfigFieldDefault('inspection').policyMaxBytes });
      await source.updateAuthority(snapshot => ({ write: { policy: { ...snapshot.policy, revision: 'a-narrowed-anchor',
        grants: snapshot.policy.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, scopes: ['erp'] } : rule) },
        bindings: null, order: 'policy-first' }, result: null }), 'narrow-anchor');
    `], { cwd: root, env, timeout: 120_000 });
    const title = locale === 'en' ? 'Withdraw managed permission?' : 'Yönetilen izin kaldırılsın mı?';
    const args = ['policy', 'upgrade', '--template', 'current', '--scope', 'erp', '--rollback', '--lang', locale];
    // The snapshot step already consumed the armed hint; its next frame need not repeat that hint.
    const declined = await drive(args, [[title, 'SNAPSHOT'], ['', '\r']]);
    const card = declined.output.indexOf(title);
    expect(card).toBeGreaterThan(0);
    for (const scope of scopes) {
      const shown = JSON.stringify(scope).replace(/\u202e/gu, '\\u202e').replace(/\u200b/gu, '\\u200b');
      const lines = declined.output.slice(0, card).split(/\r?\n/u);
      expect(lines).toContain(shown);
    }
    expect(declined.output.slice(0, card)).not.toMatch(/[\u202e\u200b]/u);
    expect(declined.output).toContain(locale === 'en' ? 'Permission kept; nothing was written.' : 'İzin korundu; hiçbir şey yazılmadı.');
    const snapshot: Record<string, string | null> = {};
    for (const entry of await readdir(join(root, '.deckent'), { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name), relative = path.slice(join(root, '.deckent').length + 1);
      snapshot[entry.isDirectory() ? `${relative}/` : relative] = entry.isDirectory() ? null : (await import('node:crypto')).createHash('sha256').update(await readFile(path)).digest('hex');
    }
    expect(snapshot).toEqual(declined.snapshots[0]);
    const applied = await drive([...args, '--json'], []);
    const line = applied.output.split(/\r?\n/u).find(value => value.startsWith('{"schemaVersion":1,"status":'))!;
    expect(JSON.parse(line)).toMatchObject({ status: 'rolled-back', executionScopes: scopes });
  }
}, 120_000);
