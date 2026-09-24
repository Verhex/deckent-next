// Standalone Node bootstrap mounted read-only. No host package imports at runtime.
import { get, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer, connect, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Worker Event Contract v1 (domain/core/worker-event) produced here, inside the container: this file cannot import host packages,
// so the shapes are mirrored and the host re-validates every event. Redaction happens before any byte leaves the container.
type BridgeEvent = Record<string, unknown> & { kind: string };
const SECRET_PATTERNS = [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\s*[:=]\s*\S+/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g];
/** Removes known secret values and credential-shaped text, strips control characters and bounds the length. */
export function redactText(value: string, secrets: readonly string[], max: number): string {
  let out = value;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
/** Every string leaf of a credential object is a secret value to scrub from worker-reported text. */
export function secretValues(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) secretValues(entry, into);
  return into;
}
const CLAUDE_TOOLS: Readonly<Record<string, string>> = { Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write', Bash: 'shell', BashOutput: 'shell', KillShell: 'shell', KillBash: 'shell', Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'network', WebSearch: 'network', Task: 'agent', Agent: 'agent' };
const IGNORED_SYSTEM = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'hook_progress', 'compact_boundary', 'informational', 'status']);
export interface NormalizerState { sequence: number; readonly startMs: number; cwd: string; readonly usageIds: Set<string>; readonly unmapped: Map<string, number>; readonly secrets: readonly string[] }
export function createNormalizerState(secrets: readonly string[], startMs = Date.now()): NormalizerState {
  return { sequence: 0, startMs, cwd: '/workspace', usageIds: new Set(), unmapped: new Map(), secrets };
}
const num = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function relative(path: unknown, cwd: string): string | null {
  if (typeof path !== 'string' || !path) return null;
  const root = cwd.endsWith('/') ? cwd : cwd + '/';
  if (path.startsWith(root)) return path.slice(root.length).slice(0, 256);
  if (!path.startsWith('/')) return path.slice(0, 256);
  return '(outside-workspace)/' + (path.split('/').pop() ?? '').slice(0, 200);
}
/** Maps one line of Claude Code stream-json onto zero or more contract events. Thinking text and tool output content are never kept. */
export function normalizeClaudeLine(line: string, state: NormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string) => state.unmapped.set(type.slice(0, 64), (state.unmapped.get(type.slice(0, 64)) ?? 0) + 1);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  let data: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { miss('non-object'); return events; } data = parsed as Record<string, unknown>; }
  catch { if (line.trim()) miss('non-json'); return events; }
  const type = typeof data.type === 'string' ? data.type : 'untyped', subtype = typeof data.subtype === 'string' ? data.subtype : '';
  if (type === 'system' && subtype === 'init') {
    if (typeof data.cwd === 'string') state.cwd = data.cwd;
    emit('session.started', { provider: 'claude', model: typeof data.model === 'string' ? data.model.slice(0, 128) : null,
      cliVersion: typeof data.claude_code_version === 'string' ? data.claude_code_version.slice(0, 64) : null });
  } else if (type === 'system') { if (!IGNORED_SYSTEM.has(subtype)) miss(`system:${subtype}`); }
  else if (type === 'assistant') {
    const message = (data.message ?? {}) as Record<string, unknown>;
    const id = typeof message.id === 'string' ? message.id : null, usage = (message.usage ?? null) as Record<string, unknown> | null;
    // All messages of one API response share its id; count their usage once.
    if (id && usage && !state.usageIds.has(id)) {
      state.usageIds.add(id);
      emit('usage', { tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens), thinking: null } });
    }
    for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []) {
      if (block.type === 'text') emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(block.text ?? '')), thinking: false, excerpt: red(block.text, 240) });
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(block.thinking ?? '')), thinking: true, excerpt: '' });
      else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? red(block.name, 64) || 'unknown' : 'unknown', input = (block.input ?? {}) as Record<string, unknown>;
        const toolClass = CLAUDE_TOOLS[name] ?? (name.startsWith('mcp__') ? 'network' : 'other');
        const path = relative(input.file_path ?? input.notebook_path ?? input.path, state.cwd);
        const target = path === null ? null : red(path, 256) || null;
        const detail = toolClass === 'shell' ? red(input.description ?? input.command, 240) : toolClass === 'search' ? red(input.pattern, 240)
          : toolClass === 'network' ? red(typeof input.url === 'string' ? (() => { try { return new URL(input.url).host; } catch { return ''; } })() : input.query, 240)
          : toolClass === 'agent' ? red(input.description, 240) : null;
        emit('tool.call', { toolId: red(block.id, 96), name, toolClass, target, detail: detail || null });
      } else miss(`assistant:${String(block.type ?? 'unknown')}`);
    }
  } else if (type === 'user') {
    const message = (data.message ?? {}) as Record<string, unknown>;
    for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []) {
      if (block.type !== 'tool_result') continue;
      emit('tool.result', { toolId: String(block.tool_use_id ?? '').slice(0, 96), status: block.is_error === true ? 'error' : 'ok',
        bytes: Buffer.byteLength(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')) });
    }
  } else if (type === 'rate_limit_event') {
    const info = (data.rate_limit_info ?? {}) as Record<string, unknown>, windows = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>;
    for (const [window, value] of Object.entries(windows)) {
      const utilization = typeof value.utilization === 'number' ? Math.min(1, Math.max(0, value.utilization)) : null;
      if (utilization !== null) emit('quota', { window: window.slice(0, 32), utilization, resetsAtMs: typeof value.resetsAt === 'number' ? Math.round(value.resetsAt * 1000) : null,
        status: String(info.status ?? 'unknown').slice(0, 32) });
    }
  } else if (type === 'result') {
    const limit = { error_max_turns: 'max-turns', error_max_budget_usd: 'budget', error_max_structured_output_retries: 'structured-output' }[subtype];
    if (limit) emit('limit', { limit, detail: subtype });
    const usage = (data.usage ?? {}) as Record<string, unknown>, details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const models = Object.values((data.modelUsage ?? {}) as Record<string, Record<string, unknown>>);
    emit('session.ended', { outcome: subtype === 'success' && data.is_error !== true ? 'success' : limit ? 'limit' : 'error', turns: num(data.num_turns),
      durationMs: num(data.duration_ms), apiDurationMs: typeof data.duration_api_ms === 'number' ? num(data.duration_api_ms) : null,
      costUsd: typeof data.total_cost_usd === 'number' && Number.isFinite(data.total_cost_usd) && data.total_cost_usd >= 0 ? data.total_cost_usd : null,
      costBasis: typeof models[0]?.costBasis === 'string' ? String(models[0].costBasis).slice(0, 32) : null,
      tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
        thinking: typeof details.thinking_tokens === 'number' ? num(details.thinking_tokens) : null },
      permissionDenials: Array.isArray(data.permission_denials) ? data.permission_denials.length : 0 });
  } else miss(type);
  return events;
}
const CODEX_KNOWN = new Set(['thread.started', 'turn.started', 'item.updated']);
/** Codex state beyond the shared normalizer state: seen tool items and running token totals for the final summary. */
export interface CodexNormalizerState { readonly calls: Set<string>; turns: number; readonly tokens: { input: number; output: number; cacheRead: number; thinking: number | null } }
export function createCodexState(): CodexNormalizerState { return { calls: new Set(), turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, thinking: null } }; }
/**
 * Maps one line of `codex exec --json` onto contract events (B09-3). Event names are the ones the pinned Codex 0.155.1
 * binary carries (thread/turn/item events; agent_message, reasoning, command_execution, file_change, mcp_tool_call,
 * web_search, todo_list items). Agent text is kept only as a redacted excerpt, reasoning and command output never.
 * `codex exec` runs one turn, so turn.completed/turn.failed end the session.
 */
