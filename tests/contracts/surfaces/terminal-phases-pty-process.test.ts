import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, modelInvocationTargetId } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';

// TL-A (D1 + D5 + D6) at the real boundary: the compiled CLI in a real pseudo-terminal against a real runtime service process
// (protocol v15, unchanged). A turn that compacts shows "summarizing" with a live counter; Esc names the stopped part; a summary
// stopped halfway is redone by the next turn, a finished one is kept (the provider's summary calls are counted); the reasoning
// preview shows sanitized text and `/reasoning off` hides it. Protocol v16 (OPEN-REASONING-FILE): `/reasoning off` also turns the model's
// thinking off for the following rounds of a model that declares the switch; a model without it refuses such a turn by name.
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

/** python3 `pty` driver (as in terminal-mode-pty-process): each step waits for text, then types. */
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
    read_for(0.3)
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
async function inPty(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: ReadonlyArray<readonly [string, string]>) {
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)],
    { cwd, env, timeout: 170_000, maxBuffer: 32 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
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

const SUMMARY = '{"objective":"talk","findings":["q1 was answered"],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}';
/**
 * A local model with a token counter and a 20k window: ten or more messages count 16k tokens (past the high-water mark), a compacted
 * history 900. The first summary call never answers (it is cancelled); the second answers after 2.5 s. Rounds answer by the last user
 * message: `q1`..`q4` at once, `q6` streams reasoning (with escape sequences) and then waits, `q7`/`q8` reason, then answer.
 */
async function phasesProject(thinkingSwitch = true) {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-phases-pty-')); roots.push(root);
  const projectRoot = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(projectRoot, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const calls = { summary: 0, rounds: [] as string[], thinking: [] as unknown[] };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'phases', object: 'chat.completion.chunk',
    created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  // Every round reports usage, so its spending reservation settles (without it the allocation stays held).
  const usage = `data: ${JSON.stringify({ id: 'phases', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const later = (ms: number, then: () => void) => { setTimeout(then, ms); };
  const server = createServer((req, res) => {
    const body: Buffer[] = []; req.on('data', part => body.push(part));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages: Array<{ role: string; content?: string }>; stream?: boolean;
        chat_template_kwargs?: unknown };
      if (req.url === '/tokenize') {
        const compacted = parsed.messages.some(message => typeof message.content === 'string' && message.content.includes('[Deckent context summary'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ count: !compacted && parsed.messages.length >= 10 ? 16_000 : 900, max_model_len: 131072, tokens: [] })); return;
      }
      if (parsed.stream === false) {
        // The first summary never answers: it is cancelled. The second one answers after 2.5 s.
        if (++calls.summary === 1) return;
        later(2_500, () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'sum', object: 'chat.completion', created: 1, model: 'native-chat',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: SUMMARY } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        });
        return;
      }
      const asked = [...parsed.messages].reverse().find(message => message.role === 'user')?.content ?? '';
      calls.rounds.push(asked); calls.thinking.push(parsed.chat_template_kwargs ?? null);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const quick = /^q([1-4])$/u.exec(asked);
      if (quick) { res.end(`${chunk({ role: 'assistant', content: `ANSWER-${quick[1]}` })}${chunk({}, 'stop')}${usage}data: [DONE]\n\n`); return; }
      if (asked === 'q6') {
        res.write(chunk({ role: 'assistant', reasoning_content: 'PREVIEW-6 weighing the files\n' }));
        later(300, () => res.write(chunk({ reasoning_content: 'second \u001b[31mRED\u001b[0m\u001b]0;PWNED\u0007 line\n' })));
        return;
      }
      const turn = asked === 'q7' ? '7' : '8';
      res.write(chunk({ role: 'assistant', reasoning_content: `PREVIEW-${turn} reading\n` }));
      later(1_500, () => res.end(`${chunk({ content: `Answer ${turn === '7' ? 'seven' : 'eight'}.` })}${chunk({}, 'stop')}${usage}data: [DONE]\n\n`));
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
  const model = { id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
    capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }, { id: 'token-count', version: 1, state: 'supported' },
      ...(thinkingSwitch ? [{ id: 'chat-template-enable-thinking', version: 1, state: 'supported' }] : [])] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'local-openai', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, tokenizeEndpoint: `http://127.0.0.1:${address.port}/tokenize`,
        maxOutputTokens: 256, authentication: { type: 'none' }, tariff } },
    // Two cancelled calls (outcome unknown) keep their allocation slots in flight; eight slots leave room for the turns after them.
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 8 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 30_000 },
    contextWindowTokens: 20_000 };
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
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: [me],
      resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [me], resource: { kind: 'scope', ids: ['scope'] } }] }), { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global'),
    DECKENT_LANGUAGE: 'en', TERM: 'xterm-256color', NO_COLOR: '1' };
  return { projectRoot, env, calls };
}

