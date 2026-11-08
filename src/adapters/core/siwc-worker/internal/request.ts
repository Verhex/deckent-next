import { SIWC_REQUEST_RULES, SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';

export type SiwcRelayRefusal = 'peer' | 'capability' | 'replay' | 'endpoint' | 'shape' | 'model' | 'tool' | 'bound' | 'authority' | 'closed' | 'upstream';
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/**
 * U9-6b: the only request the relay forwards — the bound app-server's Responses body for the admitted model, re-serialized from its parsed
 * fields: registry field allowlist, SIWC store/stream invariants, local function/custom tools only (no hosted tool, MCP, file or search
 * type). Anything else is a typed refusal before any lease or send.
 */
export function siwcWorkerRequestBody(raw: string, model: string): Readonly<{ body: string } | { refusal: SiwcRelayRefusal }> {
  let parsed: Record<string, unknown> | null;
  try { parsed = object(JSON.parse(raw)); } catch { parsed = null; }
  if (!parsed || Object.keys(parsed).some(key => !R.requestFields.includes(key) || SIWC_REQUEST_RULES.forbiddenFields.includes(key))
    || parsed['store'] !== SIWC_REQUEST_RULES.store || parsed['stream'] !== SIWC_REQUEST_RULES.stream || !Array.isArray(parsed['input'])) return { refusal: 'shape' };
  if (parsed['model'] !== model) return { refusal: 'model' };
  const tools = parsed['tools'] ?? [];
  const local = (tool: unknown): boolean => { const row = object(tool), type = row?.['type'];
    return typeof type === 'string' && R.toolTypes.includes(type) && (type !== 'namespace' || Array.isArray(row?.['tools']) && (row['tools'] as unknown[]).every(inner => object(inner)?.['type'] !== 'namespace' && local(inner))); };
  if (!Array.isArray(tools) || !tools.every(local)) return { refusal: 'tool' };
  return { body: JSON.stringify(parsed) };
}
export { secretScrubber } from '#adapters/core/native-connection/index.js';
