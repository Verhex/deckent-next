import { createHash } from 'node:crypto';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
export interface RemovalService {
  readonly resourceId: string; readonly installationId: string; readonly manager: 'systemd' | 'launchd' | 'scm';
  readonly scope: 'user' | 'system'; readonly unit: string; readonly ownershipDigest: string;
}
export interface ServiceObservation {
  readonly ownershipDigest: string | null; readonly active: boolean | null; readonly enabled: boolean | null;
  readonly present: boolean | null; readonly mainPid: number | null;
  readonly also: readonly string[]; readonly triggers: readonly string[]; readonly foreignArtifacts: boolean;
  readonly callerInService: boolean; readonly revision: string;
}
/** The manager owner implements bounded native commands and exact recorded-unit file removal. No shell strings or elevation here. */
export interface ServiceRemovalDriver {
  readonly identity: string;
  withCustody<T>(service: RemovalService, work: () => Promise<T>): Promise<T>;
  inspect(service: RemovalService): Promise<ServiceObservation>;
  stop(service: RemovalService): Promise<void>; disable(service: RemovalService): Promise<void>;
  removeOwnedArtifacts(service: RemovalService): Promise<void>; reload(service: RemovalService): Promise<void>;
}
const version = (value: ServiceObservation) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rejected = (): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED'); };
const gone = (value: ServiceObservation) => value.present === false && value.active === false && value.enabled === false && value.mainPid === 0;
function guard(service: RemovalService, observed: ServiceObservation) {
  if (process.platform !== 'linux' || service.manager !== 'systemd' || observed.ownershipDigest !== service.ownershipDigest || !/^[a-f0-9]{64}$/u.test(service.ownershipDigest)
    || observed.present === null || observed.active === null || observed.enabled === null || observed.mainPid === null
    || observed.also.length || observed.triggers.length || observed.foreignArtifacts || observed.callerInService) rejected();
}
/** Generic effect target: every native postcondition is observed; a successful stop/disable request is insufficient. */
export class InstallationServiceRemovalTarget implements EffectTarget {
  readonly kind = 'installation-service';
  constructor(private readonly resources: readonly RemovalService[], private readonly driver: ServiceRemovalDriver) {}
  identity() { return this.driver.identity; }
  private resource(id: string) { const found = this.resources.find(item => item.resourceId === id); return found ?? rejected(); }
  async observe(target: { kind: string; id: string }) {
    if (target.kind !== this.kind) rejected();
    return { version: version(await this.driver.inspect(this.resource(target.id))) };
  }
  async apply(request: EffectApplyRequest) {
    if (request.operation.id !== 'installation.remove-service' || request.operation.version !== 1 || request.target.kind !== this.kind) rejected();
    const service = this.resource(request.target.id);
    return this.driver.withCustody(service, async () => {
      const observed = await this.driver.inspect(service); guard(service, observed);
      if (version(observed) !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      let started = false;
      try {
        if (gone(observed)) return { version: null };
        started = true; await this.driver.stop(service);
        let current = await this.driver.inspect(service); guard(service, current);
        if (current.active !== false || current.mainPid !== 0) throw new Error('SERVICE_NOT_STOPPED');
        await this.driver.disable(service);
        current = await this.driver.inspect(service); guard(service, current);
        if (current.enabled !== false || current.active !== false || current.mainPid !== 0) throw new Error('SERVICE_NOT_DISABLED');
        await this.driver.removeOwnedArtifacts(service); await this.driver.reload(service);
        if (!gone(await this.driver.inspect(service))) throw new Error('SERVICE_NOT_ABSENT');
        return { version: null };
      } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
    });
  }
  async lookup(target: { kind: string; id: string }, idempotencyKey: string) {
    void idempotencyKey;
    if (target.kind !== this.kind) rejected();
    const observed = await this.driver.inspect(this.resource(target.id));
    // No receipt exists for a partially stopped/disabled service: preserve uncertainty instead of resending.
    return gone(observed) && !observed.foreignArtifacts ? { status: 'applied' as const, version: null } : null;
  }
}
