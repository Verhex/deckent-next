import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout, withConfigWriteLock } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
import { terminalScreen } from '../../fixtures/terminal-screen.js';

// T-L4 slice 4c (MODES-3: v17, three modes) at the real boundary: compiled CLI in a real pseudo-terminal, a real runtime service process,
// the company policy (v2) and the person's bindings as real layout files. `/mode` shows the mode, `/mode full-auto` changes it through the
// service (the terminal touches no file), the next turn's eligible edit runs without a card and is audited, and a narrow terminal drops the
// mode segment from the status row. Full access opens at launch on the company grant, with a standing warning; T2 (owner 2026-10-07,
// corrected) also lets Shift+Tab or `/mode full-access` switch into it inside a session through the same service set and grant.
const execute = promisify(execFile);
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [], servers: Server[] = [], runtimes: ChildProcess[] = [];
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => {
  for (const child of runtimes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(done => child.once('exit', () => done())); }
  }
  clearConfigCache();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** python3 `pty` driver (as in terminal-pty-process), with the window width as a parameter. */
const DRIVER = String.raw`
import fcntl, json, os, pty, re, select, struct, sys, termios, time
argv, steps, columns = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, columns, 0, 0))
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
    deadline = time.time() + 25
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.5)
    marks.append(len(out.decode('utf8', 'replace')))
    # One write per key: an escape sequence (an arrow) stays whole, so the terminal reads it as one key (T3 L4 windows).
    for key in re.findall(r'\x1b\[[A-Z0-9~]+|.', send, re.S):
        os.write(fd, key.encode()); time.sleep(0.01)
deadline = time.time() + 25
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
read_for(0.2)
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'marks': marks}))
`;
async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>, columns = 120) {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), String(columns)],
    { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string; marks?: number[] };
}

async function startRuntime(projectRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimes.push(child);
  let stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`RUNTIME_READY_TIMEOUT:${stderr.slice(-800)}`)), 20_000);
    const failed = () => { clearTimeout(timer); reject(new Error(`RUNTIME_START_FAILED:${stderr.slice(-800)}`)); };
    child.once('error', failed); child.once('exit', failed);
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try { if ((JSON.parse(line) as { event?: string }).event === 'ready') { clearTimeout(timer); child.off('error', failed); child.off('exit', failed); done(); } }
        catch { /* The ready line is JSON. */ }
      }
    });
  });
}

