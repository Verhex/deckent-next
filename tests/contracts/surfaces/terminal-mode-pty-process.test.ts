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

// T-L4 slice 4c (MODES-3: v17, three modes) at the real boundary: compiled CLI in a real pseudo-terminal, a real runtime service process,
// the company policy (v2) and the person's bindings as real layout files. `/mode` shows the mode, `/mode full-auto` changes it through the
// service (the terminal touches no file), the next turn's eligible edit runs without a card and is audited, and a narrow terminal drops the
// mode segment from the status row. Full access opens only at launch, on the company grant, with a standing warning.
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
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps, columns = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, columns, 0, 0))
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
    deadline = time.time() + 25
    while wait.encode() not in out:
        if time.time() > deadline or not read_for(0.1):
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace')})); sys.exit(3)
    read_for(0.5)
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.01)
deadline = time.time() + 25
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
async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>, columns = 120) {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), String(columns)],
    { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
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
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
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
      ['Deckent workline', '/mode\r'],
      ['Permission mode: standart', '/mode full-auto\r'],
      ['Permission mode: standart → full-auto', 'go\r'],
      ['Mode turn done.', '/exit\r'],
    ]);
    expect(wide.timeout, wide.output).toBeUndefined();
    expect(wide.status, wide.output).toBe(0);
    expect(wide.output).not.toContain('Unknown command');
    // No approval card for the eligible edit in full-auto; the file changed and the mode's decision was audited.
    expect(wide.output).not.toContain('Approval requested');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    const file = JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { schemaVersion: number; revision: string; modes: Array<{ principal: unknown; mode: string }> };
    expect((await stat(join(f.data, 'bindings.json'), { bigint: true })).ino).not.toBe(before.ino);
    expect(file.revision).toMatch(/^m-[0-9a-f]{40}$/u);
    expect(file.schemaVersion).toBe(3);
    expect(file.modes).toEqual([f.theirs, expect.objectContaining({ principal: f.me, scopes: ['scope'], mode: 'full-auto' })]);
    expect(f.audit().map(row => (row as { kind: string }).kind)).toEqual(['permission-mode-change', 'permission-mode']);
    // After the change the status row carries the mode on a wide terminal: more occurrences than the one notice line.
    const after = wide.output.slice(wide.output.indexOf('Permission mode: standart → full-auto'));
    expect(after.split('full-auto').length - 1).toBeGreaterThan(1);
    // Narrow: the mode is shown once by `/mode` (the notice) and never in the status row.
    const narrow = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode\r'], ['full-auto', '/exit\r']], 30);
    expect(narrow.timeout, narrow.output).toBeUndefined();
    expect(narrow.status, narrow.output).toBe(0);
    expect(narrow.output.split('full-auto').length - 1).toBe(1);
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
    expect(run.output).not.toContain('Approval requested');
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
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode\r'], ['Switch:', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    const text = modeLines(run.output);
    expect(text).toContain('Permission mode: standart — reads, scratch and the in-project edits the company marked mode-eligible run without a card');
    expect(text).toContain('/mode full-auto (standart plus narrow mutating shell commands');
    expect(text).toContain('Full access starts only at launch');
    expect(text).not.toContain('/mode standart (');
    expect(text).not.toContain('/mode full-access (');
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

// MODES-3 (owner 2026-09-29): full access opens only at launch (`deckent --full-access`, `deckent terminal --full-access`, or the person's stored
// start mode), only on the company grant; the status row keeps a `full-access` segment at any width and the first message warns; `/mode
// full-access` inside a session is refused without asking the service; every call is audited.
describe.skipIf(process.platform !== 'linux')('full access in a real pseudo-terminal (MODES-3)', () => {
  const plain = (output: string) => stripVTControlCharacters(output).replace(/\s+/gu, ' ');
  const kinds = (f: Awaited<ReturnType<typeof modeProject>>) => f.audit().map(row => (row as { kind: string }).kind);

  it('`deckent terminal --full-access` warns, keeps the segment, refuses an in-session switch and audits the turn and its call', async () => {
    const f = await modeProject();
    await startRuntime(f.projectRoot, f.env);
    const before = await readFile(join(f.data, 'bindings.json'), 'utf8');
    const run = await inPty(f.projectRoot, f.env, ['terminal', '--full-access'], [['Deckent workline', '/mode full-access\r'],
      ['Full access starts only at launch', 'go\r'], ['Mode turn done.', '/exit\r']]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    const text = plain(run.output);
    expect(text).toContain('FULL ACCESS is on');
    expect(text).toContain('full-access');
    expect(text).not.toContain('Approval requested');
    expect(await readFile(join(f.data, 'bindings.json'), 'utf8')).toBe(before);
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(kinds(f)).toEqual(['full-access-turn', 'full-access-call']);
    // On a 30-column terminal the full-access segment is not dropped (the other modes are).
    const narrow = await inPty(f.projectRoot, f.env, ['terminal', '--full-access'], [['full-access', '/exit\r']], 30);
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
