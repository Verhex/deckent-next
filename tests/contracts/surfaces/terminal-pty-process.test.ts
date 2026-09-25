import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createPricedProviderTls, fixtureBudget } from '../../fixtures/priced-provider.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [], servers: Server[] = [], runtimes: ChildProcess[] = [], daemons: number[] = [];
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  // Background services started by the terminal are stopped here; the test proves they outlive the terminal.
  for (const pid of daemons.splice(0)) {
    if (alive(pid)) process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 20_000;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
  for (const child of runtimes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  }
  clearConfigCache();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * A real pseudo-terminal (python3 `pty`, POSIX only): the built executable sees TTY stdin/stdout, raw keys and a window
 * size. Each step waits for text on the terminal before typing, with a hard deadline per step.
 */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
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
    read_for(0.3)  # let the view settle (raw mode, input subscription) before typing
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

async function project(config: Record<string, unknown> = {}) {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true }), mkdir(home, { recursive: true })]);
  // These cases exercise the view without a service; automatic service start has its own case.
  await writeFile(join(projectRoot, '.deckent', 'config.json'), JSON.stringify({ terminal: { autostartService: false }, ...config }));
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  return { projectRoot, env };
}

async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>) {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)],
    { cwd, env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
}

async function startRuntime(projectRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimes.push(child);
  let stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RUNTIME_READY_TIMEOUT:${stderr.slice(-800)}`)), 20_000);
    const failed = () => { clearTimeout(timer); reject(new Error(`RUNTIME_START_FAILED:${stderr.slice(-800)}`)); };
    child.once('error', failed);
    child.once('exit', failed);
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          if ((JSON.parse(line) as { event?: string }).event === 'ready') {
            clearTimeout(timer);
            child.off('error', failed);
            child.off('exit', failed);
            resolve();
          }
        } catch { /* The ready line is JSON. */ }
      }
    });
  });
}

/** Local priced OpenAI fixture and a governed activation. No external network. */
async function governedChat() {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-governed-'));
  roots.push(root);
  const projectRoot = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const tls = await createPricedProviderTls(root);
  const server = createServer({ key: tls.key, cert: tls.caPem }, (request, reply) => {
    if (request.url !== '/chat' || request.method !== 'POST') { reply.writeHead(404); reply.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const streamed = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }).stream === true;
      if (streamed) {
        // The interactive terminal streams (S-STREAM): reasoning, then the answer in two pieces, finish, usage, [DONE] (vLLM shape).
        const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
          `data: ${JSON.stringify({ id: 'pty', object: 'chat.completion.chunk', created: 1, model: 'vendor/model', choices, ...extra })}\n\n`;
        reply.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.end([chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
          chunk([{ index: 0, delta: { reasoning: 'thinking' }, finish_reason: null }]),
          chunk([{ index: 0, delta: { content: 'pty-' }, finish_reason: null }]),
          chunk([{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]),
          chunk([], { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), 'data: [DONE]\n\n'].join(''));
        return;
      }
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ id: 'pty', object: 'chat.completion', created: 1, model: 'vendor/model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pty-ok', refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const origin = `https://127.0.0.1:${address.port}`;
  const reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-pty', providers: [{ id: 'openrouter', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'openrouter', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const zero = { kind: 'operator-static' as const, version: 1 as const, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `${origin}/chat`, maxOutputTokens: 8, authentication: { type: 'none' }, tls: { caPem: tls.caPem }, tariff: zero } },
    allocation: { id: 'allocation', maxCalls: 4, maxInFlight: 2 }, limits: { requestMaxBytes: 8192, responseMaxBytes: 8192, timeoutMs: 5_000 } };
  await writeFile(join(projectRoot, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget('scope'),
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 8 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'cancel-invocation'], scopes: ['scope'],
      principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
  ] }), { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  return { projectRoot, env };
}

