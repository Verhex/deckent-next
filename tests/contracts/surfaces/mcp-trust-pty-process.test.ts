import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

// MCP-CLIENT at the real boundary (owner 2026-09-28): compiled CLI in a real pseudo-terminal, a real runtime service process, a real policy
// file and a project `.deckent/mcp.json` nobody decided on. The first message opens the launch card, then (after y, the server started) the
// tools card; after y the model is offered the pinned tool in the same turn; `/mcp` lists the server as trusted.
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js'), FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
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

/** python3 `pty` driver (as in terminal-mode-pty-process). */
const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
argv, steps, columns = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, columns, 0, 0))
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
async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>, columns = 160) {
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

async function mcpProject() {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const tools = join(root, 'tools.json'), log = join(root, 'log.jsonl');
  writeFileSync(tools, JSON.stringify([{ name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: {} } }])); appendFileSync(log, '');
  writeFileSync(join(projectRoot, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { fx: { command: process.execPath,
    args: [FIXTURE, '--mode', 'legacy', '--tools', tools, '--log', log], realm: 'host' } } }));
  const seen = { tools: [] as string[][] };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'mcp-pty', object: 'chat.completion.chunk',
    created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'mcp-pty', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', part => body.push(part));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(body).toString('utf8')) as { tools?: { function: { name: string } }[] };
      seen.tools.push((request.tools ?? []).map(tool => tool.function.name));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([chunk({ role: 'assistant', content: 'Trusted turn done.' }), chunk({}, 'stop'), usage].join('') + 'data: [DONE]\n\n');
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
  const grant = (id: string, effect: string, actions: string[], kind: string, ids: string[] | 'all') => ({ id, effect, actions, scopes: ['scope'], principals: [me], resource: { kind, ids } });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    grant('invoke', 'allow', ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], 'model-invocation', [modelInvocationTargetId(reference)]),
    grant('scope', 'allow', ['inspect'], 'scope', ['scope']), grant('decide', 'allow', ['inspect', 'decide'], 'approval', 'all'),
    grant('mcp-tool', 'allow', ['invoke'], 'mcp-server', ['fx']), grant('mcp-run', 'allow', ['execute'], 'operation', ['mcp.tool.call'])] }), { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  const started = () => readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"start"')).length;
  return { projectRoot, data, env, seen, ledger, started };
}

describe.skipIf(process.platform !== 'linux')('MCP first-use trust card and /mcp in a real pseudo-terminal (MCP-CLIENT)', () => {
  it('the first message asks to start the project server, then to trust its tools; after y the tool is offered in that turn and /mcp lists it trusted', async () => {
    const f = await mcpProject();
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      ['Deckent workline', 'hello\r'],
      ['mcp_trust · mcp:fx · launch', 'y'],
      ['mcp_trust · mcp:fx · tools', 'y'],
      ['Trusted turn done.', '/mcp list\r'], // T3 L4: a bare /mcp is the window; `list` keeps the text list
      ['fx · project · trusted · 1 tool', '/exit\r'],
    ]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('MCP server fx (project scope'); expect(run.output).toContain('start it?');
    expect(run.output).toContain('trust it and pin these tools?'); expect(run.output).toContain('echo');
    expect(run.output).toMatch(/fx · project · trusted/u);
    expect(f.seen.tools[0]).toContain('mcp__fx__echo');
    expect(f.started()).toBeGreaterThan(0);
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      const subjects = db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String((row as { record: string }).record)) as
        { event: { subject: Record<string, unknown> } }).event.subject);
      expect(subjects).toEqual([expect.objectContaining({ kind: 'mcp-trust', action: 'trust', scope: 'project', server: 'fx' })]);
    } finally { db.close(); }
  }, 180_000);
});
