import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server, WebStandardStreamableHTTPServerTransport, type CallToolResult, type Tool, type RequestId } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { agentToolCallSchema, type AgentToolCall } from '#domain/index.js';
import { nativeAgentBridgeSchema, nativeAgentCorrelationSchema, nativeAgentToolResultSchema, toolSessionSchema,
  type NativeAgentBridge, type NativeAgentCorrelation, type ToolSessionPort } from '#capabilities/index.js';
import { PACKAGE_VERSION, DeckentJsonSchemaValidator, redactForRecord, snapshotKnownSecrets, type KnownSecretSnapshot } from '#platform/index.js';
import { bridgeBody, bridgeResponse, refuseBridge } from './http.js';

export interface NativeToolBridgeLimits {
  readonly idleMs: number;
  readonly maxConnections: number;
  readonly replayMaxEntries: number;
  readonly replayMaxBytes: number;
}
export interface NativeToolBridgeOptions {
  /** Composition supplies K1's AI/MCP session, never a human application port. */
  readonly port: ToolSessionPort;
  readonly bridge: NativeAgentBridge;
  readonly limits: NativeToolBridgeLimits;
  readonly correlationKind: NativeAgentCorrelation['kind'];
  readonly signal?: AbortSignal;
  readonly knownSecrets?: KnownSecretSnapshot;
}
type Replay = { readonly digest: string; readonly deckentCallId: string; readonly result: Promise<CallToolResult> };
const digest = (value: string) => createHash('sha256').update(value).digest();
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Node timers use a signed 32-bit delay. Refuse overflow rather than silently turning a long approval wait into 1 ms.
const nodeDelaySchema = z.number().int().positive().max(2_147_483_647);

