import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { AuthenticationError, serviceActorSchema, type ServiceActor, type ServiceShutdownAuthentication } from '#engine/index.js';
import type { LocalPeerIdentity } from './peer.js';

/** Converts native SO_PEERCRED evidence into the engine actor. Scope membership is supplied by policy composition. */
export class LocalPeerShutdownAuthentication implements ServiceShutdownAuthentication {
  private readonly scopeIds: readonly string[];
  constructor(private readonly peer: LocalPeerIdentity, scopeIds: readonly string[]) {
    this.scopeIds = Object.freeze([...scopeIds]);
  }

  async verify(credential: unknown): Promise<ServiceActor> {
    try {
      if (credential !== undefined || this.peer.assurance !== 'linux-so-peercred') throw new Error('untrusted');
      const identity = readLocalOsIdentity();
      if (this.peer.uid !== Number(identity.subject)) throw new Error('foreign peer');
      return serviceActorSchema.parse({
        principal: { ...identity, scopeIds: this.scopeIds },
        evidence: { method: 'os-peer', pid: this.peer.pid, uid: this.peer.uid, gid: this.peer.gid },
      });
    } catch { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); }
  }
}
