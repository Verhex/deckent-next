import { userInfo, hostname } from 'node:os';
import { verifiedPrincipalSchema } from '#domain/index.js';
import { AuthenticationError, type PrincipalVerifier } from '#engine/index.js';

/** Direct local process only. This verifies the current OS user, NOT a remote socket's peer.
 * Never install this verifier on an API/MCP network listener; use that transport's real verifier.
 */
export class LocalOsPrincipalVerifier implements PrincipalVerifier {
  private readonly scopes: readonly string[];
  constructor(scopeIds: readonly string[]) { this.scopes = Object.freeze([...scopeIds]); }
  async verify(credential: unknown) {
    if (credential !== undefined) throw new AuthenticationError('AUTHENTICATION_REQUIRED');
    const user = userInfo();
    if (!user.username || !Number.isSafeInteger(user.uid) || user.uid < 0) throw new AuthenticationError('AUTHENTICATION_REQUIRED');
    const issuer = hostname();
    return verifiedPrincipalSchema.parse({ id: `${user.username}@${issuer}`, issuer, subject: String(user.uid),
      assurance: 'os-user', scopeIds: this.scopes });
  }
}
