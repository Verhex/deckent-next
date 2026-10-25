import { ProviderModelListError, readProviderPart, providerListHttpError } from './failure.js';
import { z } from 'zod';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID, parseAnthropicMessagesDefinition } from '#adapters/core/provider-anthropic-messages/index.js';
import { PROVIDER_CONNECT_KINDS, PROVIDER_CONNECT_LIMITS, type ProviderConnectKind } from './registry.js';
import type { ProviderProbeOptions } from './probe.js';
const workspace = z.object({ id: z.string().regex(/^wrkspc_[A-Za-z0-9]{1,120}$/u), name: z.string().min(1).max(256), archived_at: z.string().nullable() });
const page = z.object({ data: z.array(workspace), has_more: z.boolean(), last_id: z.string().nullable() });
export type ProviderWorkspace = Readonly<{ id: string; name: string }>;
/** Registry-pinned free metadata read. Redirects, incomplete pagination, invalid data and excess bytes fail closed. */
export async function listProviderWorkspaces(profile: unknown, key: string, options: ProviderProbeOptions = {}): Promise<readonly ProviderWorkspace[]> {
  const parsed = modelInvocationProfileSchema.parse(profile); if (parsed.adapter.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'not-listable');
  const definition = parseAnthropicMessagesDefinition(parsed.adapter.definition);
  const kind = PROVIDER_CONNECT_KINDS.find(row => row.connect?.workspaceList && row.endpoint.default !== null
    && new URL(row.connect.chatPath!, row.endpoint.default).href === definition.endpoint);
  if (!kind) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'not-listable'); return listKindProviderWorkspaces(kind, definition.endpoint, key, options);
}
export async function listKindProviderWorkspaces(kind: ProviderConnectKind, endpoint: string, key: string, options: ProviderProbeOptions = {}): Promise<readonly ProviderWorkspace[]> {
  if (!kind.connect?.workspaceList || !kind.probe || kind.endpoint.default === null
    || new URL(endpoint).origin !== new URL(kind.endpoint.default).origin) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'not-listable');
  const limits = kind.connect.workspaceList, rows: ProviderWorkspace[] = [], seen = new Set<string>();
  if (!key) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'no-credential');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROVIDER_CONNECT_LIMITS.timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let cursor: string | null = null;
  try { for (let index = 0; index < limits.maxPages; index++) {
    const url = new URL(limits.path, endpoint); url.searchParams.set('include_default', 'true'); url.searchParams.set('limit', String(limits.pageSize));
    if (cursor) url.searchParams.set('after_id', cursor);
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(url.href, { method: 'GET', redirect: 'manual', signal,
      headers: { ...kind.probe.headers, authorization: `Bearer ${key}`, accept: 'application/json' } });
    if (response.status !== 200 || !response.body) throw await providerListHttpError(response, signal, kind.connect.rejectionCodes);
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body.getReader(); try {
      for (;;) { const next = await readProviderPart(reader, signal); if (next.done) break; bytes += next.value.byteLength;
        if (bytes > limits.maxResponseBytes) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID', 'invalid-list'); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let data: z.infer<typeof page>;
    try { data = page.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch { throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID', 'invalid-list'); }
    if (data.data.length > limits.pageSize) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID', 'invalid-list');
    for (const row of data.data) if (row.archived_at === null && !rows.some(item => item.id === row.id))
      rows.push({ id: row.id, name: row.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ') });
    if (!data.has_more) return Object.freeze(rows.map(row => Object.freeze(row)));
    if (!data.last_id || seen.has(data.last_id)) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID', 'invalid-list');
    seen.add(data.last_id); cursor = data.last_id; }
  throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT', 'invalid-list');
  } catch (error) { options.signal?.throwIfAborted();
    if (error instanceof ProviderModelListError) throw error;
    throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', timeout.aborted ? 'timeout' : 'network');
  }
}
/** Only a row from the complete fresh discovery can supply the header. */
export function providerProfileWorkspaceOffer(profile: unknown, selected: ProviderWorkspace, choices: readonly ProviderWorkspace[]) {
  const value = modelInvocationProfileSchema.parse(profile); if (value.adapter.id !== ANTHROPIC_MESSAGES_HTTP_ADAPTER_ID || !choices.some(row => row.id === selected.id && row.name === selected.name)) return null;
  const definition = parseAnthropicMessagesDefinition({ ...value.adapter.definition, workspaceId: selected.id });
  if (value.adapter.definition['workspaceId'] === selected.id) return null;
  return { next: { ...value, version: value.version + 1, adapter: { ...value.adapter, definition } }, detail: selected };
}