/** A local model that asks for one `edit_file` call, then answers `Mode turn done.`; a v2 company policy with a mode-eligible edit rule. */
async function modeProject(policy: 'v2' | 'v1' | 'no-set-grant' = 'v2',
  options: { readonly call?: { readonly name: string; readonly arguments: Record<string, unknown> }; readonly shell?: boolean; readonly mode?: string } = {}) {
  const v3 = options.mode === 'standart' || options.mode === 'full-access';
  const call = options.call ?? { name: 'edit_file', arguments: { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' } };
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-mode-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(projectRoot, 'src'), { recursive: true }),
    mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  let requests = 0;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'mode-pty', object: 'chat.completion.chunk',
    created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'mode-pty', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const round = requests++ % 2 === 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end((round ? [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: call.name, arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.arguments) } }] }), chunk({}, 'tool_calls'), usage]
        : [chunk({ role: 'assistant', content: 'Mode turn done.' }), chunk({}, 'stop'), usage]).join('') + 'data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
  const model = { id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
    capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'local-openai', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, maxOutputTokens: 256, authentication: { type: 'none' }, tariff } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 5000 } };
  await writeFile(join(projectRoot, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    terminal: { autostartService: false, scopeId: 'scope', chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const me = { issuer: principal.issuer, subject: principal.subject };
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog-1', expectedBinding: binding });
  const grant = (id: string, effect: string, actions: string[], kind: string, ids: string[] | 'all', extra: Record<string, unknown> = {}) =>
    ({ id, effect, actions, scopes: ['scope'], principals: [me], resource: { kind, ids }, ...extra });
  const eligible = policy === 'v1' ? {} : { modeEligible: true };
  const grants = [
    grant('invoke', 'allow', ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], 'model-invocation', [modelInvocationTargetId(reference)]),
    grant('scope', 'allow', ['inspect'], 'scope', ['scope']), grant('decide', 'allow', ['inspect', 'decide'], 'approval', 'all'),
    grant('edit-tools', 'require-approval', ['invoke'], 'agent-tool', ['edit_file', 'write_file'], eligible),
    grant('file-write', 'allow', ['execute'], 'operation', ['workspace.file.write']),
    ...(options.shell ? [grant('shell-tool', 'require-approval', ['invoke'], 'agent-tool', ['run_shell'], eligible),
      grant('shell-run', 'allow', ['execute'], 'operation', ['host.shell.run'])] : []),
    ...policy === 'v2' ? [grant('mode-set', 'allow', ['set'], 'permission-mode', ['full-auto', 'full-access'])] : []];
  await writeFile(join(data, 'policy.json'), JSON.stringify(policy === 'v1' ? { schemaVersion: 1, revision: 'p1', restrictions: [], grants }
    : { schemaVersion: 2, revision: 'p1', roles: [], separationOfDuties: [], restrictions: [], grants }), { mode: 0o600 });
  const theirs = { id: 'their-mode', principal: { issuer: 'another-host', subject: '4242' }, scopes: ['scope'], mode: 'full-auto' };
  const mine = options.mode ? [{ id: 'my-mode', principal: me, scopes: ['scope'], mode: options.mode }] : [];
  if (policy !== 'v1') await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: v3 ? 3 : 2, revision: 'b1', bindings: [], modes: [theirs, ...mine] }), { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  const audit = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT kind, record FROM audit_events ORDER BY sequence').all(); } finally { db.close(); } };
  return { projectRoot, data, env, me, theirs, audit };
}

describe.skipIf(process.platform !== 'linux')('/mode in a real pseudo-terminal against a real runtime service (T-L4 slice 4c)', () => {
  it('shows the mode, changes it through the service, runs the next eligible edit without a card and drops the segment when narrow', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const before = await stat(join(f.data, 'bindings.json'), { bigint: true });
    const wide = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      // T3 L4: a bare /mode is the mode window; choosing full auto there is the same service set as `/mode full-auto` and Shift+Tab.
      ['Deckent workline', '/mode\r'],
      ['standard · now', '\u001b[B\u001b[B\r'],
      ['Mode: standard → full auto', 'go\r'],
      ['Mode turn done.', '/exit\r'],
    ]);
    expect(wide.timeout, wide.output).toBeUndefined();
    expect(wide.status, wide.output).toBe(0);
    expect(wide.output).not.toContain('Unknown command');
    // No approval card for the eligible edit in full-auto; the file changed and the mode's decision was audited.
    expect(wide.output).not.toContain('Approval needed');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    const file = JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { schemaVersion: number; revision: string; modes: Array<{ principal: unknown; mode: string }> };
    expect((await stat(join(f.data, 'bindings.json'), { bigint: true })).ino).not.toBe(before.ino);
    expect(file.revision).toMatch(/^m-[0-9a-f]{40}$/u);
    expect(file.schemaVersion).toBe(3);
    expect(file.modes).toEqual([f.theirs, expect.objectContaining({ principal: f.me, scopes: ['scope'], mode: 'full-auto' })]);
    expect(f.audit().map(row => (row as { kind: string }).kind)).toEqual(['permission-mode-change', 'permission-mode']);
    // After the change the status row carries the mode on a wide terminal as its mark and catalog word (T2).
    const after = wide.output.slice(wide.output.indexOf('Mode: standard → full auto'));
    expect(after).toContain('⏵⏵ full auto');
    // Narrow: replay cursor movement/erasure. Ink may redraw the same notice in the raw PTY stream;
    // the terminal buffer must still contain exactly one notice and no mode segment in the status row.
    // `/mode full-auto` again (the text command; a bare /mode is the window): the service keeps the mode and the notice names it.
    const narrow = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode full-auto\r'], ['full-auto', '/exit\r']], 30);
    expect(narrow.timeout, narrow.output).toBeUndefined();
    expect(narrow.status, narrow.output).toBe(0);
    const screen = terminalScreen(narrow.output, 30);
    // The notice now starts with its level in words ("Info: "), so at 30 columns it wraps inside the phrase: compare it unwrapped.
    expect(screen.replace(/\s+/gu, ' '), narrow.output).toContain('Permission mode: full-auto');
    expect(screen.split('full-auto').length - 1, screen).toBe(1);
  }, 180_000);
  // SHELL-AUTONOMY (owner 2026-09-28): the owner's own full-auto command, through the compiled CLI and a real service process whose shell
  // realm is the default `prefer-sandbox` (bubblewrap here): no approval card, the command ran in the sandbox, one audit event.
  it.skipIf(!bwrapReady)('full-auto inside bubblewrap runs the owner\'s compound command without a card', async () => {
    const command = 'echo "full-auto otonom test: run_shell otomatik mi?" && date && whoami';
    const f = await modeProject('v2', { call: { name: 'run_shell', arguments: { command } }, shell: true, mode: 'full-auto' });
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', 'go\r'], ['Mode turn done.', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('Approval needed');
    expect(run.output).toContain('run_shell');
    const events = f.audit().map(row => JSON.parse(String((row as { record: string }).record)) as { event: { subject: Record<string, unknown> } });
    expect(events.map(record => record.event.subject)).toEqual([expect.objectContaining({ kind: 'permission-mode', mode: 'full-auto', cell: 'shell-modify',
      summary: expect.objectContaining({ kind: 'shell', head: command }) })]);
  }, 180_000);
});