/** One host-side facade per generation. No listener or process is created inside the CLI realm. */
export async function createNativeToolBridge(input: NativeToolBridgeOptions) {
  const bridge = nativeAgentBridgeSchema.parse(input.bridge), session = toolSessionSchema.parse(input.port.session), limits = input.limits;
  if ([limits.idleMs, limits.maxConnections, limits.replayMaxEntries, limits.replayMaxBytes].some(value => !Number.isSafeInteger(value) || value <= 0)
    || limits.idleMs <= 1 || limits.replayMaxBytes < bridge.frameMaxBytes || !nodeDelaySchema.safeParse(session.approvalTtlMs).success) throw new Error('NATIVE_BRIDGE_LIMITS_INVALID');
  const turnToken = randomBytes(32).toString('base64url'), tokenHeader = bridge.tokenValueTemplate.replace('{turnToken}', turnToken);
  const tokenDigest = digest(tokenHeader), known = snapshotKnownSecrets([{ name: bridge.tokenEnvName, value: turnToken }]);
  const lifetime = new AbortController(), responses = new Set<ServerResponse>(), replay = new Map<string, Replay>(), inFlight = new Set<string>();
  let closed = false, initializing = false, sessionId: string | undefined, active = 0, replayBytes = 0;
  const url = `http://${bridge.sentinelHost}${bridge.path}`, progressIntervalMs = Math.floor(limits.idleMs / 2);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
    onsessioninitialized: id => { sessionId = id; }, keepAliveMs: progressIntervalMs, maxRequestBodySize: bridge.bodyMaxBytes });
  const server = new Server({ name: bridge.serverName, version: PACKAGE_VERSION }, { capabilities: { tools: {} }, jsonSchemaValidator: new DeckentJsonSchemaValidator() });
  // Project values through the already-resolved secret snapshots, without discovering or reading credentials.
  const safe = (value: string) => redactForRecord(input.knownSecrets ? redactForRecord(value, input.knownSecrets) : value, known);
  const envelope = (deckentCallId: string, code: string) => ({ schemaVersion: 1 as const, turnId: session.turnId, generation: session.generation,
    deckentCallId, outcome: { status: 'error' as const, text: code } });
  const result = (value: unknown, isError: boolean): CallToolResult => ({ content: [{ type: 'text', text: safe(JSON.stringify(value)) }], isError });
  const failure = (id: string, code: string) => result(envelope(id, code), true);
  const tools = session.tools.map(({ name, description, inputSchema }) => ({ name,
    description: safe(description), inputSchema: JSON.parse(safe(JSON.stringify(inputSchema))) as Tool['inputSchema'] }));
  const frameBytes = (id: RequestId, value: unknown) => Buffer.byteLength(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n\n`);
  const fits = (id: RequestId, value: unknown) => frameBytes(id, value) <= bridge.frameMaxBytes;
  if (!fits('', { tools }) || frameBytes('', failure(randomUUID(), 'NATIVE_BRIDGE_CORRELATION_INVALID')) > bridge.frameMaxBytes / 2) throw new Error('NATIVE_BRIDGE_LIMITS_INVALID');
  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async (request, context) => {
    const meta = request.params._meta ?? {}, deckentCallId = randomUUID();
    const correlation = nativeAgentCorrelationSchema.safeParse(input.correlationKind === 'claude-tool-use'
      ? { kind: input.correlationKind, toolUseId: meta['claudecode/toolUseId'], deckentCallId }
      : { kind: input.correlationKind, callId: meta['callId'], itemId: meta['itemId'], deckentCallId });
    if (!correlation.success) return failure(deckentCallId, 'NATIVE_BRIDGE_CORRELATION_INVALID');
    const call = agentToolCallSchema.safeParse({ id: deckentCallId, name: request.params.name, argumentsJson: JSON.stringify(request.params.arguments ?? {}) });
    if (!call.success || !session.tools.some(tool => tool.name === call.data.name)) return failure(deckentCallId, 'NATIVE_BRIDGE_TOOL_UNKNOWN');
    const key = correlation.data.kind === 'claude-tool-use' ? correlation.data.toolUseId : correlation.data.callId;
    const fingerprint = digest(JSON.stringify(request.params)).toString('hex'), previous = replay.get(key);
    if (previous) return previous.digest === fingerprint ? serve(previous.result, previous.deckentCallId, context.mcpReq.id, context.mcpReq.signal) : failure(deckentCallId, 'NATIVE_BRIDGE_REPLAY_CONFLICT');
    if (closed) return failure(deckentCallId, 'NATIVE_BRIDGE_CLOSED');
    if (replay.size >= limits.replayMaxEntries || replayBytes + bridge.frameMaxBytes > limits.replayMaxBytes) return failure(deckentCallId, 'NATIVE_BRIDGE_REPLAY_LIMIT');
    // Reserve before awaiting K1; duplicates share this promise even during approval. No eviction permits a second effect.
    replayBytes += bridge.frameMaxBytes;
    const pending = Promise.resolve().then(() => propose(call.data, correlation.data, context.mcpReq.signal));
    replay.set(key, { digest: fingerprint, deckentCallId: call.data.id, result: pending });
    // The SDK suppresses a cancelled request's response; explicitly end its SSE instead of keeping it alive forever.
    return serve(pending, call.data.id, context.mcpReq.id, context.mcpReq.signal);
  });
  async function serve(pending: Promise<CallToolResult>, callId: string, id: RequestId, signal: AbortSignal) {
    const cancelled = () => transport.closeSSEStream(id);
    signal.addEventListener('abort', cancelled, { once: true });
    try { const value = await pending; return fits(id, value) ? value : failure(callId, 'NATIVE_BRIDGE_FRAME_LIMIT'); }
    finally { signal.removeEventListener('abort', cancelled); }
  }
  async function propose(call: AgentToolCall, correlation: NativeAgentCorrelation, signal: AbortSignal): Promise<CallToolResult> {
    const deadline = AbortSignal.timeout(session.approvalTtlMs), combined = AbortSignal.any([lifetime.signal, signal, deadline]);
    if (combined.aborted) return failure(call.id, 'NATIVE_BRIDGE_CANCELLED');
    let onAbort = () => {};
    const aborted = new Promise<CallToolResult>(resolve => { onAbort = () => resolve(failure(call.id, 'NATIVE_BRIDGE_CANCELLED')); combined.addEventListener('abort', onAbort, { once: true }); });
    const executed = Promise.resolve().then(() => input.port.propose(call, correlation, combined)).then(value => {
      const parsed = nativeAgentToolResultSchema.safeParse(value);
      if (!parsed.success || parsed.data.turnId !== session.turnId || parsed.data.generation !== session.generation || parsed.data.deckentCallId !== call.id) return failure(call.id, 'NATIVE_BRIDGE_RESULT_INVALID');
      const answer = result(parsed.data, parsed.data.outcome.status === 'error');
      return fits('', answer) ? answer : failure(call.id, 'NATIVE_BRIDGE_FRAME_LIMIT');
    }, () => failure(call.id, 'NATIVE_BRIDGE_RESULT_UNKNOWN'));
    try { return await Promise.race([executed, aborted]); }
    finally { combined.removeEventListener('abort', onAbort); }
  }
  const close = async () => {
    if (closed) return; closed = true; lifetime.abort(); input.signal?.removeEventListener('abort', onAbort);
    for (const response of responses) response.destroy();
    await server.close(); replay.clear();
  };
  const onAbort = () => { void close(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  await server.connect(transport);
  if (input.signal?.aborted) await close();
  async function handle(request: IncomingMessage, response: ServerResponse, count: (bytes: number) => boolean): Promise<void> {
    // Authenticate before reading/parsing the request body. Every method, including GET/DELETE, is turn-bound.
    const token = request.headers[bridge.tokenHeaderName.toLowerCase()];
    if (closed || typeof token !== 'string' || !timingSafeEqual(tokenDigest, digest(token))) { refuseBridge(response, 403, 'NATIVE_BRIDGE_TOKEN_INVALID'); return; }
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${bridge.sentinelHost}`) { refuseBridge(response, 403, 'NATIVE_BRIDGE_ORIGIN_INVALID'); return; }
    if (active >= limits.maxConnections) { refuseBridge(response, 429, 'NATIVE_BRIDGE_CONNECTION_LIMIT'); return; }
    active++; responses.add(response); let rpcKey: string | undefined;
    try {
      const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      let body: unknown;
      if (request.method === 'POST') body = await bridgeBody(request, bridge.bodyMaxBytes, count);
      const rpcId = object(body)['id'];
      if (rpcId !== undefined && !(typeof rpcId === 'string' && rpcId.length > 0 && !rpcId.includes('\0')
        || typeof rpcId === 'number' && Number.isSafeInteger(rpcId))) { refuseBridge(response, 400, 'NATIVE_BRIDGE_REQUEST_INVALID'); return; }
      if (rpcId !== undefined && Buffer.byteLength(JSON.stringify(rpcId)) > bridge.frameMaxBytes / 2) { refuseBridge(response, 400, 'NATIVE_BRIDGE_REQUEST_INVALID'); return; }
      const initialize = object(body)['method'] === 'initialize', offered = request.headers['mcp-session-id'];
      if (initialize ? initializing || sessionId !== undefined || offered !== undefined : sessionId === undefined || offered !== sessionId) {
        refuseBridge(response, 409, 'NATIVE_BRIDGE_SESSION_INVALID'); return;
      }
      if (rpcId !== undefined) {
        const key = `${typeof rpcId}:${String(rpcId)}`;
        if (inFlight.has(key)) { refuseBridge(response, 409, 'NATIVE_BRIDGE_REPLAY_CONFLICT'); return; }
        inFlight.add(key); rpcKey = key;
      }
      if (initialize) initializing = true;
      const source = await transport.handleRequest(new Request(url, { method: request.method ?? 'GET', headers }), body === undefined ? {} : { parsedBody: body });
      await bridgeResponse(source, response, bridge.frameMaxBytes, count, safe);
      if (request.method === 'DELETE' && source.ok) await close();
    } catch (error) {
      if (!response.destroyed) refuseBridge(response, error instanceof Error && error.message === 'NATIVE_BRIDGE_BODY_LIMIT' ? 413 : 400,
        error instanceof Error && error.message === 'NATIVE_BRIDGE_BODY_LIMIT' ? 'NATIVE_BRIDGE_BODY_LIMIT' : 'NATIVE_BRIDGE_REQUEST_INVALID');
    }
    finally { active--; responses.delete(response); if (rpcKey !== undefined) inFlight.delete(rpcKey); }
  }
  return Object.freeze({ sentinelHost: bridge.sentinelHost, path: bridge.path, maxConnections: limits.maxConnections, url,
    toJSON: () => ({ url, turnId: session.turnId, generation: session.generation }),
    /** Only put these into the private Claude MCP file or the explicitly built Codex environment. Never log this object. */
    turnToken, tokenHeader, tokenEnvName: bridge.tokenEnvName, progressIntervalMs, handle, close,
    cancel: async () => { await close(); return input.port.cancel(); }, revoke: async () => { await close(); return input.port.revoke(); } });
}
