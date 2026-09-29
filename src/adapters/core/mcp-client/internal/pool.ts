import { createHash } from 'node:crypto';
import type { Client, CallToolResult, Tool, VersionNegotiationMode } from '@modelcontextprotocol/client';
import { PACKAGE_NAME, PACKAGE_VERSION } from '#platform/index.js';
import { describeShellWritePosture, longLivedWritePosture, sandboxWriteView, shellSandboxCapabilities, type ShellCapabilities, type ShellSandbox } from '#adapters/core/host-shell/index.js';
import { redactText } from '#adapters/core/native-connection/index.js';
import { diagnoseSandboxedStart, type McpSandboxDiagnosis } from './diagnose.js';
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
/** `sandbox`: the launcher's own arguments before `--` and the server's command line, so a failed start can be diagnosed in the same view.
 * `projectReadOnly`: the write view the launch enforces (false on the host, where no posture has an OS boundary). */
type Launch = { readonly ok: true; readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly sandboxed: boolean;
  readonly projectReadOnly: boolean; readonly posture: string; readonly sandbox?: { readonly prefix: readonly string[]; readonly command: string; readonly args: readonly string[] } }
  | { readonly ok: false; readonly reason: 'sandbox-unavailable'; readonly detail: string };
const HOST_POSTURE = 'host: runs on this machine as your user (not a sandbox: files, processes and network are reachable)';
/** C5 (owner 2026-09-29): how an owner lets a sandboxed server write the project — the explicit host realm, shown on every card. */
export const MCP_HOST_REALM_HINT = 'a server that must write the project needs `realm: host` in its registry entry (it then runs unsandboxed)';
/**
 * The launch card's line (before anything starts): what the realm will mean for the server, from the same long-lived write posture the
 * sandbox view enforces (`longLivedWritePosture`); whether a sandbox is usable is known only at the start (the tools card names it).
 */
export function mcpRealmPosture(realm: McpClientServerSettings['realm']): string {
  if (realm === 'host') return HOST_POSTURE;
  const write = describeShellWritePosture(sandboxWriteView({}, longLivedWritePosture()));
  return `sandbox${realm === 'prefer-sandbox' ? ' when one is usable (else on the host, said at the start)' : ' required'}: ${write}; ${MCP_HOST_REALM_HINT}`;
}

/** The realm of one server (the shell's modes): `host` as is; a sandbox provider that can hold a long-lived process wraps the command;
 * none usable → `require-sandbox` refuses, `prefer-sandbox` runs on the host and says so (never silently). */
async function launchOf(server: McpClientServerSettings, context: McpLaunchContext): Promise<Launch> {
  const env = { ...server.env };
  if (server.realm === 'host') return { ok: true, command: server.command, args: server.args, env, sandboxed: false, projectReadOnly: false, posture: HOST_POSTURE };
  const capabilities = context.capabilities ?? await shellSandboxCapabilities(), reasons: string[] = [];
  if (capabilities.platform !== 'linux') reasons.push(`platform ${capabilities.platform}`);
  else for (const sandbox of context.sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (!usable.ok) { reasons.push(`${sandbox.kind}: ${usable.reason}`); continue; }
    if (!usable.launch) { reasons.push(`${sandbox.kind}: runs one command at a time`); continue; }
    const launch = await usable.launch(context.environment);
    if (!launch.ok) { reasons.push(`${sandbox.kind}: ${launch.reason}`); continue; }
    // The card's words come from the view this launch enforces (C5: the project read-only), with how to let a server write.
    return { ok: true, command: launch.file, args: [...launch.args, '--', server.command, ...server.args], env, sandboxed: true, projectReadOnly: launch.view.projectReadOnly,
      posture: `sandbox: ${launch.posture}${launch.view.projectReadOnly ? `; ${MCP_HOST_REALM_HINT}` : ''}`, sandbox: { prefix: launch.args, command: server.command, args: server.args } };
  }
  const why = reasons.length ? reasons.join('; ') : 'no sandbox mechanism is available';
  if (server.realm === 'require-sandbox') return { ok: false, reason: 'sandbox-unavailable', detail: why };
  return { ok: true, command: server.command, args: server.args, env, sandboxed: false, projectReadOnly: false,
    posture: `sandbox: none; runs on host (${why}). Files, processes and network are reachable.` };
}