// MODE-UX (G3): what the person needs to do next is on the screen — never a bare "denied", never a call the service can only refuse.
describe.skipIf(process.platform !== 'linux')('/mode explains itself in a real pseudo-terminal (MODE-UX G3)', () => {
  // The terminal wraps long notices at the window width: compare on the text with whitespace runs collapsed.
  const modeLines = (output: string) => stripVTControlCharacters(output).replace(/\s+/gu, ' ');
  const changes = (f: Awaited<ReturnType<typeof modeProject>>) => f.audit().filter(row => (row as { kind: string }).kind === 'permission-mode-change');

  it('shows the current mode with what it changes and the modes to try', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    // T3 L4: a bare /mode is the mode window — every mode, the current one marked, the focused one's effect in words.
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode\r'], ['standard · now', '\u001b'],
      ['Deckent workline', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    const text = modeLines(run.output);
    expect(text).toContain('reads, scratch and the in-project edits the company marked mode-eligible run without a card');
    expect(text).toContain('careful'); expect(text).toContain('full auto');
    // T2: the company grants full access here, so it is offered like any other mode (no launch-only refusal any more).
    expect(text).toContain('full access');
    expect(text).not.toContain('Full access needs your company'); expect(text).not.toContain('[blocked]');
  }, 180_000);

  it('a v1 policy: /mode full-auto says modes are off and asks the service for nothing (no file, no audit row)', async () => {
    const f = await modeProject('v1');
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode full-auto\r'], ['Permission modes are off', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(modeLines(run.output)).toContain('this policy is v1');
    await expect(access(join(f.data, 'bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changes(f)).toEqual([]);
  }, 180_000);

  it('without a set grant the refusal names the mode and the missing grant; the file is untouched and the refusal is audited', async () => {
    const f = await modeProject('no-set-grant');
    await startRuntime(f.projectRoot, f.env);
    const before = await readFile(join(f.data, 'bindings.json'), 'utf8');
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode full-auto\r'], ['No grant lets you set full-auto', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(modeLines(run.output)).toContain('Add an allow grant (resource `permission-mode`, action `set`, id full-auto)');
    expect(modeLines(run.output)).not.toContain('Policy does not permit');
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(before);
    expect(changes(f).map(row => JSON.parse((row as { record: string }).record) as { event?: { subject?: { decision?: unknown } } })
      .map(record => JSON.stringify(record).includes('"effect":"deny"'))).toEqual([true]);
  }, 180_000);

  it('a held authority write lock is explained as another process at work with a retry instruction; nothing is written', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const before = await readFile(join(f.data, 'bindings.json'), 'utf8');
    const run = await withConfigWriteLock(join(f.data, 'policy.json'), () => inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'],
      [['Deckent workline', '/mode full-auto\r'], ['Another Deckent process is changing the policy files', '/exit\r']]), 2_000);
    expect(run.timeout, run.output).toBeUndefined();
    expect(modeLines(run.output)).toContain('run /mode again');
    expect(modeLines(run.output)).not.toContain('Configuration lock');
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(before);
    expect(changes(f)).toEqual([]);
  }, 180_000);
});

// MODES-3 (owner 2026-09-29): full access opens at launch (`deckent --full-access`, `deckent terminal --full-access`, or the person's stored
// start mode) only on the company grant; the status row keeps a full-access segment at any width and the first message warns; every call is
// audited. (The 2026-09-29 refusal of an in-session switch was withdrawn by the owner on 2026-10-07; see the T2 describe below.)
describe.skipIf(process.platform !== 'linux')('full access in a real pseudo-terminal (MODES-3)', () => {
  const plain = (output: string) => stripVTControlCharacters(output).replace(/\s+/gu, ' ');
  const kinds = (f: Awaited<ReturnType<typeof modeProject>>) => f.audit().map(row => (row as { kind: string }).kind);

  it('`deckent terminal --full-access` warns, keeps the segment and audits the turn and its call', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const before = await readFile(join(f.data, 'bindings.json'), 'utf8');
    const run = await inPty(f.projectRoot, f.env, ['terminal', '--full-access'], [['Deckent workline', 'go\r'], ['Mode turn done.', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    const text = plain(run.output);
    expect(text).toContain('FULL ACCESS is on');
    expect(text).toContain('⚠ full access');
    expect(text).not.toContain('Approval needed');
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(before);
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(kinds(f)).toEqual(['full-access-turn', 'full-access-call']);
    // On a 30-column terminal the full-access segment is not dropped (the other modes are).
    const narrow = await inPty(f.projectRoot, f.env, ['terminal', '--full-access'], [['full access', '/exit\r']], 30);
    expect(narrow.timeout, narrow.output).toBeUndefined();
    expect(narrow.status, narrow.output).toBe(0);
  }, 180_000);

  it('`deckent --full-access` without the company grant does not open: the refusal names the missing grant; nothing ran', async () => {
    const f = await modeProject('no-set-grant');
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['--full-access'], []);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).not.toBe(0);
    expect(plain(run.output)).toContain('No grant lets you set full-access');
    expect(plain(run.output)).not.toContain('Deckent workline');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(kinds(f)).toEqual([]);
  }, 180_000);

  it('a stored full-access start mode opens in full access on the grant, and as standart with a notice without it', async () => {
    const f = await modeProject('v2', { mode: 'full-access' });
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(plain(run.output)).toContain('FULL ACCESS is on');
    const g = await modeProject('no-set-grant', { mode: 'full-access' });
    await startRuntime(g.projectRoot, g.env);
    const denied = await inPty(g.projectRoot, g.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/exit\r']]);
    expect(denied.timeout, denied.output).toBeUndefined();
    expect(plain(denied.output)).toContain('this session runs as standart');
    expect(plain(denied.output)).not.toContain('FULL ACCESS is on');
  }, 180_000);
});

// T2 T-MODE-CYCLE (owner 2026-10-07, corrected) at the real boundary: Shift+Tab (ESC [ Z) walks every mode the person may take; each step is
// the service's own set (grant decided and `permission-mode-change` audited before the file changes); full access only on the company grant,
// and the hard floor still holds in a full-access session entered this way.
describe.skipIf(process.platform !== 'linux')('Shift+Tab mode cycle in a real pseudo-terminal (T2 T-MODE-CYCLE)', () => {
  const SHIFT_TAB = '\u001b[Z';
  const plain = (output: string) => stripVTControlCharacters(output).replace(/\s+/gu, ' ');
  const subjects = (f: Awaited<ReturnType<typeof modeProject>>) => f.audit().map(row => (JSON.parse((row as { record: string }).record) as { event: { subject: Record<string, unknown> } }).event.subject);

  it('with the full-access grant: four stops, each audited; the full-access turn runs without a card and is audited; back to standard', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', SHIFT_TAB],
      ['Mode: standard → careful', SHIFT_TAB], ['Mode: careful → full auto', SHIFT_TAB], ['Mode: full auto → full access', 'go\r'],
      ['Mode turn done.', SHIFT_TAB], ['Mode: full access → standard', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('Approval requested');
    expect(plain(run.output)).toContain('⚠ full access');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    const events = subjects(f);
    // FA-SESSION (owner 2026-10-07): the full-access stop is this session's only — its own audit kind, nothing stored (the stored mode stays full-auto).
    expect(events.map(subject => subject['kind'])).toEqual(['permission-mode-change', 'permission-mode-change', 'permission-mode-session', 'full-access-turn',
      'full-access-call', 'permission-mode-change']);
    expect(events.filter(subject => subject['kind'] === 'permission-mode-change').map(subject => [subject['previous'], subject['requested'],
      (subject['decision'] as { effect: string }).effect, (subject['askEdits'] as { requested: boolean }).requested])).toEqual([
      ['standart', 'standart', 'allow', true], ['standart', 'full-auto', 'allow', false], ['full-auto', 'standart', 'allow', false]]);
    expect(events.find(subject => subject['kind'] === 'permission-mode-session')).toMatchObject({ requested: 'full-access', stored: 'full-auto',
      decision: { effect: 'allow', ruleId: 'mode-set' } });
    // Back at the default: the person's own entry is gone again; the other person's entry is untouched.
    const file = JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { modes: unknown[] };
    expect(file.modes).toEqual([f.theirs]);
  }, 180_000);

  it('FA-SESSION: full access entered with Shift+Tab ends with the session; the next launch opens in the last stored mode, `--full-access` still opens it', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const first = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', SHIFT_TAB],
      ['Mode: standard → careful', SHIFT_TAB], ['Mode: careful → full auto', SHIFT_TAB], ['Mode: full auto → full access', '/exit\r']]);
    expect(first.timeout, first.output).toBeUndefined();
    expect(first.status, first.output).toBe(0);
    expect(plain(first.output)).toContain('for this session only (the next launch opens in full auto)');
    const stored = JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { modes: Array<{ principal: unknown; mode: string }> };
    expect(stored.modes).toEqual([f.theirs, expect.objectContaining({ principal: f.me, mode: 'full-auto' })]);
    const next = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/exit\r']]);
    expect(next.timeout, next.output).toBeUndefined();
    expect(plain(next.output)).toContain('Mode full auto');
    expect(plain(next.output)).not.toContain('full access');
    expect(plain(next.output)).not.toContain('FULL ACCESS is on');
    const launched = await inPty(f.projectRoot, f.env, ['terminal', '--full-access'], [['Deckent workline', '/exit\r']]);
    expect(launched.timeout, launched.output).toBeUndefined();
    expect(plain(launched.output)).toContain('FULL ACCESS is on');
    expect(subjects(f).map(subject => subject['kind'])).toEqual(['permission-mode-change', 'permission-mode-change', 'permission-mode-session']);
  }, 180_000);

  it('without a set grant the cycle is standard ↔ careful: full auto and full access are skipped, nothing is refused', async () => {
    const f = await modeProject('no-set-grant');
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', SHIFT_TAB],
      ['Mode: standard → careful', SHIFT_TAB], ['Mode: careful → standard', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(plain(run.output)).not.toContain('full auto');
    expect(plain(run.output)).not.toContain('No grant lets you set');
    expect(subjects(f).map(subject => [subject['kind'], subject['requested'], (subject['decision'] as { effect: string }).effect]))
      .toEqual([['permission-mode-change', 'standart', 'allow'], ['permission-mode-change', 'standart', 'allow']]);
  }, 180_000);

  it('hard floor: in full access entered with Shift+Tab, a write of Deckent\'s own configuration is refused; nothing changes, nothing is audited as run', async () => {
    const f = await modeProject('v2', { call: { name: 'edit_file', arguments: { path: '.deckent/config.json', old_string: '"scopeId":"scope"', new_string: '"scopeId":"other"' } } });
    await startRuntime(f.projectRoot, f.env);
    const config = await readFile(join(f.projectRoot, '.deckent/config.json'), 'utf8');
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', SHIFT_TAB],
      ['Mode: standard → careful', SHIFT_TAB], ['Mode: careful → full auto', SHIFT_TAB], ['Mode: full auto → full access', 'go\r'],
      ['Mode turn done.', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    // The call never reaches an effect: its line is a failure, no card offers to run it, and the file is byte-identical.
    expect(plain(run.output)).toMatch(/edit_file \.deckent\/config\.json · \d+\.\ds · failed/u);
    expect(await readFile(join(f.projectRoot, '.deckent/config.json'), 'utf8')).toBe(config);
    const kinds = subjects(f).map(subject => subject['kind']);
    expect(kinds).toContain('full-access-turn');
    expect(kinds).not.toContain('full-access-call');
  }, 180_000);

  it('Alt+M steps the mode where Shift+Tab cannot be reported', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '\u001bm'], ['Mode: standard → careful', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
  }, 180_000);
});

