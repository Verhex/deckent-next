import { userInfo, hostname } from 'node:os';
import { mcpPrincipalRef, verifiedPrincipalSchema } from '#domain/index.js';
import { localPrincipalChannel } from './channel.js';
import { AuthenticationError, type PrincipalVerifier } from '#engine/index.js';

/** Direct local process only. This verifies the current OS user, NOT a remote socket's peer.
 * Never install this verifier on an API/MCP network listener; use that transport's real verifier.
 */
export class LocalOsPrincipalVerifier implements PrincipalVerifier {
  private readonly scopes: readonly string[];
  constructor(scopeIds: readonly string[]) { this.scopes = Object.freeze([...scopeIds]); }
  async verify(credential: unknown) {
    if (credential !== undefined) throw new AuthenticationError('AUTHENTICATION_REQUIRED');
    return verifiedPrincipalSchema.parse({ ...readLocalOsIdentity(), scopeIds: this.scopes });
  }
}

/** The OS account this process runs as, whatever the channel: the person a local login file (owned by this uid) belongs to. */
export function readLocalOsOwner() {
  const user = userInfo();
  if (!user.username || !Number.isSafeInteger(user.uid) || user.uid < 0) throw new AuthenticationError('AUTHENTICATION_REQUIRED');
  return Object.freeze({ issuer: hostname(), subject: String(user.uid), username: user.username });
}
/** Identity evidence only; this function assigns no scope membership or permission. */
export function readLocalOsIdentity() {
  const { username, ...owner } = readLocalOsOwner(), mcp = localPrincipalChannel() === 'mcp';
  return verifiedPrincipalSchema.unwrap().omit({ scopeIds: true }).readonly().parse({
    id: `${username}@${owner.issuer}${mcp ? '/mcp' : ''}`, ...(mcp ? mcpPrincipalRef(owner) : owner), assurance: mcp ? 'workload-verified' : 'os-user',
  });
}
