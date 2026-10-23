import { ModelRoleAdmissionApplication, assertAuthorityWitness, type AuthorityWitness } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectConfiguredModelCatalog } from './catalog.js';

/**
 * M2 typed role admission on the Core config file adapter. The read view and the write share one application: the global layer's authored
 * `model_roles` (with its digest), the scope's registered catalog, and the governed config write of `model_roles` on the global layer (policy,
 * approval, sealed `config-change` audit, compare-and-set on the card's digest). A tier/role write is a person's terminal act: an MCP actor, or
 * a caller without the terminal witness, is refused before anything is read.
 */
function application(projectRoot: string, options: ConfigLoadOptions) {
  const config = createConfiguredConfigApplication(projectRoot, options);
  return new ModelRoleAdmissionApplication({
    section: async () => { const read = await config.inspectValue({ keyPath: 'model_roles', layer: 'global' }); return { digest: read.digest, value: read.value }; },
    catalog: scopeId => inspectConfiguredModelCatalog(projectRoot, { schemaVersion: 1, scopeId }, { ...options, heal: false }),
    submit: async input => config.submit('set', { keyPath: 'model_roles', layer: 'global', value: input.value, expect: input.expect, scopeId: input.scopeId,
      commandId: input.commandId, principal: await resolveConfiguredConfigPrincipal(projectRoot, input.scopeId, options) }),
  });
}
/** Read-only (CLI `models roles`, MCP `inspect_model_roles`, doctor): every catalog model the scope sees, with its tier/role row or pending. */
export async function inspectConfiguredModelRoles(projectRoot: string, query: unknown, options: ConfigLoadOptions = {}) {
  try { return await application(projectRoot, { ...options, heal: false }).inspect(query); } catch (error) { throw queryFailure(error); }
}
/** `deckent models roles set` after the person applied the card: one row, one overlay, the card's digest as compare-and-set. */
export async function assignConfiguredModelRole(projectRoot: string, command: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  try {
    await assertAuthorityWitness('models.roles.set', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    return await application(projectRoot, options).assign(command);
  } catch (error) { throw queryFailure(error); }
}