export function normalizeCodexLine(line: string, state: NormalizerState, codex: CodexNormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string) => state.unmapped.set(type.slice(0, 64), (state.unmapped.get(type.slice(0, 64)) ?? 0) + 1);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  let data: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { miss('non-object'); return events; } data = parsed as Record<string, unknown>; }
  catch { if (line.trim()) miss('non-json'); return events; }
  const type = typeof data.type === 'string' ? data.type : 'untyped';
  const call = (id: string, name: string, toolClass: string, target: string | null, detail: string | null) => {
    if (codex.calls.has(id)) return;
    codex.calls.add(id); emit('tool.call', { toolId: id, name, toolClass, target, detail: detail || null });
  };
  if (type === 'item.started' || type === 'item.completed') {
    const item = (data.item ?? {}) as Record<string, unknown>, itemType = typeof item.type === 'string' ? item.type : 'untyped';
    const id = red(item.id, 96) || `item-${state.sequence + 1}`, done = type === 'item.completed';
    const status = typeof item.status === 'string' ? item.status : '';
    if (itemType === 'agent_message') { if (done) emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(item.text ?? '')), thinking: false, excerpt: red(item.text, 240) }); }
    else if (itemType === 'reasoning') { if (done) emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(item.text ?? '')), thinking: true, excerpt: '' }); }
    else if (itemType === 'command_execution') {
      call(id, 'shell', 'shell', null, red(item.command, 240));
      if (done) emit('tool.result', { toolId: id, status: status === 'completed' && item.exit_code === 0 ? 'ok' : 'error',
        bytes: Buffer.byteLength(typeof item.aggregated_output === 'string' ? item.aggregated_output : '') });
    } else if (itemType === 'file_change') {
      // One apply_patch may touch several files: one call per path so every touched file is attributed.
      const changes = Array.isArray(item.changes) ? item.changes as Record<string, unknown>[] : [];
      changes.slice(0, 64).forEach((change, index) => {
        const target = relative(change.path, state.cwd), changeId = `${id}:${index}`;
        call(changeId, 'apply_patch', change.kind === 'add' ? 'write' : 'edit', target === null ? null : red(target, 256) || null, String(change.kind ?? '').slice(0, 16) || null);
        if (done) emit('tool.result', { toolId: changeId, status: status === 'completed' ? 'ok' : 'error', bytes: 0 });
      });
    } else if (itemType === 'mcp_tool_call' || itemType === 'web_search') {
      const name = itemType === 'web_search' ? 'web_search' : red(`mcp:${String(item.server ?? '')}/${String(item.tool ?? '')}`, 64);
      call(id, name, 'network', null, itemType === 'web_search' ? red(item.query, 240) : null);
      if (done) emit('tool.result', { toolId: id, status: status === 'failed' ? 'error' : 'ok', bytes: 0 });
    } else if (itemType !== 'todo_list') miss(`item:${itemType}`);
  } else if (type === 'turn.completed' || type === 'turn.failed') {
    codex.turns++;
    const usage = (data.usage ?? {}) as Record<string, unknown>, cached = num(usage.cached_input_tokens);
    // OpenAI input totals include cached tokens; the contract counts them apart, like Claude's cache_read.
    const tokens = { input: Math.max(0, num(usage.input_tokens) - cached), output: num(usage.output_tokens), cacheRead: cached, cacheWrite: 0,
      thinking: typeof usage.reasoning_output_tokens === 'number' ? num(usage.reasoning_output_tokens) : null };
    if (type === 'turn.completed') {
      emit('usage', { tokens });
      codex.tokens.input += tokens.input; codex.tokens.output += tokens.output; codex.tokens.cacheRead += tokens.cacheRead;
      if (tokens.thinking !== null) codex.tokens.thinking = (codex.tokens.thinking ?? 0) + tokens.thinking;
    }
    emit('session.ended', { outcome: type === 'turn.completed' ? 'success' : 'error', turns: codex.turns, durationMs: Math.max(0, now - state.startMs),
      apiDurationMs: null, costUsd: null, costBasis: null, tokens: { ...codex.tokens, cacheWrite: 0 }, permissionDenials: 0 });
  } else if (!CODEX_KNOWN.has(type)) miss(type);
  return events;
}
/** Unmapped native event types are reported as counts, never silently dropped. */
export function flushUnmapped(state: NormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  for (const [nativeType, count] of state.unmapped) events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind: 'unmapped', nativeType, count });
  state.unmapped.clear();
  return events;
}
/** Best-effort, bounded delivery of event batches to the attempt gateway. Observation never changes execution. */
function eventChannel(socketPath: string, maxQueued = 4000, batch = 64) {
  const queue: BridgeEvent[] = []; let dropped = 0, sending: Promise<void> = Promise.resolve();
  const post = (events: BridgeEvent[]) => new Promise<void>(resolve => {
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const request = httpRequest({ socketPath, path: '/events', method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/x-ndjson', 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); response.on('error', () => resolve()); });
    request.on('error', () => resolve()); request.on('timeout', () => { request.destroy(); resolve(); }); request.end(body);
  });
  const flush = () => { sending = sending.then(async () => { while (queue.length) { const next = queue.splice(0, batch); await post(next); } }); return sending; };
  const timer = setInterval(() => { void flush(); }, 500); timer.unref();
  return {
    push(events: BridgeEvent[]) { for (const event of events) { if (queue.length >= maxQueued) dropped++; else queue.push(event); } if (queue.length >= batch) void flush(); },
    async close(state: NormalizerState) {
      clearInterval(timer);
      if (dropped) queue.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, Date.now() - state.startMs), kind: 'dropped', reason: 'event-cap', count: dropped });
      await flush();
    },
  };
}

