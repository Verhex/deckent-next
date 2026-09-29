import { createHash } from 'node:crypto';
import type { Client, CallToolResult, VersionNegotiationMode } from '@modelcontextprotocol/client';
import { PACKAGE_NAME, PACKAGE_VERSION } from '#platform/index.js';
import { shellSandboxCapabilities, type ShellCapabilities, type ShellSandbox } from '#adapters/core/host-shell/index.js';
import { redactText } from '#adapters/core/native-connection/index.js';
import { verifyMcpTools, mcpToolPinDigest, type McpClientServerSettings, type McpClientSettings, type McpLiveTool, type McpToolVerdict } from './pin.js';

/** Protocol revisions this client speaks: the modern era first (probed with `server/discover`), the 2025 `initialize` era as the fallback. */
export const MCP_CLIENT_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25']);
/** Bounds of what one server may declare and of the stderr tail kept for `inspect`. */
export const MCP_CLIENT_TOOLS_MAX = 512;
/** Pages of one `tools/list` (SDK ≥ 2.2 follows `nextCursor` itself; `listMaxPages` is its hard cap, so a server that never stops paging ends here). */
export const MCP_CLIENT_LIST_PAGES_MAX = 16;
export const MCP_CLIENT_STDERR_TAIL_BYTES = 4_096;

/** Where a server starts: the project root, the service environment (HOME/PATH of a sandbox view) and the sandbox providers. */
export interface McpLaunchContext {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly sandboxes: readonly ShellSandbox[];
  /** Measured host capabilities (defaults to the process-wide probe). */
  readonly capabilities?: ShellCapabilities;
}
type Launch = { readonly ok: true; readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly sandboxed: boolean;
  readonly posture: string } | { readonly ok: false; readonly reason: 'sandbox-unavailable'; readonly detail: string };
const HOST_POSTURE = 'host: runs on this machine as your user (not a sandbox: files, processes and network are reachable)';
const SANDBOX_POSTURE = 'sandbox: bubblewrap (the project is writable, HOME and everything else hidden, no network; it ends with the service)';

/** The realm of one server (the shell's modes): `host` as is; a sandbox provider that can hold a long-lived process wraps the command;
 * none usable → `require-sandbox` refuses, `prefer-sandbox` runs on the host and says so (never silently). */
async function launchOf(server: McpClientServerSettings, context: McpLaunchContext): Promise<Launch> {
  const env = { ...server.env };
  if (server.realm === 'host') return { ok: true, command: server.command, args: server.args, env, sandboxed: false, posture: HOST_POSTURE };
  const capabilities = context.capabilities ?? await shellSandboxCapabilities(), reasons: string[] = [];
  if (capabilities.platform !== 'linux') reasons.push(`platform ${capabilities.platform}`);
  else for (const sandbox of context.sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (!usable.ok) { reasons.push(`${sandbox.kind}: ${usable.reason}`); continue; }
    if (!usable.launch) { reasons.push(`${sandbox.kind}: runs one command at a time`); continue; }
    const launch = await usable.launch(context.environment);
    if (!launch.ok) { reasons.push(`${sandbox.kind}: ${launch.reason}`); continue; }
    return { ok: true, command: launch.file, args: [...launch.args, '--', server.command, ...server.args], env, sandboxed: true, posture: SANDBOX_POSTURE };
  }
  const why = reasons.length ? reasons.join('; ') : 'no sandbox mechanism is available';
  if (server.realm === 'require-sandbox') return { ok: false, reason: 'sandbox-unavailable', detail: why };
  return { ok: true, command: server.command, args: server.args, env, sandboxed: false,
    posture: `sandbox: none; runs on host (${why}). Files, processes and network are reachable.` };
}

export type McpServerOpen = { readonly ok: true; readonly era: 'modern' | 'legacy'; readonly protocolVersion: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null; readonly sandboxed: boolean; readonly posture: string;
  readonly tools: readonly McpToolVerdict[] } | { readonly ok: false; readonly reason: 'sandbox-unavailable' | 'start-failed' | 'list-failed' | 'restart-limit' | 'too-many-tools';
  readonly detail?: string };
export type McpCallOutcome = { readonly outcome: 'answered'; readonly result: CallToolResult } | { readonly outcome: 'answered'; readonly error: { readonly code: number; readonly message: string } }
  | { readonly outcome: 'refused'; readonly reason: 'not-connected' | 'pin-mismatch' | 'cancelled' }
  | { readonly outcome: 'unknown'; readonly reason: 'timed-out' | 'connection-closed' | 'cancelled' | 'failed' };