// T2 T-STARTUP at the real boundary: the compiled CLI on a real pseudo-terminal clears the visible screen once (scrolling it into the scrollback
// first), prints the banner at the top, and never sends ED 3 (scrollback erase) during an ordinary session; EN and TR under NO_COLOR.
describe.skipIf(process.platform !== 'linux')('opening banner in a real pseudo-terminal (T2 T-STARTUP)', () => {
  it('starts at the top with the banner, in EN and TR, without colour codes in the banner and without ED 3', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    for (const [language, words] of [['en', ['Project project', 'Mode standard', 'Shift+Tab mode']], ['tr', ['Proje project', 'Mod standart', 'Shift+Tab mod']]] as const) {
      const run = await inPty(f.projectRoot, { ...f.env, DECKENT_LANGUAGE: language }, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/exit\r']]);
      expect(run.timeout, run.output).toBeUndefined();
      expect(run.status, run.output).toBe(0);
      expect(run.output).not.toContain('\u001b[3J');
      expect(run.output.split('\u001b[H\u001b[2J')).toHaveLength(2);
      const after = run.output.slice(run.output.indexOf('\u001b[H\u001b[2J') + '\u001b[H\u001b[2J'.length);
      // The banner is written before the live view starts: from the clear to the end of its hint row it carries no escape at all (NO_COLOR).
      const hint = language === 'en' ? '? shortcuts' : '? kısayollar';
      const banner = after.slice(0, after.indexOf(hint) + hint.length);
      expect(banner.trimStart().startsWith('╭──╮')).toBe(true);
      expect(banner).not.toContain('\u001b');
      for (const word of words) expect(stripVTControlCharacters(banner).replace(/\s+/gu, ' ')).toContain(word);
    }
  }, 180_000);

  it('opens with the default banner and theme when the configuration has no terminal section (scope from --scope)', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const path = join(f.projectRoot, '.deckent/config.json');
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete document['terminal'];
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output.split('\u001b[H\u001b[2J')).toHaveLength(2);
    expect(stripVTControlCharacters(run.output)).toContain('/help · Shift+Tab mode · ? shortcuts');
  }, 180_000);
});

