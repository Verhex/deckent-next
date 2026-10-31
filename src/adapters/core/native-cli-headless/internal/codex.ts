import { headlessEgressReasons, type ModelInvocationDeltaSink } from '#domain/index.js';
import { nativeQuotaPolicy, parseCodexExecLine } from '#adapters/core/native-connection/index.js';
import { refuse } from './contract.js';
import { emitDelta, reject, type HeadlessTurn, type Prepared, type Refusal } from './turn.js';
import type { HeadlessPreflight } from './preflight.js';

/** Tool items the worker normalizer knows by name (pinned SDK item types); any other disallowed item is guarded as `item`. */
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const matches = (patterns: readonly string[], text: string) => patterns.some(pattern => new RegExp(pattern, 'iu').test(text));

/**
 * The `codex exec --json` turn (Codex headless, 2026-10-31): one thread, one turn, only the registry's allowed items (the answer and its reasoning).
 * Any tool item, a second thread or turn, or an error line stops the process: an error's text maps to quota (providers.json patterns, the worker's
 * own source) or login (registry patterns), otherwise invalid output. The answer is the last completed agent message (each completed message is
 * also a presentation delta). The stream names no model: the answer is attributed to the argv-pinned id (`modelEvidence: argv`).
 */
export function codexTurn(prepared: Prepared, preflight: HeadlessPreflight, _runDir: string, onDelta?: ModelInvocationDeltaSink): HeadlessTurn {
  const { guards } = prepared.entry.headless;
  if (!('allowedItems' in guards)) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const quotaPatterns = nativeQuotaPolicy().codexPatterns;
  let thread = false, turns = 0, answer: string | null = null, usage: Record<string, unknown> | null = null;
  const failure = (text: string | null, subtype: string): Refusal => text !== null && matches(quotaPatterns, text) ? reject('http-status', { refusal: 'quota', status: null, resetsAtMs: null })
    : text !== null && matches(guards.loginPatterns, text) ? reject('http-status', { refusal: 'login-required', status: null }) : reject('invalid-response', { refusal: 'invalid-output', subtype });
  return {
    line(raw) {
      const line = parseCodexExecLine(raw);
      if (line.kind === 'invalid') return null;
      const { type, item } = line;
      if (type === 'thread.started') { if (thread) return reject('invalid-response', { refusal: 'guard', field: 'thread' }); thread = true; return null; }
      if (type === 'turn.started') return ++turns > prepared.entry.headless.maxTurns || !thread ? reject('invalid-response', { refusal: 'guard', field: 'turn' }) : null;
      if (type === 'error' || type === 'turn.failed') return failure(line.errorText, type);
      if (type.startsWith('item.')) {
        const kind = typeof item?.type === 'string' ? item.type : null;
        if (kind === 'error') return failure(line.errorText, 'error');
        if (kind === null || !guards.allowedItems.includes(kind)) return reject('invalid-response', { refusal: 'guard', field: kind !== null && TOOL_ITEMS.has(kind) ? `item.${kind}` : 'item' });
        if (turns === 0) return reject('invalid-response', { refusal: 'guard', field: 'turn' });
        if (type === 'item.completed' && kind === 'agent_message' && typeof item!.text === 'string') { answer = item!.text; if (answer) emitDelta(onDelta, answer); }
        return null;
      }
      if (type === 'turn.completed') {
        if (turns !== 1 || usage) return reject('invalid-response', { refusal: 'guard', field: 'turn' });
        // A missing usage record is unknown, never a measured zero.
        const reported = line.data.usage;
        if (!reported || typeof reported !== 'object' || Array.isArray(reported)) return reject('invalid-response', { refusal: 'guard', field: 'usage' });
        usage = reported as Record<string, unknown>;
      }
      return null;
    },
    end(exit, egress) {
      if (!usage || !exit.exited || exit.exitCode !== 0) return null;
      // A completed turn without an answer is no answer.
      if (answer === null) return { refusal: reject('invalid-response', { refusal: 'invalid-output', subtype: 'no-answer' }) };
      // OpenAI input totals include cache reads and writes (the worker normalizer's rule); the response counts them apart, as for Claude.
      const total = count(usage.input_tokens), cacheRead = count(usage.cached_input_tokens), cacheWrite = count(usage.cache_write_input_tokens);
      const input = Math.max(0, total - cacheRead - cacheWrite), output = count(usage.output_tokens);
      return { response: Object.freeze({ schemaVersion: 1 as const, native: { object: 'chat.completion', model: prepared.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        headless: { cliVersion: preflight.version, flagSetDigest: preflight.flagSetDigest, guard: 'passed', stopReason: null, modelEvidence: 'argv', egress: { ...egress, ...headlessEgressReasons(egress) } } },
      usage: { prompt_tokens: input + cacheRead + cacheWrite, completion_tokens: output, total_tokens: input + cacheRead + cacheWrite + output, cache_read: cacheRead, cache_write: cacheWrite,
        modelUsage: { [prepared.model]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite } }, quota: {} } }) };
    },
  };
}
