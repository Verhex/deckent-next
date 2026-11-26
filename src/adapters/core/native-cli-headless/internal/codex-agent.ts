import { isDeepStrictEqual } from 'node:util';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { parseCodexExecLine } from '#adapters/core/native-connection/index.js';
import { CODEX_TOOL_ITEM_RESERVATION, type createClaudeAgentDriver, nativeAgentItemReason, observeNativeRefusal, nativeAgentToolResultSchema, nativeCliAgentSchema, nativeAgentBridgeSchema, toolSessionSchema, type NativeAgentToolResult, type ToolSession, type ToolSessionPort } from '#capabilities/index.js';
import type { ModelInvocationDeltaSink } from '#domain/index.js';
import { EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot } from '#platform/index.js';
import { refuse } from './contract.js';
import { headlessArgv } from './env.js';
import { codexTurn } from './codex.js';
import type { HeadlessPreflight } from './preflight.js';
import { emitDelta, reject, type HeadlessTurn, type Prepared, type Refusal } from './turn.js';
export type CodexAgentResultLookup = (deckentCallId: string) => Readonly<{ call: Parameters<ToolSessionPort['propose']>[0]; result: NativeAgentToolResult; active?: () => boolean; recordedError?: () => ReturnType<NonNullable<ToolSessionPort['recordedError']>>; selectedText?: () => string | undefined }> | undefined;
const MILLISECONDS_PER_SECOND = 1000; // Unit conversion, never a timeout policy.
export function codexAgentArgv(entry: NonNullable<ReturnType<typeof nativeCliAgent>>, session: ToolSession, runDir: string, model: string, effortArgs: readonly string[], bridgeUrl: string): readonly string[] {
  const { agent, bridge } = entry, transport = agent.transport;
  if (transport.kind !== 'codex-mcp' || !nativeCliAgentSchema.safeParse(agent).success || !nativeAgentBridgeSchema.safeParse(bridge).success || !toolSessionSchema.safeParse(session).success) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  let url: URL; try { url = new URL(bridgeUrl); } catch { refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' }); }
  if (url.protocol !== 'http:' || url.hostname !== bridge.sentinelHost || url.pathname !== bridge.path || url.port || url.username || url.password || url.search || url.hash) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const values: Record<string, unknown> = { ...transport.mcpConfig, url: url.href, bearer_token_env_var: bridge.tokenEnvName, enabled_tools: session.tools.map(tool => tool.name), tool_timeout_sec: session.approvalTtlMs / MILLISECONDS_PER_SECOND }, server = `{ ${Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`;
  return Object.freeze([...headlessArgv({ ...entry, headless: { ...entry.headless, args: agent.args, forbiddenFlags: agent.forbiddenFlags } }, runDir, model, effortArgs), transport.configFlag, `mcp_servers.${bridge.serverName}=${server}`]);
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function toolResult(value: unknown): NativeAgentToolResult | null { const result = record(value), content = result?.['content']; if (!Array.isArray(content) || content.length !== 1) return null;
  const block = record(content[0]); if (block?.['type'] !== 'text' || typeof block['text'] !== 'string') return null;
  let decoded: unknown; try { decoded = JSON.parse(block['text']); } catch { return null; }
  const parsed = nativeAgentToolResultSchema.safeParse(decoded); if (!parsed.success || result?.['structured_content'] != null && !isDeepStrictEqual(result['structured_content'], parsed.data)) return null; return parsed.data; }
/** Observes K4 results, never executes: item.id is stream lifecycle; deckentCallId is facade custody. Caller owns bounds and stop-on-refusal. */
export function codexAgentTurn(prepared: Prepared, preflight: HeadlessPreflight, session: ToolSession, lookup: CodexAgentResultLookup, onDelta?: ModelInvocationDeltaSink, knownSecrets: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS, signal?: AbortSignal, wire?: Parameters<typeof createClaudeAgentDriver>[0]['planning']) {
  const entry = prepared.entry.headless.protocolFamily ? nativeCliAgent(prepared.entry.headless.protocolFamily) : null;
  if (!entry || entry.agent.transport.kind !== 'codex-mcp' || !toolSessionSchema.safeParse(session).success || !('maxNotices' in entry.headless.guards)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const beforeDelivery = new Set<string>();
  const base = codexTurn(prepared, preflight, '', undefined, knownSecrets, answer => wire?.active ? wire.response() : answer), active = new Map<string, Record<string, unknown>>(), seen = new Set<string>(), calls = new Set<string>(), pendingText = new Map<string, string>(), maxNotices = entry.headless.guards.maxNotices;
  let threadId: string | undefined, turnId: string | undefined, conflictingIdentity = false;
  let proseEndsWithWhitespace = true, toolBetweenProse = false;
  // Reserve synchronously before either driver can delegate to its tool session.
  const reserved = new WeakMap<object, string>();
  let thread = false, started = false, completed = false, notices = 0, refusal: Refusal | null = null;
  const fail = (field: string) => refusal ??= reject('invalid-response', { refusal: 'guard', field });
  // Card R4-C: `observer` hears only the mcp-item-reservation branch (more than one active match, or an item held for another call).
  return { refusal: () => refusal, accepts(call: Parameters<ToolSessionPort['propose']>[0], observer?: Pick<ToolSessionPort, 'session' | 'observeRefusal'>): boolean {
      if (refusal || !started || completed) return false;
      let args: unknown; try { args = JSON.parse(call.argumentsJson); } catch { return false; }
      const matches = [...active.values()].filter(item => item['tool'] === call.name && isDeepStrictEqual(item['arguments'], args));
      const item = matches[0];
      if (!item) return false;
      const previous = reserved.get(item);
      if (matches.length !== 1 || previous !== undefined && previous !== call.id) {
        fail(CODEX_TOOL_ITEM_RESERVATION); observeNativeRefusal(observer, 'item-reservation', call, call.name);
        return false;
      }
      reserved.set(item, call.id);
      return true;
    }, line(raw: string) {
      if (refusal) return refusal; const line = parseCodexExecLine(raw);
      if (line.kind === 'invalid') return line.reason === 'blank' ? null : fail('json'); if (completed) return fail('after-turn');
      const { type, item, data } = line;
      if (wire) {
        conflictingIdentity ||= data.thread_id !== undefined && threadId !== undefined && data.thread_id !== threadId
          || data.turn_id !== undefined && turnId !== undefined && data.turn_id !== turnId;
        if (wire.active && conflictingIdentity) return fail('planning-identity');
        if (typeof data.turn_id === 'string' && data.turn_id) turnId ??= data.turn_id;
      }
      if (type === 'thread.started') {
        if (thread || typeof data.thread_id !== 'string' || !data.thread_id) return fail('thread');
        thread = true; threadId = data.thread_id; wire?.session(threadId);
      } else if (type === 'turn.started') { if (!thread || started) return fail('turn'); started = true; }
      else if (type.startsWith('item.')) {
        if (nativeAgentItemReason(entry.agent, item)) return fail('item');
        if (item?.type === 'error') { if (!thread || started || type !== 'item.completed' || ++notices > maxNotices) return fail('notice'); return null; }
        if (!started || !item || typeof item.id !== 'string' || !item.id || !['item.started', 'item.updated', 'item.completed'].includes(type)) return fail('item-order');
        if (type === 'item.completed' && item.type === 'agent_message' && typeof item.text !== 'string') return fail('item-text'); if (seen.has(item.id)) return fail('item-replay'); if (active.has(item.id) && item.type !== 'mcp_tool_call') return fail('item-order'); if (pendingText.has(item.id) && pendingText.get(item.id) !== item.type) return fail('item-order');
        if (item.type === 'mcp_tool_call') {
          if (item.server !== entry.bridge.serverName || !session.tools.some(tool => tool.name === item.tool) || !record(item.arguments)) return fail('mcp-tool');
          const identity = { server: item.server, tool: item.tool, arguments: item.arguments }, prior = active.get(item.id);
          if (type === 'item.started') {
            if (wire?.active) return fail('planning-tool');
            if (prior || item.status !== 'in_progress' || item.result != null || item.error != null) return fail('mcp-start');
            active.set(item.id, identity); return null;
          }
          if (!prior || !isDeepStrictEqual(prior, identity)) return fail('mcp-order');
          if (type === 'item.updated') return item.status === 'in_progress' && item.result == null && item.error == null ? null : fail('mcp-update');
          const envelope = toolResult(item.result);
          if (signal?.aborted || item.error != null || !envelope || envelope.turnId !== session.turnId || envelope.generation !== session.generation || calls.has(envelope.deckentCallId)) return fail('mcp-result');
          const recorded = lookup(envelope.deckentCallId); let argumentsValue: unknown;
          try { argumentsValue = recorded ? JSON.parse(recorded.call.argumentsJson) : undefined; } catch { return fail('mcp-correlation'); }
          if (!recorded || recorded.active?.() === false || recorded.call.name !== item.tool || !isDeepStrictEqual(argumentsValue, item.arguments)) return fail('mcp-correlation');
          if (recorded.result.outcome.status === 'ok') {
            if (item.status !== 'completed') return fail('mcp-result');
            if (!isDeepStrictEqual(recorded.result, envelope)) return fail('mcp-correlation');
          } else {
            // Completed keeps today's error-field rule (absent or null, checked above); a failed completion needs the explicit null the wire evidence shows.
            if (item.status === 'failed' ? item.error !== null : item.status !== 'completed') return fail('mcp-result');
            const content = record(item.result)?.['content'] as readonly unknown[];
            if (envelope.outcome.status !== 'error' || recorded.call.id !== envelope.deckentCallId || reserved.get(prior) !== recorded.call.id
              || recorded.recordedError?.() !== 'ordinary' || recorded.selectedText?.() !== record(content[0])?.['text']
              || !isDeepStrictEqual(recorded.result, envelope)) return fail('mcp-correlation');
          }
          if (wire?.active) {
            const errorFlag = record(item.result)?.isError;
            if (wire.delivered || envelope.outcome.status !== 'ok' || errorFlag !== undefined && errorFlag !== false) return fail('planning-delivery');
            wire.delivery(envelope);
          }
          toolBetweenProse = true;
          calls.add(envelope.deckentCallId); seen.add(item.id); active.delete(item.id); return null;
        }
        if (wire && item.type === 'agent_message') {
          if (!wire.delivered) beforeDelivery.add(item.id);
          else if (beforeDelivery.has(item.id) || data.parent_tool_use_id != null || item.parent_id != null || item.parent_tool_use_id != null || data.parent_id != null
            || item.role !== undefined && item.role !== 'assistant' || item.finish_reason != null && item.finish_reason !== 'stop') return fail('planning-message');
          else if (type === 'item.completed') wire.terminal(item.id, item.text as string);
        }
        if (type === 'item.started') { if (pendingText.has(item.id)) return fail('item-order'); pendingText.set(item.id, item.type as string); }
        else if (type === 'item.updated' && !pendingText.has(item.id)) return fail('item-order');
        if (type === 'item.completed') { seen.add(item.id); pendingText.delete(item.id); }
      } else if (type === 'turn.completed') {
        if (wire?.active && [data.stop_reason, data.finish_reason].some(reason => reason != null && reason !== 'stop')) return fail('planning-finish');
        if (!started || active.size) return fail('pending-tools'); if (pendingText.size) return fail('pending-items'); completed = true;
      } else if (wire?.active && type === 'error') return fail('planning-interrupted');
      else if (type !== 'error' && type !== 'turn.failed') return fail('event');
      refusal = base.line(raw);
      if (!refusal && type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        const text = item.text;
        emitDelta(onDelta, toolBetweenProse && !proseEndsWithWhitespace && !/^\s/u.test(text) ? '\n\n' + text : text);
        toolBetweenProse = false;
        proseEndsWithWhitespace = /\s$/u.test(text);
      }
      return refusal;
    },
    end(exit: Parameters<HeadlessTurn['end']>[0], egress: Parameters<HeadlessTurn['end']>[1]) { return refusal ? { refusal } : completed && !active.size ? base.end(exit, egress) : null; },
  };
}