describe.skipIf(process.platform !== 'linux')('turn phases in a real pseudo-terminal against a real runtime service (TL-A)', () => {
  it('shows summarizing with a live counter, names the part Esc stopped, keeps a finished summary, and previews reasoning until /reasoning off', async () => {
    const f = await phasesProject();
    await startRuntime(f.projectRoot, f.env);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      ['Deckent workline', 'q1\r'], ['ANSWER-1', 'q2\r'], ['ANSWER-2', 'q3\r'], ['ANSWER-3', 'q4\r'], ['ANSWER-4', 'q5\r'],
      // q5 compacts; its summary never answers: the live counter runs, then Esc stops it mid-summary.
      ['summarizing earlier messages · 1s', '\u001b'],
      ['cancelled (summarizing)', 'q6\r'],
      // q6 compacts again (the stopped summary left nothing), this time it lands; the model then reasons and waits: Esc.
      ['RED line', '\u001b'],
      ['cancelled (model response)', 'q7\r'],
      // SLASH-WINDOWS: `/reasoning` opens its picker (no typed `off`); the second row is "Model thinking off", and the status strip then says so.
      ['Answer seven.', '/reasoning\r'],
      ['Model thinking off', '\u001b[B\r'],
      ['reasoning off', 'q8\r'],
      ['Answer eight.', '/exit\r'],
    ]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    const out = run.output;
    // D1: the silent phases are named, with live seconds; the status row offers Esc while a turn runs.
    expect(out).toMatch(/model is preparing a response · \d+s/u);
    // The first summary's wait step already proved the counter advances (· 1s); the second (2.5 s) is seen counting too.
    expect(out).toMatch(/summarizing earlier messages · [12]s/u);
    expect(out).toMatch(/Working… · Esc cancels/u);
    // D5: the stopped summary is explained; the finished one replaced the history once.
    expect(out).toContain('Summarizing was cancelled before it finished');
    expect(out).toContain('earlier messages were summarized to fit the context window');
    // Summary calls: the one Esc stopped, the one that landed; q7 and q8 start from the compacted history and never summarize again.
    expect(f.calls.summary).toBe(2);
    expect(f.calls.rounds).toEqual(['q1', 'q2', 'q3', 'q4', 'q6', 'q7', 'q8']);
    // D6: the preview shows the reasoning, sanitized (no colour, no window title), and nothing of it after `/reasoning off`.
    expect(out).toContain('PREVIEW-6 weighing the files'); expect(out).toContain('second RED line'); expect(out).toContain('PREVIEW-7 reading');
    expect(out).not.toContain('\u001b[31m'); expect(out).not.toContain('PWNED');
    expect(out).not.toContain('PREVIEW-8');
    // v16: the same `/reasoning off` asked the service to turn thinking off; only the round after it carries the switch.
    expect(out).toMatch(/reasoning off/u);
    expect(f.calls.thinking).toEqual([null, null, null, null, null, null, { enable_thinking: false }]);
  }, 180_000);

  it('refuses an unsupported thinking-off turn before sending, hides that choice in the real picker and continues with thinking on', async () => {
    const f = await phasesProject(false);
    await startRuntime(f.projectRoot, f.env);
    // The current picker filters unavailable capabilities. Keep the typed service refusal, independently of that UI prevention.
    await expect(createConfiguredRuntimeClient(f.projectRoot, { env: f.env }).chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'unsupported-off',
      messages: [{ role: 'user', content: 'q2' }], reasoning: 'off' }, () => undefined)).rejects.toMatchObject({ code: 'AGENT_TURN_REASONING_UNSUPPORTED' });
    expect(f.calls.rounds).toEqual([]);
    const run = await inPty(f.projectRoot, f.env, ['terminal', 'workline', '--scope', 'scope'], [
      ['Deckent workline', 'q1\r'], ['ANSWER-1', '/reasoning\r'], ['Model thinking on', '\r'], ['reasoning on', 'q3\r'],
      ['ANSWER-3', '/exit\r'],
    ]);
    expect(run.timeout, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('Model thinking off');
    // The refused turn never reached the model; the others ran as today (no switch sent).
    expect(f.calls.rounds).toEqual(['q1', 'q3']);
    expect(f.calls.thinking).toEqual([null, null]);
  }, 180_000);
});
