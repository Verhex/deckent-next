import { displayAddress } from '#platform/index.js';
import { createHash } from 'node:crypto';
import { endpointMayCarryKey, exactModelIdSchema, OPENAI_CHAT_TOOL_CALLS_CAPABILITY, parseProviderCatalogDocument, type ProviderCatalogDocument } from '#domain/index.js';
import { OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION } from '#adapters/core/provider-openai-chat/index.js';
import { PROVIDER_CONNECT_LIMITS, type ProviderConnectKind } from './registry.js';
import { providerProbeBase, type ProviderProbeOptions } from './probe.js';
import { ProviderModelListError, readProviderPart, providerListHttpError } from './failure.js';
export { ProviderModelListError } from './failure.js';
/** A separate channel for each kind/address: equal API ids at two servers never overwrite each other's profiles. */
export function providerDiscoveryChannel(kind: ProviderConnectKind, endpoint: string | null): string {
  return `${kind.id}-${createHash('sha256').update(providerProbeBase(kind, endpoint)).digest('hex').slice(0, 32)}`;
}
/** Same endpoint/auth/GET transport as the free probe; no redirects, retries, paid request or provider capability inference. */
export async function discoverProviderModels(kind: ProviderConnectKind, endpoint: string | null, key: string | null,
  options: ProviderProbeOptions & { readonly workspaceId?: string } = {}): Promise<readonly string[]> {
  if (!kind.available || !kind.probe?.listsModels) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'not-listable');
  // One key rule (G2-7): a key never travels in cleartext; a plain-http loopback discovery, like its invocation, is anonymous.
  const base = providerProbeBase(kind, endpoint), secure = endpointMayCarryKey(base), credential = secure ? key : null;
  if (secure && kind.key?.required && !credential) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'no-credential');
  const headers: Record<string, string> = { accept: 'application/json', ...kind.probe.headers };
  if (credential) headers[kind.probe.auth.type === 'bearer' ? 'authorization' : kind.probe.auth.name] = kind.probe.auth.type === 'bearer' ? `Bearer ${credential}` : credential;
  if (options.workspaceId) headers['anthropic-workspace-id'] = options.workspaceId;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROVIDER_CONNECT_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const ids = new Set<string>(), cursors = new Set<string>(); let cursor: string | null = null, total = 0, totalBytes = 0;
    for (;;) {
    const url = new URL(`${base}${kind.probe.path}`);
    if (kind.probe.page) { url.searchParams.set(kind.probe.page.limitParam, String(Math.min(kind.probe.page.max, PROVIDER_CONNECT_LIMITS.modelListCount))); if (cursor) url.searchParams.set('after_id', cursor); }
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(url.href, { method: 'GET', headers, redirect: 'manual', signal });
    if (response.status !== 200 || !response.body) {
      throw await providerListHttpError(response, signal, kind.connect?.rejectionCodes);
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await readProviderPart(reader, signal);
      if (part.done) break;
      if (part.value.byteLength > PROVIDER_CONNECT_LIMITS.modelListBytes - totalBytes - bytes) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT');
      chunks.push(part.value); bytes += part.value.byteLength;
    }
    signal.throwIfAborted();
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID'); }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID');
    total += data.length; totalBytes += bytes;
    if (total > PROVIDER_CONNECT_LIMITS.modelListCount) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT');
    for (const row of data) {
      const parsed = exactModelIdSchema.safeParse((row as { id?: unknown } | null)?.id);
      if (!parsed.success || credential && parsed.data.includes(credential)) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID');
      ids.add(parsed.data);
    }
    void reader.cancel().catch(() => undefined); reader = undefined;
    if (!kind.probe.page || (body as { has_more?: unknown }).has_more === false) return Object.freeze([...ids]);
    const next = exactModelIdSchema.safeParse((body as { last_id?: unknown }).last_id);
    if ((body as { has_more?: unknown }).has_more !== true || !next.success || credential && next.data.includes(credential) || cursors.has(next.data) || !data.length) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID');
    if (total >= PROVIDER_CONNECT_LIMITS.modelListCount) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT');
    cursors.add(next.data); cursor = next.data;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error instanceof ProviderModelListError ? error : new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', timeout.aborted ? 'timeout' : 'network',
      undefined, displayAddress(`${base}${kind.probe.path}`));
  } finally { void reader?.cancel().catch(() => undefined); }
}
/** Only the selected exact id becomes a catalog fact. A list is evidence of availability, not tools, vision, context size or reasoning. */
/** BeUser AYSE-16: a keyless loopback server (free) is asked once whether it accepts OpenAI tool calls (one offered tool, one output token; 200 = yes). */
export async function probeLocalToolCalls(kind: ProviderConnectKind, endpoint: string | null, nativeId: string, options: ProviderProbeOptions = {}): Promise<boolean> {
  const base = providerProbeBase(kind, endpoint), path = kind.connect?.chatPath, tool = { type: 'function', function: { name: 'deckent_connect_check', parameters: { type: 'object', properties: {} } } };
  if (!path || endpointMayCarryKey(base) || kind.connect?.adapter !== 'openai-chat-http') return false;
  return ((options.fetch ?? fetch) as unknown as typeof fetch)(`${base}${path}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_CONNECT_LIMITS.timeoutMs), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: nativeId, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, tools: [tool], tool_choice: 'auto' }) }).then(response => { void response.body?.cancel().catch(() => undefined); return response.status === 200; }, () => false);
}
export function discoveredProviderCatalog(kind: ProviderConnectKind, endpoint: string | null, nativeId: string, toolCalls = false): ProviderCatalogDocument {
  const base = providerProbeBase(kind, endpoint), channelId = providerDiscoveryChannel(kind, endpoint);
  const modelId = `model-${createHash('sha256').update(nativeId).digest('hex').slice(0, 32)}`;
  return parseProviderCatalogDocument({ schemaVersion: 2, revision: `${channelId}-${modelId}`, providers: [{ id: channelId, version: 1,
    channel: { kind: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) ? 'local-server' : 'http-api', cli: null, aliases: [] },
    models: [{ id: modelId, version: 1, nativeId, protocols: [{ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION,
      capabilities: toolCalls ? [{ id: OPENAI_CHAT_TOOL_CALLS_CAPABILITY, version: 1, state: 'supported' }] : [] }], lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
      minCliVersion: null, efforts: [], aliases: [] }] }] });
}
