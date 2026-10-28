import { userInfo } from 'node:os';
import type { BrainPlanCommand } from '#domain/index.js';
import { RunIntentApplication, RunPolicyAuthorization, isRunIntentResult, type RunIntentRecord, assertAuthorityWitness } from '#engine/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { attestLocalInteractiveTerminal, openSqliteRunProposalStore, localPrincipalChannel } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { configuredWorkerSetupFact } from './intent-facts.js';
async function withIntentOwner<T>(root: string, command: BrainPlanCommand, options: ConfigLoadOptions,
  run: (owner: RunIntentApplication) => Promise<T>) {
  const context = await loadConfiguredScopeContext(root, command.scopeId, options, 'write');
  const store = await openSqliteRunProposalStore(await context.path(), context.config.storage.sqlite);
  try { return await run(new RunIntentApplication(store, { verify: async () => context.principal },
    new RunPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes)), new SystemTrustedClock(),
    () => configuredWorkerSetupFact(root, command.scopeId, options), action => assertAuthorityWitness(`runIntent.${action}`, localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() }))); }
  finally { store.close(); }
}
export const preflightConfiguredRunIntent = (root: string, command: BrainPlanCommand, options: ConfigLoadOptions) =>
  withIntentOwner(root, command, options, owner => owner.preflight(command));
export const transitionConfiguredRunIntent = (root: string, intent: RunIntentRecord, action: 'release' | 'cancel' | 'start' | 'fact', commandId: string, options: ConfigLoadOptions) =>
  withIntentOwner(root, intent.command, options, owner => owner.transition({ command: intent.command, expectedRevision: intent.revision, action, commandId }));
export { isRunIntentResult };