interface ServerState {
  readonly key: string;
  client: Client | null;
  generation: number;
  starts: number;
  failed: string | null;
  stderr: Buffer;
  listing: { readonly generation: number; readonly digests: ReadonlyMap<string, string> } | null;
  last: Extract<McpServerOpen, { ok: true }> | null;
  lock: Promise<unknown>;
}
/** The client SDK loads with the first server start, not with every CLI/MCP/service process that merely composes the pool (≈45 ms each).
 * The validator is the SDK's interpreter provider (@cfworker/json-schema): a server's `outputSchema` is untrusted and must never be compiled by
 * the Node default (the bundled ajv 8.18 + fast-uri 3.1.0, whose advisories no install-time override can reach). */
let clientSdk: Promise<readonly [typeof import('@modelcontextprotocol/client'), typeof import('@modelcontextprotocol/client/stdio'),
  typeof import('@modelcontextprotocol/client/validators/cf-worker')]> | undefined;
const loadClientSdk = () => clientSdk ??= Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  import('@modelcontextprotocol/client/validators/cf-worker')]);
/** Every page of the server's tool list (one deadline for the whole walk, each page also bounded); the pin then covers every page. */
const listAllTools = async (client: Client, timeoutMs: number) =>
  (await client.listTools(undefined, { cacheMode: 'bypass', timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs * 2) })).tools as McpLiveTool[];
const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * The runtime service's MCP servers (MCP-CLIENT): each is started by the first turn (or `inspect`) that needs it, listed, verified against its
 * pins and kept for the service's life; a changed launch configuration replaces it; a crash is restarted on the next use, at most `maxRestarts`
 * times, then the server stays failed until the service restarts. Stopping the service (its signal) closes every server (the SDK closes stdin,
 * then SIGTERM, then SIGKILL). A call is sent only on the process whose listing matched the pin.
 */
