import type { TrustedClock } from '#platform/index.js';
import { LocalOsSessionAuthority, readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { AuthenticationError, serviceActorSchema, type ServiceActor, type ServiceShutdownAuthentication } from '#engine/index.js';
import type { LocalPeerIdentity } from './peer.js';

/** Only kernel-supplied peer evidence may reach this adapter. It confers no policy scopes. */
export function verifyLocalPeerIdentity(peer: LocalPeerIdentity, credential?: unknown): ReturnType<typeof readLocalOsIdentity> {
  try {
    if (credential !== undefined || peer.assurance !== 'linux-so-peercred'
      || ![peer.pid, peer.uid, peer.gid].every(value => Number.isSafeInteger(value) && value >= 0) || peer.pid === 0) {
      throw new Error('untrusted');
    }
    const identity = readLocalOsIdentity();
    if (peer.uid !== Number(identity.subject)) throw new Error('foreign peer');
    return identity;
  } catch { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); }
}

/** Converts native SO_PEERCRED evidence into the engine actor. Scope membership is supplied by policy composition. */
export class LocalPeerShutdownAuthentication implements ServiceShutdownAuthentication {
  private readonly scopeIds: readonly string[];
  constructor(private readonly peer: LocalPeerIdentity, scopeIds: readonly string[]) {
    this.scopeIds = Object.freeze([...scopeIds]);
  }

  async verify(credential: unknown): Promise<ServiceActor> {
    try {
      const identity = verifyLocalPeerIdentity(this.peer, credential);
      return serviceActorSchema.parse({
        principal: { ...identity, scopeIds: this.scopeIds },
        evidence: { method: 'os-peer', pid: this.peer.pid, uid: this.peer.uid, gid: this.peer.gid },
      });
    } catch { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); }
  }
}

/** Privileged decisions require the native connection witness, not a client-supplied PID. */
export async function createLocalPeerSession(peer: LocalPeerIdentity, scopeIds: readonly string[],
  lifetimeMs: number, clock: TrustedClock) {
  verifyLocalPeerIdentity(peer);
  if (!peer.connection || peer.connection.aborted || !peer.isConnectionActive?.()) throw new AuthenticationError('AUTHENTICATION_REQUIRED');
  return LocalOsSessionAuthority.create(scopeIds, lifetimeMs, clock,
    { pid: peer.pid, uid: peer.uid, connection: peer.connection, isConnectionActive: peer.isConnectionActive });
}
