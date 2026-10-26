import { HUB_LIMITS, PRINCIPAL_EFFECT_PRODUCER, canonicalHubJson, type EffectCommand } from '#domain/index.js';
import { EffectApplication, HubClientError, hubSourceSchema, type HubClientApplication, type HubSource,
  type EffectStore, type EffectApprovalGate, type SessionVerifier, type SessionAuthority, type OperationPolicyAuthorization } from '#engine/index.js';
import { sha256, type TrustedClock } from '#platform/index.js';
import { readHubHttpBody } from './body.js';
import { HubHttpEffectTarget, HUB_NETWORK_OPERATION } from './target.js';
import { HubNetworkError } from './listener.js';
import type { HubHttpTransport, HubHttpResult } from './request.js';

export interface HubFirstUseReceipt {
  readonly scopeId: string; readonly hubId: string; readonly sourceRevision: number; readonly endpoint: string;
  readonly person: { readonly issuer: string; readonly subject: string }; readonly receiptDigest: string;
}
export interface HubFetchDependencies {
  readonly client: HubClientApplication; readonly scopeId: string; readonly hubId: string;
  readonly store: EffectStore; readonly approvals: EffectApprovalGate; readonly sessions: SessionVerifier & SessionAuthority;
  readonly authorization: OperationPolicyAuthorization; readonly clock: TrustedClock; readonly credential?: unknown;
  readonly commandId: () => string;
  /** H9 trusted card owner verifies a durable person decision (including revocation). Absence/deny throws; never defaults to consent. */
  readonly firstUse: (source: HubSource, signal: AbortSignal) => Promise<HubFirstUseReceipt>;
  /** H8/H9 returns only a token issued for the exact resource. Invoked only inside an admitted effect, never logged or retained. */
  readonly accessToken?: (source: HubSource, signal: AbortSignal) => Promise<string | undefined>;
  readonly transport?: HubHttpTransport;
}
/** A fetch function for the official MCP client. Every HTTP request re-reads the authorized registry source and traverses the existing effect application. */
export function createGovernedHubFetch(deps: HubFetchDependencies): typeof fetch {
  return async (input, init) => {
    const original = new Request(input, init), signal = AbortSignal.any([original.signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]);
    signal.throwIfAborted();
    const source = hubSourceSchema.parse((await deps.client.listSources({ schemaVersion: 1, scopeId: deps.scopeId }, deps.credential))
      .find(row => row.hubId === deps.hubId && row.scopeId === deps.scopeId && row.state === 'active'));
    let endpoint: URL;
    try { endpoint = new URL(source.endpoint); } catch { throw new HubNetworkError('HUB_NETWORK_INVALID'); }
    const requested = new URL(original.url);
    if (requested.href !== endpoint.href || !['GET', 'POST'].includes(original.method)) throw new HubNetworkError('HUB_NETWORK_INVALID');
    const consent = await deps.firstUse(source, signal);
    if (!consent || consent.scopeId !== deps.scopeId || consent.hubId !== source.hubId || consent.sourceRevision !== source.revision
      || consent.endpoint !== source.endpoint || !consent.person?.issuer || !consent.person.subject || !/^[a-f0-9]{64}$/.test(consent.receiptDigest)) throw new HubNetworkError('HUB_FIRST_USE_REQUIRED');
    signal.throwIfAborted();
    // Caller-supplied credential/cookie headers cannot bypass audience selection or be persisted in an effect record.
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) {
      const value = original.headers.get(name); if (value !== null) headers.set(name, value);
    }
    let body: Buffer;
    try { body = await readHubHttpBody(original, signal); } catch { throw new HubNetworkError('HUB_NETWORK_INVALID'); }
    const payload = { hubId: source.hubId, sourceRevision: source.revision, endpoint: source.endpoint, local: source.local,
      firstUseReceipt: consent.receiptDigest, method: original.method, headers: Object.fromEntries(headers), bodyDigest: sha256(body), bodyBytes: body.byteLength };
    if (body.length > HUB_LIMITS.httpMaxBytes || Buffer.byteLength(canonicalHubJson(payload)) > HUB_NETWORK_OPERATION.inputMaxBytes) throw new HubNetworkError('HUB_NETWORK_INVALID');
    let result: HubHttpResult | undefined;
    const target = new HubHttpEffectTarget({ endpoint: source.endpoint, local: source.local, input: payload, ...(deps.transport ? { transport: deps.transport } : {}),
      onResult: value => { result = value; }, request: async () => {
        signal.throwIfAborted();
        // Recheck a changed/removed source and person decision after any approval wait and before token resolution or DNS.
        const current = (await deps.client.listSources({ schemaVersion: 1, scopeId: deps.scopeId }, deps.credential)).find(row => row.hubId === source.hubId);
        if (!current || canonicalHubJson(current) !== canonicalHubJson(source)) throw new HubClientError('HUB_SOURCE_NOT_FOUND');
        const latest = await deps.firstUse(source, signal);
        if (canonicalHubJson(latest) !== canonicalHubJson(consent)) throw new HubNetworkError('HUB_FIRST_USE_REQUIRED');
        const token = await deps.accessToken?.(source, signal);
        if (token) {
          if (endpoint.protocol !== 'https:' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new HubNetworkError('HUB_NETWORK_INVALID');
          headers.set('authorization', `Bearer ${token}`);
        }
        signal.throwIfAborted();
        return new Request(endpoint, { method: original.method, headers, signal, ...(original.method === 'POST' ? { body } : {}) });
      } });
    const commandId = deps.commandId();
    const command: EffectCommand = { schemaVersion: 1, commandId, scopeId: deps.scopeId, operation: HUB_NETWORK_OPERATION.operation,
      idempotencyKey: commandId, target: { kind: target.kind, id: sha256(commandId) }, expectedVersion: null, input: payload };
    await new EffectApplication({ resolve: async ref => ref.id === HUB_NETWORK_OPERATION.operation.id && ref.version === 1 ? HUB_NETWORK_OPERATION : null },
      { resolve: kind => kind === target.kind ? target : null }, deps.store, deps.approvals, deps.sessions, deps.authorization, deps.clock, { producer: PRINCIPAL_EFFECT_PRODUCER }).execute(command, deps.credential);
    if (!result || result.outcome !== 'response' || result.status === null) throw new HubNetworkError('HUB_NETWORK_FAILED');
    return new Response(Buffer.from(result.body), { status: result.status, headers: result.headers });
  };
}