async function main() {
  const socketPath = '/run/deckent-connection.sock';
  const payload = await new Promise<string>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap', timeout: 10000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { text += part; if (Buffer.byteLength(text) > 131072) request.destroy(new Error()); });
      response.on('error', reject); response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error()));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error()));
  });
  const setup = JSON.parse(payload) as { schemaVersion: number; provider: string; home: string; file: string;
    credential: Record<string, unknown>; credentialEnvironment?: string; environment: Record<string, string>; limits: { connections: number; idleMs: number };
    preflight?: { schemaVersion: number; cliVersion: string; helpArgs: string[]; requiredFlags: string[] };
    promptDelivery?: { schemaVersion: number; channel: string; core: string; task: string;
      segments: { kind: string; id: string; version: number; sha256: string }[]; sha256: string; argvSha256: string } };
  const home = '/tmp/deckent-home';
  if (setup.schemaVersion !== 1 || setup.home.includes('..') || setup.home.startsWith('/') || setup.file.includes('/')) throw new Error();
  const [executable, ...argv] = process.argv.slice(2); if (!executable) throw new Error();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const delivery = setup.promptDelivery;
  if (delivery) {
    // Validate custody before writing credentials or executing any native tools.
    const { sha256, argvSha256, ...body } = delivery;
    const channel = { claude: 'claude-system-prompt', codex: 'codex-instructions-file', cursor: 'inline' }[setup.provider];
    if (delivery.schemaVersion !== 1 || delivery.channel !== channel || !setup.preflight
      || hash(JSON.stringify(body)) !== sha256 || hash(JSON.stringify([executable, ...argv])) !== argvSha256
      || argv.at(-2) !== '--' || argv.at(-1) !== '__DECKENT_TASK_PROMPT__') throw new Error();
    const root = '/tmp/deckent-prompt'; await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'core.txt'), delivery.core, { mode: 0o600, flag: 'wx' });
    argv[argv.length - 1] = channel === 'inline' ? delivery.core + '\n\n' + delivery.task : delivery.task;
    if (channel === 'claude-system-prompt') {
      const index = argv.indexOf('--system-prompt');
      if (index < 0 || argv[index + 1] !== '__DECKENT_CORE_PROMPT__') throw new Error();
      argv[index + 1] = delivery.core;
    }
    if (channel === 'codex-instructions-file' && (!argv.includes('model_instructions_file="/tmp/deckent-prompt/core.txt"')
      || !argv.includes('project_doc_max_bytes=0'))) throw new Error();
  }
  if (setup.preflight) {
    // Probe in a clean directory before credentials are written or task tools can run.
    const probe = '/tmp/deckent-preflight'; await mkdir(probe, { mode: 0o700 });
    try {
      const run = (args: string[]) => execFileSync(executable, args, { cwd: probe, timeout: 10000,
        maxBuffer: 1048576, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: probe, LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1' } });
      const version = run(['--version']).trim(); const help = run(setup.preflight.helpArgs).split(/[\s,=]+/);
      if (setup.preflight.schemaVersion !== 1 || version !== setup.preflight.cliVersion
        || setup.preflight.requiredFlags.some(flag => !help.includes(flag))) throw new Error();
    } catch {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', code: 78,
        signal: null, outputBytes: 0, failure: 'preflight' }) + '\n');
      process.exitCode = 78; return;
    }
  }
  const authRoot = join(home, setup.home); await mkdir(authRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(authRoot, setup.file), JSON.stringify(setup.credential), { mode: 0o600, flag: 'wx' });
  if (setup.provider === 'claude') await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  if (setup.provider === 'cursor') {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(join(home, '.cursor/cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: false },
      permissions: { allow: [], deny: [] }, network: { useHttp1ForAgent: true } }), { mode: 0o600 });
  }
  const sockets = new Set<Socket>();
  const relay = createServer(client => {
    const remote = connect(socketPath); sockets.add(client); sockets.add(remote);
    const close = () => { client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote); };
    client.on('error', close); remote.on('error', close); client.on('close', close); remote.on('close', close);
    client.setTimeout(setup.limits.idleMs, close); remote.setTimeout(setup.limits.idleMs, close);
    client.pipe(remote); remote.pipe(client);
  });
  relay.maxConnections = setup.limits.connections;
  await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  const address = relay.address(); if (!address || typeof address === 'string') throw new Error();
  const proxy = `http://127.0.0.1:${address.port}`;
  const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home,
    LANG: 'C.UTF-8', ...setup.environment,
    ...(setup.credentialEnvironment && typeof setup.credential.accessToken === 'string' ? { [setup.credentialEnvironment]: setup.credential.accessToken } : {}),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: '', no_proxy: '' } });
  if (delivery) child.once('spawn', () => process.stdout.write(JSON.stringify({ schemaVersion: 1,
    kind: 'native-prompt-delivery', phase: 'spawned', channel: delivery.channel, sha256: delivery.sha256,
    argvSha256: hash(JSON.stringify([executable, ...argv])), coreSha256: hash(delivery.core), taskSha256: hash(delivery.task),
    segments: delivery.segments }) + '\n'));
  // Native events can contain tool output and request headers. Never forward raw events: only redacted contract events leave.
  let tail = ''; let bytes = 0; let pending = '';
  const state = createNormalizerState([...secretValues(setup.credential), proxy]);
  const channel = eventChannel(socketPath);
  const codex = createCodexState();
  if (setup.provider !== 'claude') channel.push([{ schemaVersion: 1, sequence: ++state.sequence, atMs: 0, kind: 'session.started', provider: setup.provider, model: null, cliVersion: null }]);
  const capture = (part: Buffer) => { bytes += part.length; tail = (tail + part.toString('utf8')).slice(-65536); };
  const observe = (part: Buffer) => {
    capture(part);
    pending += part.toString('utf8');
    const lines = pending.split('\n'); pending = lines.pop() ?? '';
    if (pending.length > 1_048_576) { state.unmapped.set('oversized-line', (state.unmapped.get('oversized-line') ?? 0) + 1); pending = ''; }
    for (const line of lines) {
      if (setup.provider === 'claude') channel.push(normalizeClaudeLine(line, state));
      else if (setup.provider === 'codex') channel.push(normalizeCodexLine(line, state, codex));
      else if (line.trim()) state.unmapped.set(`${setup.provider}-event`, (state.unmapped.get(`${setup.provider}-event`) ?? 0) + 1);
    }
  };
  child.stdout.on('data', observe); child.stderr.on('data', capture);
  const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const failure = /unauthorized|authentication|log in|login|401|token.*expired/i.test(tail) ? 'authentication'
    : /quota|rate.limit|usage.limit|429/i.test(tail) ? 'capacity'
    : /model.*not.*(found|supported|available)|invalid.model/i.test(tail) ? 'model'
    : /connect|proxy|network|fetch failed|socket|ENOTFOUND|ECONN/i.test(tail) ? 'connection' : 'native';
  if (pending && setup.provider === 'claude') channel.push(normalizeClaudeLine(pending, state));
  if (pending && setup.provider === 'codex') channel.push(normalizeCodexLine(pending, state, codex));
  channel.push(flushUnmapped(state)); await channel.close(state);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', ...result, outputBytes: bytes,
    failure: result.code === 0 ? null : failure }) + '\n');
  for (const socket of sockets) socket.destroy(); relay.close();
  process.exitCode = result.code === 0 ? 0 : 1;
}
// Runs only as the mounted bootstrap (`node /run/deckent-bootstrap.mjs ...`); importing it for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('NATIVE_BOOTSTRAP_FAILED\n'); process.exitCode = 78; });
}
