import { createHash } from 'node:crypto';
import { exactModelIdSchema, parseProviderCatalogDocument, type ProviderCatalogDocument } from '#domain/index.js';
import { OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION } from '#adapters/core/provider-openai-chat/index.js';
import { PROVIDER_CONNECT_LIMITS, type ProviderConnectKind } from './registry.js';
import { providerProbeBase, type ProviderProbeOptions } from './probe.js';

export class ProviderModelListError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' | 'MODEL_CONNECT_DISCOVERY_INVALID' | 'MODEL_CONNECT_DISCOVERY_LIMIT') {
    super(code); this.name = 'ProviderModelListError';
  }
}
/** A separate channel for each kind/address: equal API ids at two servers never overwrite each other's profiles. */
export function providerDiscoveryChannel(kind: ProviderConnectKind, endpoint: string | null): string {
  return `${kind.id}-${createHash('sha256').update(providerProbeBase(kind, endpoint)).digest('hex').slice(0, 32)}`;
}
/** A stalled body cannot outlive the request deadline, including a host-injected transport that does not cancel its stream. */
async function readPart(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
/** Same endpoint/auth/GET transport as the free probe; no redirects, retries, paid request, pagination or provider capability inference. */
export async function discoverProviderModels(kind: ProviderConnectKind, endpoint: string | null, key: string | null,
  options: ProviderProbeOptions = {}): Promise<readonly string[]> {
  if (!kind.available || kind.connect?.seed !== null || !kind.probe?.listsModels) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE');
  const base = providerProbeBase(kind, endpoint), secure = new URL(base).protocol === 'https:';
  // A key never travels in cleartext. A plain-http loopback discovery, like its invocation, is anonymous.
  const credential = secure ? key : null;
  if (secure && kind.key?.required && !credential) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE');
  const headers: Record<string, string> = { accept: 'application/json', ...kind.probe.headers };
  if (credential) headers[kind.probe.auth.type === 'bearer' ? 'authorization' : kind.probe.auth.name] = kind.probe.auth.type === 'bearer' ? `Bearer ${credential}` : credential;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROVIDER_CONNECT_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(`${base}${kind.probe.path}`, { method: 'GET', headers, redirect: 'manual', signal });
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await readPart(reader, signal);
      if (part.done) break;
      if (part.value.byteLength > PROVIDER_CONNECT_LIMITS.modelListBytes - bytes) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT');
      chunks.push(part.value); bytes += part.value.byteLength;
    }
    signal.throwIfAborted();
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID'); }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID');
    if (data.length > PROVIDER_CONNECT_LIMITS.modelListCount) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_LIMIT');
    const ids = new Set<string>();
    for (const row of data) {
      const parsed = exactModelIdSchema.safeParse((row as { id?: unknown } | null)?.id);
      if (!parsed.success || credential && parsed.data.includes(credential)) throw new ProviderModelListError('MODEL_CONNECT_DISCOVERY_INVALID');
      ids.add(parsed.data);
    }
    return Object.freeze([...ids]);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error instanceof ProviderModelListError ? error : new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE');
  } finally { void reader?.cancel().catch(() => undefined); }
}
/** Only the selected exact id becomes a catalog fact. A list is evidence of availability, not tools, vision, context size or reasoning. */
export function discoveredProviderCatalog(kind: ProviderConnectKind, endpoint: string | null, nativeId: string): ProviderCatalogDocument {
  const base = providerProbeBase(kind, endpoint), channelId = providerDiscoveryChannel(kind, endpoint);
  const modelId = `model-${createHash('sha256').update(nativeId).digest('hex').slice(0, 32)}`;
  return parseProviderCatalogDocument({ schemaVersion: 2, revision: `${channelId}-${modelId}`, providers: [{ id: channelId, version: 1,
    channel: { kind: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) ? 'local-server' : 'http-api', cli: null, aliases: [] },
    models: [{ id: modelId, version: 1, nativeId, protocols: [{ family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION,
      capabilities: [] }], lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
      minCliVersion: null, efforts: [], aliases: [] }] }] });
}