/** An opened server: `projectReadOnly` is the write view its sandbox enforces (C5; false on the host), `posture` the cards' words for it. */
export type McpServerOpen = { readonly ok: true; readonly era: 'modern' | 'legacy'; readonly protocolVersion: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null; readonly sandboxed: boolean; readonly projectReadOnly: boolean; readonly posture: string;
  readonly tools: readonly McpToolVerdict[] } | { readonly ok: false; readonly reason: 'sandbox-unavailable' | 'start-failed' | 'list-failed' | 'restart-limit' | 'too-many-tools';
  readonly detail?: string } | { readonly ok: false; readonly reason: 'sandbox-unreachable'; readonly detail: string; readonly diagnosis: McpSandboxDiagnosis };
/** An answered call's JSON-RPC error: the server's own (`server`), SEP-2243 HEADER_MISMATCH (`header-mismatch`, -32020; never re-sent), or a
 * structured result that does not conform to the pinned outputSchema or is missing although one is declared (`output-schema`, -32602; the
 * server answered, so its effect may have happened). */
export interface McpAnsweredError { readonly code: number; readonly message: string; readonly kind: 'server' | 'header-mismatch' | 'output-schema' }
/** Why the current registry and trust no longer admit a call (MCP-REVOKE): the trust was reset or the server removed or declined
 * (`trust-revoked`), its definition or scope is not the one the call was offered under (`definition-changed`), the tool's pin is gone or
 * different (`pin-revoked`), or the trust record cannot be read or locked (`trust-unavailable`, fail closed). */
export type McpSendRefusal = 'trust-revoked' | 'definition-changed' | 'pin-revoked' | 'trust-unavailable';
/** The send authority of one call: asked right before the request is handed to the SDK, after every local pre-send check; null admits. */
export type McpSendAdmission = () => Promise<McpSendRefusal | null>;
export type McpCallOutcome = { readonly outcome: 'answered'; readonly result: CallToolResult } | { readonly outcome: 'answered'; readonly error: McpAnsweredError }
  | { readonly outcome: 'refused'; readonly reason: 'not-connected' | 'pin-mismatch' | 'cancelled' | 'invalid-output-schema' | McpSendRefusal }
  | { readonly outcome: 'unknown'; readonly reason: 'timed-out' | 'connection-closed' | 'cancelled' | 'failed' };