// T2 integration (L1 window x L2 readability/startup x L3 human output) on the compiled product in a real PTY, EN and TR, NO_COLOR: the screen
// at each step is replayed from the PTY bytes (VT replay, 100 x 40). DECKENT_T2_FRAME_PROOF=<file> appends the replayed screens.
describe.skipIf(process.platform !== 'linux')('T2 surfaces together in a real pseudo-terminal (wave/tui-2 integration)', () => {
  it.each([
    ['en', { help: 'Commands', helpSummary: 'Help: ', status: 'Deckent is running', statusSummary: 'Status: Deckent is running', system: '◆ Deckent system', window: 'Approval needed', denied: 'denied', you: 'You', heading: 'Info', careful: '⏸ careful',
      declined: 'you declined', policy: 'denied by policy', undo: 'Not checked — Deckent does not keep the earlier content' }],
    ['tr', { help: 'Komutlar', helpSummary: 'Yardım: ', status: 'Deckent çalışıyor', statusSummary: 'Durum: Deckent çalışıyor', system: '◆ Deckent sistemi', window: 'Onay gerekiyor', denied: 'reddedildi', you: 'Sen', heading: 'Bilgi', careful: '⏸ dikkatli',
      declined: 'sen reddettin', policy: 'policy izin vermedi', undo: 'Kontrol edilmedi — Deckent önceki içeriği saklamıyor' }],
  ] as const)('%s: banner, /help, /status, the approval window and the person/answer rows', async (language, words) => {
    // The person runs careful (standart + ask for edits too), so the eligible edit opens the approval window; standart alone would run it.
    const f = await modeProject('v2', { mode: 'standart' });
    const bindings = join(f.data, 'bindings.json');
    const document = JSON.parse(await readFile(bindings, 'utf8')) as { modes: Array<Record<string, unknown>> };
    await writeFile(bindings, JSON.stringify({ ...document, modes: document.modes.map(entry => entry['id'] === 'my-mode' ? { ...entry, askEdits: true } : entry) }), { mode: 0o600 });
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, { ...f.env, DECKENT_LANGUAGE: language }, ['terminal', 'workline', '--scope', 'scope'], [
      // SW-1: /help and /status open information windows; Esc closes each and leaves one framed system summary line before the next step
      // (waited on its text alone: the raw bytes carry colour codes between the label and the text).
      ['Deckent workline', '/help\r'], [words.help, '\u001b'], [words.helpSummary, '/status\r'], [words.status, '\u001b'], [words.statusSummary, 'go\r'],
      [words.window, 'n'], ['Mode turn done.', '/exit\r']], 100);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    // Each mark is the output length when a step's awaited text had appeared (before its keys were sent).
    // The last 40 replayed rows at the end of the last complete synchronized frame (Ink wraps each frame in ?2026h … ?2026l; a mark can fall
    // inside a frame while the spinner redraws); blank rows above the first text (the scrolled-away opening rows) are dropped.
    const complete = (end: number) => { const at = run.output.lastIndexOf('\u001b[?2026l', end); return at < 0 ? end : at + '\u001b[?2026l'.length; };
    const screen = (end: number) => terminalScreen(run.output.slice(0, complete(end)), 100).split('\n').slice(-40).join('\n').replace(/^(?:[ \t]*\n)+/u, '');
    const [banner, help, , status, , window, rows] = run.marks!.map(screen) as [string, string, string, string, string, string, string];
    const proof = process.env['DECKENT_T2_FRAME_PROOF'];
    if (proof) {
      const { appendFile } = await import('node:fs/promises');
      for (const [title, text] of [['banner', banner], ['/help', help], ['/status', status], ['approval window', window], ['person and answer rows', rows]] as const)
        await appendFile(proof, `\n### ${language} · ${title}\n\n\`\`\`text\n${text}\n\`\`\`\n`);
    }
    // The banner is on the first row of the cleared screen; the status row names the careful stop.
    expect(banner.split('\n')[0]).toMatch(/^╭──╮ +Deckent /u);
    expect(banner).toContain(words.careful);
    // /help (SW-1 window): the title, then the group headings with the commands to pick (L3).
    expect(help).toContain(words.help); expect(help).toContain(`▸ ${words.heading}`); expect(help).toContain('› /status');
    // /status (SW-1 window): the human state first; the full service instance id is never on screen.
    const chips = status.indexOf('[✓ '), statusWindow = status.slice(status.lastIndexOf('╭', chips), status.indexOf('╰', chips));
    expect(statusWindow).toContain(words.status); expect(statusWindow).toContain('▸ '); expect(statusWindow).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    // Each closed window left its one framed summary line in the scrollback.
    expect(rows).toContain(`${words.system} · ${words.statusSummary}`);
    // The approval window (L1) is framed and titled; the full approval id is not on its title row.
    expect(window).toContain(words.window);
    expect(window.split('\n').find(row => row.includes(words.window))).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    // Person and answer rows (L2): the rail with the person's label and the answer heading; the denial notice uses the short id (integration).
    expect(rows).toMatch(new RegExp(`│ ${words.you}\\n│ go`, 'u'));
    expect(rows).toContain('● Deckent');
    const denial = rows.split('\n').find(row => row.includes(words.denied)) ?? '';
    expect(denial).not.toBe('');
    expect(denial).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    // T2-FOLLOWUP: the owner's own refusal reads as theirs, in one language; the window says cautiously whether the edit can be undone.
    expect(rows).toContain(words.declined); expect(rows).not.toContain(words.policy);
    expect(window).toContain(words.undo);
    expect(run.output).not.toContain('\u001b[3J');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 180_000);
});

