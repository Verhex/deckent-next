import { AuthenticationError } from '#engine/core/authentication/index.js';
import type { ServicePolicyGrant, ServicePolicyTarget } from '#engine/core/policy/index.js';
import { serviceInstanceSchema, serviceActorSchema, shutdownCommandSchema, shutdownAdmissionSchema,
  sameShutdownAdmission, type ServiceActor, type ServiceInstance } from './shutdown-contract.js';
import { ServiceShutdownError, type ServiceShutdownStore, type ServiceShutdownAdmissionResult } from './shutdown-store.js';

export interface ServiceShutdownAuthentication { verify(credential: unknown): Promise<ServiceActor> }
export interface ServiceShutdownAuthorization {
  authorize(target: ServicePolicyTarget, principal: ServiceActor['principal']): Promise<ServicePolicyGrant>;
}

/** This application admits a durable shutdown intent. Only the hosting lifecycle may later stop the service. */
export class ServiceShutdownApplication {
  private readonly instance: ServiceInstance;
  constructor(instance: ServiceInstance, private readonly authentication: ServiceShutdownAuthentication,
    private readonly authorization: ServiceShutdownAuthorization,
    private readonly openStore: () => Promise<ServiceShutdownStore>, private readonly now: () => number) {
    const parsed = serviceInstanceSchema.safeParse(instance);
    if (!parsed.success) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
    this.instance = parsed.data;
  }

  async admit(input: unknown, credential: unknown): Promise<ServiceShutdownAdmissionResult> {
    const parsed = shutdownCommandSchema.safeParse(input);
    if (!parsed.success) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
    let actor: ServiceActor;
    try { actor = serviceActorSchema.parse(await this.authentication.verify(credential)); }
    catch { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); }
    const command = parsed.data;
    if (command.serviceId !== this.instance.serviceId || command.instanceId !== this.instance.instanceId) {
      throw new ServiceShutdownError('SERVICE_SHUTDOWN_INSTANCE');
    }
    // This fresh gate deliberately precedes opening the journal, including every replay.
    const authorization = await this.authorization.authorize(this.instance, actor.principal);
    const admission = shutdownAdmissionSchema.safeParse({ schemaVersion: 1, scopeId: this.instance.scopeId,
      command, actor, authorization, admittedAtMs: this.now() });
    if (!admission.success) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
    try {
      const store = await this.openStore();
      try {
        const result = await store.admitServiceShutdown(admission.data);
        let valid = false;
        try { valid = typeof result.replayed === 'boolean' && sameShutdownAdmission(result.admission, admission.data); }
        catch { /* Stored evidence must match the authenticated request, never a fabricated receipt. */ }
        if (!valid) throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT');
        return Object.freeze({ replayed: result.replayed, admission: shutdownAdmissionSchema.parse(result.admission) });
      } finally { store.close(); }
    } catch (error) {
      if (error instanceof ServiceShutdownError) throw error;
      throw new ServiceShutdownError('SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE');
    }
  }
}