interface ServerState {
  readonly key: string;
  client: Client | null;
  generation: number;
  starts: number;
  failed: string | null;
  stderr: Buffer;
  listing: { readonly generation: number; readonly tools: ReadonlyMap<string, PinnedTool> } | null;
  last: Extract<McpServerOpen, { ok: true }> | null;
  /** The validator this process's client compiles with (the pool's pre-send compile uses the same one). */
  validator: JsonSchemaValidator | null;
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
type JsonSchemaValidator = { getValidator(schema: Record<string, unknown>): unknown };
/** One listed tool as the pin binds it: its digest and exactly the digest-covered fields (frozen; nothing unpinned reaches the SDK). The
 * validator writes into a schema it compiles (@cfworker's `__absolute_uri__`), so every use gets a fresh copy of the frozen pin; `compiles`
 * caches whether the pinned outputSchema compiles (null = not compiled yet). */
interface PinnedTool { readonly digest: string; readonly definition: Tool; compiles: boolean | null }
const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
function pinnedTools(tools: readonly McpLiveTool[]): ReadonlyMap<string, PinnedTool> {
  return new Map(tools.map(tool => {
    const { name, title, description, inputSchema, outputSchema, annotations } = tool;
    const definition: McpLiveTool = deepFreeze(structuredClone(Object.fromEntries(Object.entries({ name, title, description, inputSchema, outputSchema, annotations })
      .filter(([, value]) => value !== undefined)) as unknown as McpLiveTool));
    return [name, { digest: mcpToolPinDigest(definition), definition: definition as unknown as Tool, compiles: null }];
  }));
}
/** SEP-2243 HeaderMismatch (Streamable HTTP; the SDK does not export its constant). */
const HEADER_MISMATCH = -32020;
/** The SDK's own post-send structured-result checks (client 2.2.0 `callTool`): missing (-32600), nonconforming or unvalidatable (-32602). */
const OUTPUT_SCHEMA_FAILURE = /^(?:Tool .+ has an output schema but did not return structured content|Structured content does not match the tool's output schema|Failed to validate structured content)/su;

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
    if (!state) { state = { key, client: null, generation: 0, starts: 0, failed: null, stderr: Buffer.alloc(0), listing: null, last: null, validator: null,
      lock: Promise.resolve() };
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
    state.listing = { generation: state.generation, tools: pinnedTools(tools) };
    const info = client.getServerVersion();
    state.last = { ok: true, era: client.getProtocolEra() === 'modern' ? 'modern' : 'legacy', protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      serverInfo: info ? { name: String(info.name), version: String(info.version) } : null, sandboxed: state.last?.sandboxed ?? false,
      projectReadOnly: state.last?.projectReadOnly ?? false, posture: state.last?.posture ?? '', tools: verifyMcpTools(server, tools) };
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
    const validator = new CfWorkerJsonSchemaValidator();
    const client = new Client({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { supportedProtocolVersions: [...MCP_CLIENT_PROTOCOL_VERSIONS],
      versionNegotiation: { mode: negotiation, probe: { timeoutMs: settings.connectTimeoutMs } }, listMaxPages: MCP_CLIENT_LIST_PAGES_MAX,
      jsonSchemaValidator: validator });
    try { await client.connect(transport, { timeout: settings.connectTimeoutMs }); }
    catch (error) {
      await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
      const failed = { ok: false as const, reason: 'start-failed' as const, detail: String(errorCode(error) ?? (error as Error)?.message ?? 'failed').slice(0, 200) };
      if (!launch.sandbox) return failed;
      // MCP-SANDBOX-PATHS: a sandboxed start that failed is explained by probing the same view (what it hides, or what the command needs
      // from outside it); the outcome stays a failure — never a start on the host instead.
      const diagnosed = await diagnoseSandboxedStart({ file: launch.command, prefix: launch.sandbox.prefix }, { command: launch.sandbox.command,
        args: launch.sandbox.args, pathVariable: launch.env['PATH'] ?? process.env['PATH'], cwd });
      if (!diagnosed) return failed;
      // Not found on this machine either (no name: the command may carry an expanded `${VAR}`; the cards show its template).
      if (diagnosed.kind === 'not-found') return { ...failed, detail: 'command not found' };
      return { ok: false, reason: 'sandbox-unreachable', detail: diagnosed.diagnosis.kind, diagnosis: diagnosed.diagnosis };
    }
    if (this.closed) { await client.close().catch(() => undefined); return { ok: false, reason: 'start-failed', detail: 'the service is stopping' }; }
    state.generation++; state.client = client; state.validator = validator;
    client.onclose = () => { if (state.client === client) state.client = null; };
    state.last = { ok: true, era: 'legacy', protocolVersion: null, serverInfo: null, sandboxed: launch.sandboxed, projectReadOnly: launch.projectReadOnly,
      posture: launch.posture, tools: [] };
    return state.last;
  }
  /**
   * Sends one `tools/call` on the live process whose listing matched `digest` (a restarted process is listed again first), carrying that
   * listing's pinned definition (`toolDefinition`): the SDK validates structuredContent against the pinned outputSchema and never re-lists or
   * re-sends (MCP-PIN-DEF). Nothing is sent when the server is not connected, the pin no longer matches, the pinned outputSchema cannot be
   * compiled or the call was cancelled first. After sending: an answer (a result or a JSON-RPC error, HEADER_MISMATCH and a nonconforming
   * structured result included) is `answered`; a timeout, a cancellation or a closed connection is `unknown` — it is never sent again here.
   * `admit` (MCP-REVOKE) is the caller's send authority, asked last, right before the request is handed to the SDK: a refusal sends nothing.
   */
  async call(serverId: string, tool: string, digest: string, args: Record<string, unknown>, options: { readonly timeoutMs: number; readonly signal: AbortSignal;
    readonly admit?: McpSendAdmission }): Promise<McpCallOutcome> {
    const state = this.states.get(serverId), client = state?.client;
    if (!state || !client || this.closed) return { outcome: 'refused', reason: 'not-connected' };
    if (state.listing?.generation !== state.generation) {
      try { state.listing = { generation: state.generation, tools: pinnedTools(await listAllTools(client, options.timeoutMs)) }; }
      catch { return { outcome: 'refused', reason: 'not-connected' }; }
    }
    const pinned = state.listing.tools.get(tool);
    if (!pinned || pinned.digest !== digest) return { outcome: 'refused', reason: 'pin-mismatch' };
    // The SDK compiles the given definition before sending and throws -32602 when it cannot: compiled here first (the same validator), so
    // that case is refused with nothing sent instead of looking answered.
    const definition = structuredClone(pinned.definition), outputSchema = pinned.definition.outputSchema as Record<string, unknown> | undefined;
    if (outputSchema && state.validator) {
      if (pinned.compiles === null) try { state.validator.getValidator(structuredClone(outputSchema)); pinned.compiles = true; } catch { pinned.compiles = false; }
      if (!pinned.compiles) return { outcome: 'refused', reason: 'invalid-output-schema' };
    }
    if (options.signal.aborted) return { outcome: 'refused', reason: 'cancelled' };
    // The current trust decides last (after the approval wait and every local check): only local SDK steps separate it from the write.
    const refusal = options.admit ? await options.admit() : null;
    if (refusal) return { outcome: 'refused', reason: refusal };
    if (options.signal.aborted) return { outcome: 'refused', reason: 'cancelled' };
    if (state.client !== client) return { outcome: 'refused', reason: 'not-connected' };
    try {
      return { outcome: 'answered', result: await client.callTool({ name: tool, arguments: args },
        { timeout: options.timeoutMs, signal: options.signal, toolDefinition: definition }) as CallToolResult };
    } catch (error) {
      const [{ ProtocolError }] = await loadClientSdk();
      if (error instanceof ProtocolError) {
        if (error.code === HEADER_MISMATCH) return { outcome: 'answered', error: { code: error.code, message: error.message, kind: 'header-mismatch' } };
        if (outputSchema && (error.code === -32600 || error.code === -32602) && OUTPUT_SCHEMA_FAILURE.test(error.message))
          return { outcome: 'answered', error: { code: -32602, message: error.message, kind: 'output-schema' } };
        return { outcome: 'answered', error: { code: error.code, message: error.message, kind: 'server' } };
      }
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
  /**
   * Stops one server's process (MCP-REVOKE: its trust is gone, so an untrusted process does not keep running or serving): forgotten at once
   * (a later `open` starts it again, after its cards), closed after any open already queued on it, so nothing started is left behind.
   */
  retire(serverId: string): Promise<void> {
    const state = this.states.get(serverId);
    if (!state) return Promise.resolve();
    this.states.delete(serverId);
    const run = state.lock.then(async () => { const client = state.client; state.client = null; state.listing = null; await client?.close().catch(() => undefined); });
    state.lock = run.catch(() => undefined);
    return run.catch(() => undefined);
  }
  /** Stops every server process whose id is not in `trusted` (a turn's current registry view). */
  retain(trusted: ReadonlySet<string>): void {
    for (const id of [...this.states.keys()]) if (!trusted.has(id)) void this.retire(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.states.values()].flatMap(state => state.client ? [state.client] : []);
    for (const state of this.states.values()) state.client = null;
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}
