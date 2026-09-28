import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, probeShellCapabilities, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

// SCR-A at the real boundary: compiled CLI in a real pseudo-terminal, a real runtime service process (protocol v16), a real policy file.
// Ask mode (no permission-mode entry): the agent writes to its scratch area without a card (policy allows the scratch tools and
// `workspace.scratch.write`), the shell writes to $TMPDIR after the owner's `y` (a variable expansion always asks), and `/scratch`
// lists, names and empties the conversation's area through the service. The model learns the area only from the system prompt.
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const roots: string[] = [], servers: Server[] = [], runtimes: ChildProcess[] = [];
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
// S9: what the service process measures on this host decides whether the shell call below ran in the bubblewrap realm.
const measured = await probeShellCapabilities();
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

/** A local model that reads the scratch area from its system prompt, writes a plan there, asks the shell to write to $TMPDIR, then answers. */
async function scratchProject() {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-scratch-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(projectRoot, 'src'), { recursive: true }),
    mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  const seen = { scratch: [] as string[], requests: 0 };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'scratch-pty', object: 'chat.completion.chunk',
    created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'scratch-pty', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const toolCall = (name: string, args: unknown) => [chunk({ role: 'assistant', content: '' }),
    chunk({ tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls'), usage];
  const server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', part => body.push(part));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages: { role: string; content: string }[] };
      const area = /Scratch area: (\/\S+?)\. Your own/u.exec(request.messages[0]?.content ?? '')?.[1];
      if (area) seen.scratch.push(area);
      const step = seen.requests++ % 3;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end((step === 0 ? toolCall('scratch_write', { path: 'plan.md', content: '# plan\n' })
        : step === 1 ? toolCall('run_shell', { command: 'touch "$TMPDIR/from-shell.txt"' })
          : [chunk({ role: 'assistant', content: 'Scratch turn done.' }), chunk({}, 'stop'), usage]).join('') + 'data: [DONE]\n\n');
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
  const grant = (id: string, effect: string, actions: string[], kind: string, ids: string[] | 'all') => ({ id, effect, actions, scopes: ['scope'], principals: [me], resource: { kind, ids } });
  // The installation grants the scratch tools and their operation (the first-run template's job, SCR-B); the shell is allowed but its
  // tiers still ask for anything beyond a bounded read.
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    grant('invoke', 'allow', ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], 'model-invocation', [modelInvocationTargetId(reference)]),
    grant('scope', 'allow', ['inspect'], 'scope', ['scope']), grant('decide', 'allow', ['inspect', 'decide'], 'approval', 'all'),
    grant('scratch-tools', 'allow', ['invoke'], 'agent-tool', ['scratch_write', 'scratch_read', 'scratch_list']),
    grant('scratch-write', 'allow', ['execute'], 'operation', ['workspace.scratch.write']),
    grant('shell-tool', 'allow', ['invoke'], 'agent-tool', ['run_shell']), grant('shell-run', 'allow', ['execute'], 'operation', ['host.shell.run'])] }), { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  return { projectRoot, data, env, seen };
}

describe.skipIf(process.platform !== 'linux')('/scratch in a real pseudo-terminal against a real runtime service (SCR-A)', () => {
  it('writes to the scratch area without a card in ask mode, lets the shell write to $TMPDIR after y, and lists, names and clears the area', async () => {
    const f = await scratchProject();
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      ['Deckent workline', 'keep notes in scratch\r'],
      ['touch "$TMPDIR/from-shell.txt"', 'y'],
      ['Scratch turn done.', '/scratch\r'],
      ['from-shell.txt ·', '/scratch path\r'],
      ['/scratch · /', '/scratch clear\r'],
      ['2 files', '/scratch\r'],
      ['· empty', '/exit\r'],
    ]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('Unknown command');
    // S9: the default realm is prefer-sandbox; on a host with bubblewrap the shell ran sandboxed, so no fallback notice reached the terminal.
    if (measured.bubblewrap === 'available' && measured.userNamespace === 'available') expect(run.output).not.toContain('sandbox: none');
    // The model saw one area for the whole turn; the listing named both files, then the area was emptied (the directory stays).
    expect(new Set(f.seen.scratch).size).toBe(1);
    const area = f.seen.scratch[0]!;
    expect(area.startsWith(join(f.data, 'state', 'scratch'))).toBe(true);
    expect(run.output).toContain('plan.md · 7 bytes'); expect(run.output).toContain('from-shell.txt · 0 bytes');
    // The terminal wraps long lines: the notice and the path are checked apart.
    expect(run.output).toContain(`/scratch · ${area}`); expect(run.output).toContain('/scratch clear · 2 files (7 bytes) removed ·');
    expect(run.output.split(area).length - 1).toBeGreaterThanOrEqual(3);
    expect(await readdir(area)).toEqual([]);
    // The only card was the shell command's; a card for the scratch write would show its diff.
    expect(run.output).toContain('Approval requested'); expect(run.output).not.toContain('+++ b/plan.md');
  }, 180_000);
});