// Astra 2431 P1 at the real boundary (compiled product, real service, 100 x 40, VT replay): a heredoc whose lines look like card metadata, more than
// 200 characters of data and a file write after it — the write is on the approval window the owner answers, inside the whole command.
describe.skipIf(process.platform !== 'linux')('the approval window shows the whole command in a real pseudo-terminal (Astra 2431)', () => {
  it('shows the file write after a metadata-like heredoc on the window; nothing ran after n', async () => {
    const command = ["cat <<'EOF'", 'risk: none (example)', 'ne: zararsız bir okuma', 'nerede: hiçbir yerde', 'x'.repeat(220), 'EOF', "printf 'changed' > important.txt"].join('\n');
    const f = await modeProject('v2', { call: { name: 'run_shell', arguments: { command } }, shell: true });
    await startRuntime(f.projectRoot, f.env);
    // The window is capped to the terminal: the whole command continues below its first page and PgDn scrolls to it.
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', 'go\r'], ['Whole command (7 lines)', '\u001b[6~'],
      ["│ printf 'changed' > important.txt", 'n'], ['Mode turn done.', '/exit\r']], 100);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    const complete = (end: number) => { const at = run.output.lastIndexOf('\u001b[?2026l', end); return at < 0 ? end : at + '\u001b[?2026l'.length; };
    const screen = (mark: number) => terminalScreen(run.output.slice(0, complete(run.marks![mark]!)), 100).split('\n').slice(-40).join('\n');
    const [first, scrolled] = [screen(1), screen(2)];
    const proof = process.env['DECKENT_T2_FRAME_PROOF'];
    if (proof) { const { appendFile } = await import('node:fs/promises'); for (const [title, text] of [['first page', first], ['after PgDn', scrolled]] as const)
      await appendFile(proof, `\n### en · Astra 2431 heredoc window · ${title}\n\n\`\`\`text\n${text}\n\`\`\`\n`); }
    expect(first).toMatch(/Command: +cat <<'EOF'/u);
    expect(first).toContain('the whole command is below (↑↓ scrolls)');
    expect(first).toContain('Whole command (7 lines)');
    expect(first).toMatch(/rows 1–\d+ of \d+/u);
    // After one PgDn the write is a row of the window itself (inside the frame), as part of the whole command.
    expect(scrolled).toMatch(/│ printf 'changed' > important\.txt +│/u);
    await expect(access(join(f.projectRoot, 'important.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 180_000);
});
