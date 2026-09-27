import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

// T-L4 slice 4c at the real boundary: compiled CLI in a real pseudo-terminal, a real runtime service process (protocol v15), the
// company policy (v2) and the person's bindings as real layout files. `/mode` shows the mode, `/mode auto-edit` changes it through the
// service (the terminal touches no file), the next turn's eligible edit runs without a card and is audited, and a narrow terminal
// drops the mode segment from the status row.
const execute = promisify(execFile);
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
async function modeProject() {
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
      const call = requests++ % 2 === 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end((call ? [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' }) } }] }), chunk({}, 'tool_calls'), usage]
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
    terminal: { autostartService: false, chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 } },
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
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: 'p1', roles: [], separationOfDuties: [], restrictions: [], grants: [
    grant('invoke', 'allow', ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], 'model-invocation', [modelInvocationTargetId(reference)]),
    grant('scope', 'allow', ['inspect'], 'scope', ['scope']), grant('decide', 'allow', ['inspect', 'decide'], 'approval', 'all'),
    grant('edit-tools', 'require-approval', ['invoke'], 'agent-tool', ['edit_file', 'write_file'], { modeEligible: true }),
    grant('file-write', 'allow', ['execute'], 'operation', ['workspace.file.write']),
    grant('mode-set', 'allow', ['set'], 'permission-mode', ['ask', 'auto-edit', 'full-auto'])] }), { mode: 0o600 });
  const theirs = { id: 'their-mode', principal: { issuer: 'another-host', subject: '4242' }, scopes: ['scope'], mode: 'full-auto' };
  await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [], modes: [theirs] }), { mode: 0o600 });
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
      ['/mode · ask', '/mode auto-edit\r'],
      ['/mode · ask → auto-edit', 'go\r'],
      ['Mode turn done.', '/exit\r'],
    ]);
    expect(wide.timeout, wide.output).toBeUndefined();
    expect(wide.status, wide.output).toBe(0);
    expect(wide.output).not.toContain('Unknown command');
    // No approval card for the eligible edit in auto-edit; the file changed and the mode's decision was audited.
    expect(wide.output).not.toContain('Approval requested');
    expect(await readFile(join(f.projectRoot, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    const file = JSON.parse(await readFile(join(f.data, 'bindings.json'), 'utf8')) as { revision: string; modes: Array<{ principal: unknown; mode: string }> };
    expect((await stat(join(f.data, 'bindings.json'), { bigint: true })).ino).not.toBe(before.ino);
    expect(file.revision).toMatch(/^m-[0-9a-f]{40}$/u);
    expect(file.modes).toEqual([f.theirs, expect.objectContaining({ principal: f.me, scopes: ['scope'], mode: 'auto-edit' })]);
    expect(f.audit().map(row => (row as { kind: string }).kind)).toEqual(['permission-mode-change', 'permission-mode']);
    // After the change the status row carries the mode on a wide terminal: more occurrences than the one notice line.
    const after = wide.output.slice(wide.output.indexOf('/mode · ask → auto-edit'));
    expect(after.split('auto-edit').length - 1).toBeGreaterThan(1);
    // Narrow: the mode is shown once by `/mode` (the notice) and never in the status row.
    const narrow = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [['Deckent workline', '/mode\r'], ['/mode · auto-edit', '/exit\r']], 30);
    expect(narrow.timeout, narrow.output).toBeUndefined();
    expect(narrow.status, narrow.output).toBe(0);
    expect(narrow.output.split('auto-edit').length - 1).toBe(1);
  }, 180_000);
});
