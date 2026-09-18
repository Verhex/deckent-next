import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity } from '#adapters/index.js';
import { policySchema, policyScopeMembership } from '#domain/index.js';
import { PolicyAuthorizationError } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
/** One fresh local config/identity/policy snapshot per request. No ledger access or grant here:
 * the caller's application authenticates/authorizes before invoking the deferred ledger locator.
 */
export async function loadConfiguredRunContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
  const identity = readLocalOsIdentity(); let document;
  try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = policyScopeMembership(document, identity, [scopeId]);
  if (!scopeIds.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  const principal = Object.freeze({ ...identity, scopeIds });
  return Object.freeze({ config, layout, document, principal,
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
  });
}