export class McpClientPool {
  private readonly states = new Map<string, ServerState>();
  private closed = false;
  constructor(signal: AbortSignal) {
    if (signal.aborted) this.closed = true;
    else signal.addEventListener('abort', () => { void this.close(); }, { once: true });
  }
  /** Starts (when needed), lists and verifies one server; serialized per server. */
  open(server: McpClientServerSettings, settings: McpClientSettings, context: McpLaunchContext): Promise<McpServerOpen> {
    const key = createHash('sha256').update(JSON.stringify([server.command, server.args, Object.entries(server.env).sort(), server.realm, server.generation ?? 0])).digest('hex');
    let state = this.states.get(server.id);
    if (state && state.key !== key) { void state.client?.close().catch(() => undefined); state = undefined; }
    if (!state) { state = { key, client: null, generation: 0, starts: 0, failed: null, stderr: Buffer.alloc(0), listing: null, last: null, lock: Promise.resolve() };
      this.states.set(server.id, state); }
    const current = state, run = current.lock.then(() => this.openLocked(current, server, settings, context));
    current.lock = run.catch(() => undefined);
    return run;
  }
  private async openLocked(state: ServerState, server: McpClientServerSettings, settings: McpClientSettings, context: McpLaunchContext): Promise<McpServerOpen> {
    if (this.closed) return { ok: false, reason: 'start-failed', detail: 'the service is stopping' };
    if (state.failed) return { ok: false, reason: 'restart-limit', detail: state.failed };
    if (!state.client) {
      const launch = await launchOf(server, context);
      if (!launch.ok) return { ok: false, reason: launch.reason, detail: launch.detail };
      if (state.starts > settings.maxRestarts) { state.failed = `more than ${settings.maxRestarts} restart(s)`; return { ok: false, reason: 'restart-limit', detail: state.failed }; }
      state.starts++;
      const started = await this.start(state, launch, settings, context.cwd);
      if (!started.ok) return started;
    }
    const client = state.client!;
    let tools: McpLiveTool[];
    try { tools = await listAllTools(client, settings.connectTimeoutMs); }
    catch (error) {
      if (errorCode(error) === 'LIST_PAGINATION_EXCEEDED') return { ok: false, reason: 'too-many-tools', detail: `more than ${MCP_CLIENT_LIST_PAGES_MAX} pages` };
      return { ok: false, reason: 'list-failed', detail: String(errorCode(error) ?? 'failed') };
    }
    if (tools.length > MCP_CLIENT_TOOLS_MAX) return { ok: false, reason: 'too-many-tools', detail: `${tools.length} > ${MCP_CLIENT_TOOLS_MAX}` };
    state.listing = { generation: state.generation, digests: new Map(tools.map(tool => [tool.name, mcpToolPinDigest(tool)])) };
    const info = client.getServerVersion();
    state.last = { ok: true, era: client.getProtocolEra() === 'modern' ? 'modern' : 'legacy', protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverInfo: info ? { name: String(info.name), version: String(info.version) } : null, sandboxed: state.last?.sandboxed ?? false,
      posture: state.last?.posture ?? '', tools: verifyMcpTools(server, tools) };
    return state.last;
  }
  private async start(state: ServerState, launch: Extract<Launch, { ok: true }>, settings: McpClientSettings, cwd: string): Promise<McpServerOpen> {
    const [{ Client }, { StdioClientTransport }, { CfWorkerJsonSchemaValidator }] = await loadClientSdk();
    const transport = new StdioClientTransport({ command: launch.command, args: [...launch.args], env: launch.env, cwd, stderr: 'pipe', maxBufferSize: settings.inputMaxBytes });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const next = Buffer.concat([state.stderr, chunk]);
      state.stderr = next.length > MCP_CLIENT_STDERR_TAIL_BYTES ? next.subarray(next.length - MCP_CLIENT_STDERR_TAIL_BYTES) : next;
    });
    // Both eras: `server/discover` first (2026-07-28), the `initialize` handshake when the server is not modern (stdio: a sibling probe process).
    const negotiation: VersionNegotiationMode = 'auto';
    const client = new Client({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { supportedProtocolVersions: [...MCP_CLIENT_PROTOCOL_VERSIONS],
      versionNegotiation: { mode: negotiation, probe: { timeoutMs: settings.connectTimeoutMs } }, listMaxPages: MCP_CLIENT_LIST_PAGES_MAX,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    try { await client.connect(transport, { timeout: settings.connectTimeoutMs }); }
    catch (error) {
      await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
      return { ok: false, reason: 'start-failed', detail: String(errorCode(error) ?? (error as Error)?.message ?? 'failed').slice(0, 200) };
    }
    if (this.closed) { await client.close().catch(() => undefined); return { ok: false, reason: 'start-failed', detail: 'the service is stopping' }; }
    state.generation++; state.client = client;
    client.onclose = () => { if (state.client === client) state.client = null; };
    state.last = { ok: true, era: 'legacy', protocolVersion: null, serverInfo: null, sandboxed: launch.sandboxed, posture: launch.posture, tools: [] };
    return state.last;
  }
  /**
   * Sends one `tools/call` on the live process whose listing matched `digest` (a restarted process is listed again first). Nothing is sent when
   * the server is not connected, the pin no longer matches or the call was cancelled first. After sending: an answer (a result or a JSON-RPC
   * error) is `answered`; a timeout, a cancellation or a closed connection is `unknown` — it is never sent again here.
   */
  async call(serverId: string, tool: string, digest: string, args: Record<string, unknown>, options: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<McpCallOutcome> {
    const state = this.states.get(serverId), client = state?.client;
    if (!state || !client || this.closed) return { outcome: 'refused', reason: 'not-connected' };
    if (state.listing?.generation !== state.generation) {
      try { const tools = await listAllTools(client, options.timeoutMs);
        state.listing = { generation: state.generation, digests: new Map(tools.map(entry => [entry.name, mcpToolPinDigest(entry)])) }; }
      catch { return { outcome: 'refused', reason: 'not-connected' }; }
    }
    if (state.listing.digests.get(tool) !== digest) return { outcome: 'refused', reason: 'pin-mismatch' };
    if (options.signal.aborted) return { outcome: 'refused', reason: 'cancelled' };
    try { return { outcome: 'answered', result: await client.callTool({ name: tool, arguments: args }, { timeout: options.timeoutMs, signal: options.signal }) as CallToolResult }; }
    catch (error) {
      const [{ ProtocolError }] = await loadClientSdk();
      if (error instanceof ProtocolError) return { outcome: 'answered', error: { code: error.code, message: error.message } };
      const code = errorCode(error);
      if (code === 'NOT_CONNECTED' || (error as Error)?.message === 'Not connected') return { outcome: 'refused', reason: 'not-connected' };
      if (options.signal.aborted) return { outcome: 'unknown', reason: 'cancelled' };
      return { outcome: 'unknown', reason: code === 'REQUEST_TIMEOUT' ? 'timed-out' : code === 'CONNECTION_CLOSED' ? 'connection-closed' : 'failed' };
    }
  }
  /** The server's last stderr bytes, redacted (for `inspect`; never streamed into the service's own stderr). */
  stderr(serverId: string): string {
    const tail = this.states.get(serverId)?.stderr;
    return tail ? redactText(tail.toString('utf8'), [], MCP_CLIENT_STDERR_TAIL_BYTES) : '';
  }
  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.states.values()].flatMap(state => state.client ? [state.client] : []);
    for (const state of this.states.values()) state.client = null;
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}
