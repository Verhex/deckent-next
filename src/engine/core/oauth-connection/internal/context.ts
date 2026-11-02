import type { VerifiedPrincipal } from '#domain/index.js';
import { identityProfileConfigSchema } from '#domain/index.js';
import { IdentityProfileRegistry } from '#engine/core/identity-profile/index.js';
import { PersonalCustodyError } from '#engine/core/secret-store/index.js';
import { OAuthConnectionError } from './contract.js';
type OwnerContext = { readonly installationId: string | null; readonly companyId: string; readonly principal: { issuer: string; subject: string } };
/** OAuth custody belongs to the verified person; the invoking workload retains its own principal class. */
export function oauthContextOwner(scopeId: string, interactive: boolean, actor: VerifiedPrincipal, invoking: { owner: { issuer: string; subject: string }; principalClass: string }, callerContext: OwnerContext, context: OwnerContext) {
  if (callerContext.installationId !== context.installationId || callerContext.companyId !== context.companyId || !actor.scopeIds.includes(scopeId)
    || invoking.owner.issuer !== context.principal.issuer || invoking.owner.subject !== context.principal.subject || interactive && invoking.principalClass !== 'person')
    throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  if (!context.installationId) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
  const owner = { installationId: context.installationId, companyId: context.companyId, scopeId, principal: context.principal };
  return { owner, caller: { ...owner, principal: { issuer: actor.issuer, subject: actor.subject } } };
}
export function personalCustodyProfile(input: unknown) {
  const selected = identityProfileConfigSchema.safeParse(input); if (!selected.success) throw new PersonalCustodyError('profile-unresolved');
  const entry = new IdentityProfileRegistry(selected.data.packages).resolve(selected.data.profile);
  return { id: entry.definition.id, version: entry.definition.version, digest: entry.digest };
}
