import { modelInvocationProfileSchema, type ModelReference } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { assertProjectCredential } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { describeTerminalChat } from './turn.js';

const same = (a: ModelReference, b: ModelReference) => a.providerId === b.providerId && a.providerVersion === b.providerVersion && a.modelId === b.modelId && a.modelVersion === b.modelVersion;
/**
 * PRE-8 v2: the terminal turn's credential preflight (the first-use card's trigger). The turn's model (a session pin, else the configured one) →
 * its invocation profile in the scope → that profile's credential reference → the one project credential decision. No value is read; a model
 * without a profile or without a credential passes (the service decides those as before).
 */
export async function assertConfiguredTerminalCredential(projectRoot: string, reference: ModelReference | undefined, scopeId: string, options: ConfigLoadOptions = {}): Promise<void> {
  const target = reference ?? (await describeTerminalChat(projectRoot, options)).reference;
  if (!target) return;
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read');
  const profiles = ((context.config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  const profile = profiles.find(candidate => candidate.scopeId === scopeId && same(candidate.reference, target));
  const definition = profile?.adapter.definition as { authentication?: { type?: string; credentialRef?: string }; transport?: { authentication?: { type?: string; credentialRef?: string } } } | undefined;
  const authentication = definition?.authentication ?? definition?.transport?.authentication;
  if (authentication?.type && authentication.type !== 'none' && authentication.credentialRef) await assertProjectCredential(context, scopeId, authentication.credentialRef, options);
}
