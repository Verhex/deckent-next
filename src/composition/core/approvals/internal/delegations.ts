import { delegationCommandSchema, type DelegationCommand, type DelegationQuery } from '#domain/index.js';
import { DecisionDelegations } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalPeer } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { withPolicyAdministration } from './standing.js';

const interactive = async () => { const peer = localPrincipalPeer(); return attestLocalInteractiveTerminal(peer?.pid, peer?.uid); };
/** Public SDK observation only; never opens administration, identities, keys or ledger writes. */
export function inspectConfiguredDecisionDelegations(root: string, input: DelegationQuery, options: ConfigLoadOptions = {}) {
  return withPolicyAdministration(root, input.scopeId, options, 'read', (deps, person) => new DecisionDelegations(deps).inspect(input, person));
}
/** CLI/terminal-only mutation. Confirmation reviews the exact revision, actor, scope, resource and step before write admission. */
export async function changeConfiguredDecisionDelegation(root: string, input: DelegationCommand,
  confirm: (view: Awaited<ReturnType<typeof inspectConfiguredDecisionDelegations>>) => Promise<boolean>, options: ConfigLoadOptions = {}) {
  if (!await interactive()) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
  const command = delegationCommandSchema.parse(input);
  const query: DelegationQuery = { schemaVersion: 1, scopeId: command.scopeId, actor: command.actor, ...(command.resourceId ? { resourceId: command.resourceId } : {}) };
  const view = await inspectConfiguredDecisionDelegations(root, query, options);
  if (view.revision !== command.expectedRevision) throw ErrorRegistry.createError('POLICY_DELEGATION_CONFLICT');
  if (!view.steps.some(row => row.step.id === command.step)) throw ErrorRegistry.createError('POLICY_DELEGATION_STEP_INVALID');
  if (!await confirm(view)) return { status: 'cancelled' as const, view };
  return withPolicyAdministration(root, command.scopeId, options, 'write', (deps, person) => new DecisionDelegations(deps, interactive).change(command, person));
}
