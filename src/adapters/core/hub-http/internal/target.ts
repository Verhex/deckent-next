import { HUB_LIMITS, canonicalHubJson } from '#domain/index.js';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { hubHttpRequest, type HubHttpResult, type HubHttpTransport } from './request.js';

export const HUB_NETWORK_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: { id: 'network.hub', version: 1 }, targetKind: 'hub-http',
  effectClass: 'write' as const, approval: 'policy' as const, precondition: 'none' as const, compensation: null, inputMaxBytes: HUB_LIMITS.networkInputMaxBytes });
/** Ephemeral target bound to one command. Bearer tokens stay outside the effect input/digest/audit. */
export class HubHttpEffectTarget implements EffectTarget {
  readonly kind = HUB_NETWORK_OPERATION.targetKind;
  constructor(private readonly options: { readonly endpoint: string; readonly local: boolean; readonly input: unknown;
    readonly request: () => Promise<Request>; readonly onResult: (result: HubHttpResult) => void; readonly transport?: HubHttpTransport }) {}
  identity() { return this.options.endpoint; }
  async observe() { return { version: null }; }
  async apply(request: EffectApplyRequest) {
    if (request.operation.id !== HUB_NETWORK_OPERATION.operation.id || request.operation.version !== HUB_NETWORK_OPERATION.operation.version
      || sha256(canonicalHubJson(request.input)) !== sha256(canonicalHubJson(this.options.input))) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    let outgoing: Request;
    try { outgoing = await this.options.request(); } catch (cause) { throw new EffectTargetError('EFFECT_TARGET_REJECTED', { cause }); }
    if (outgoing.url !== this.options.endpoint) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const result = await hubHttpRequest(outgoing, this.options);
    this.options.onResult(result);
    if (result.outcome === 'refused') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    if (result.outcome === 'unknown') throw new EffectTargetError('EFFECT_TARGET_UNKNOWN');
    return { version: null };
  }
  /** HTTP has no idempotency read. Never send again to guess the outcome. */
  async lookup() { return null; }
}