describe.skipIf(process.platform === 'win32')('deckent terminal in a real pseudo-terminal', () => {
  it('renders the workline, routes /workers through policy, surfaces a typed chat block and exits on /exit', async () => {
    const f = await project();
    const result = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'pty-scope'], [
      ['Deckent workline', '/workers\r'],
      ['POLICY_UNAVAILABLE', 'hello\r'],
      ['TERMINAL_CHAT_NOT_CONFIGURED', '/nope\r'],
      ['Unknown command: /nope', '/exit\r'],
    ]);
    expect(result.timeout, result.output).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output).toContain('pty-scope');
    const colour = new RegExp(`${String.fromCharCode(27)}\\[(3[0-7]|9[0-7]|38;)`);
    expect(result.output).not.toMatch(colour);
  });

  it('arms exit on the first idle Ctrl+C and exits on the second in a real terminal', async () => {
    const f = await project();
    const result = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'pty-scope'],
      [['Deckent workline', '\u0003'], ['Press Ctrl+C again to exit', '\u0003']]);
    expect(result.timeout, result.output).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('exits 0 after a successful governed chat turn', async () => {
    const f = await governedChat();
    await startRuntime(f.projectRoot, f.env);
    const result = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      ['Deckent workline', 'hello\r'],
      ['pty-ok', '/exit\r'],
    ]);
    expect(result.timeout, result.output).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('pty-ok');
  });

  it('`deckent` alone opens the terminal, starts the runtime service in the background and leaves it running for the next terminal', async () => {
    const f = await governedChat();
    const configPath = join(f.projectRoot, '.deckent/config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { terminal: Record<string, unknown>; layout: { root: string } };
    // An upgraded install: identity + shutdown grant configured, and the ledger still at the previous schema version.
    await writeFile(configPath, JSON.stringify({ ...config, terminal: { ...config.terminal, scopeId: 'scope' },
      service: { identity: { scopeId: 'scope', serviceId: 'local' } } }), { mode: 0o600 });
    const policyPath = join(config.layout.root, 'policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: Array<{ principals: unknown }> };
    await writeFile(policyPath, JSON.stringify({ ...policy, grants: [...policy.grants, { id: 'stop', effect: 'allow', actions: ['shutdown'], scopes: ['scope'],
      principals: policy.grants[0]!.principals, resource: { kind: 'service', ids: ['local'] } }] }), { mode: 0o600 });
    const ledgerPath = join(config.layout.root, 'state/ledger.db');
    const ledger = new DatabaseSync(ledgerPath); ledger.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); ledger.close();
    const first = await inPty(f.projectRoot, f.env, [], [['started in the background', 'hello\r'], ['pty-ok', '/exit\r']]);
    // Register the background service for cleanup before any assertion can fail.
    const pid = Number(/\(pid (\d+),/.exec(first.output)?.[1]);
    if (Number.isSafeInteger(pid) && pid > 0) daemons.push(pid);
    expect(first.output).toContain('deckent runtime shutdown');
    const log = await readFile(join(config.layout.root, 'state/runtime-service.log'), 'utf8');
    expect(log).toContain(`Ledger upgraded from schema ${CURRENT_LEDGER_VERSION - 1} to ${CURRENT_LEDGER_VERSION}`);
    expect(first.timeout, first.output).toBeUndefined();
    expect(first.status, first.output).toBe(0);
    expect(Number.isSafeInteger(pid) && pid > 0, first.output).toBe(true);
    // The service outlives the terminal and answers other commands.
    const described = await execute(process.execPath, [cli, 'runtime', 'describe', '--json'], { cwd: f.projectRoot, env: f.env, timeout: 20_000 });
    expect(JSON.parse(described.stdout)).toMatchObject({ instanceId: expect.any(String) });
    const second = await inPty(f.projectRoot, f.env, [], [['Runtime service connected', '/exit\r']]);
    expect(second.timeout, second.output).toBeUndefined();
    expect(second.status, second.output).toBe(0);
    expect(second.output).not.toContain('started in the background');
    // Governed stop without hand-written command fields; the endpoint stops answering and the process exits.
    await execute(process.execPath, [cli, 'runtime', 'shutdown', '--json'], { cwd: f.projectRoot, env: f.env, timeout: 20_000 });
    const deadline = Date.now() + 20_000;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(false);
    await expect(execute(process.execPath, [cli, 'runtime', 'describe', '--json'], { cwd: f.projectRoot, env: f.env, timeout: 20_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('LOCAL_RUNTIME_UNAVAILABLE') });
  });

  it('degrades when piped: the rich view refuses with a typed usage error, line mode runs', async () => {
    const f = await project();
    const piped = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, 'terminal', 'workline', '--scope', 's'], { cwd: f.projectRoot, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolvePromise({ code, stderr, stdout })); child.stdin.end();
    });
    expect(piped.code).toBe(2); expect(piped.stderr).toContain('TERMINAL_TTY_REQUIRED'); expect(piped.stdout).toBe('');
    const line = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, 'terminal', 'session', '--scope', 's'], { cwd: f.projectRoot, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolvePromise({ code, stderr, stdout })); child.stdin.end('hello\n');
    });
    expect(line.code).toBe(0); expect(`${line.stdout}${line.stderr}`).toContain('TERMINAL_CHAT_NOT_CONFIGURED');
  });
});
