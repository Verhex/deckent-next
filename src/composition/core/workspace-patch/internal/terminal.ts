import { resolve } from 'node:path';
import { ErrorRegistry, loadConfig, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationDelivery, resolveGitWorkTarget, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import type { EffectConfirmation, EffectConfirmationView, IntegrationDeliveryCommand, IntegrationAdoptionCommand, IntegrationRollbackCommand } from '#engine/index.js';
import { deliverWorkspaceIntegrationWithConfirmation } from './delivery.js';
import { adoptWorkspaceIntegrationWithConfirmation, rollbackWorkspaceIntegrationWithConfirmation } from './adoption.js';
import { workspacePatchContext } from './configured.js';
import { inspectConfiguredWorkspaceIntegration } from './integration.js';
/** Only the trusted CLI/Terminal composition calls this. The answer function is local surface I/O,
 * never a command field. Neither the exported SDK producers nor MCP install this capability. */
export function verifiedDeliveryConfirmation(answer: (view: EffectConfirmationView) => Promise<boolean>): EffectConfirmation {
  const assertAvailable = async () => {
    if (localPrincipalChannel() === 'mcp' || localPrincipalPeer() || !await attestLocalInteractiveTerminal()) throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED');
  };
  return { assertAvailable, async confirm(view) {
    await assertAvailable();
    if (!await answer(view)) throw ErrorRegistry.createError('DELIVERY_CONFIRMATION_DECLINED');
    await assertAvailable(); return assertAvailable;
  } };
}
export function interactiveDeliveryHandlers(answer: (view: EffectConfirmationView) => Promise<boolean>) {
  const witness = verifiedDeliveryConfirmation(answer);
  const port = (root: string, input: IntegrationDeliveryCommand | IntegrationAdoptionCommand | IntegrationRollbackCommand, options: ConfigLoadOptions): EffectConfirmation => ({
    assertAvailable: witness.assertAvailable,
    async confirm(view) {
      await witness.assertAvailable();
      const c = await workspacePatchContext(root, input.identity, options, false, 'read');
      if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      const git = { ...c.config.execution.git, ...(await resolveGitWorkTarget(resolve(root), c.config.execution, c.layout)).git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
      const candidate = 'integrationCommandId' in input ? (await inspectConfiguredWorkspaceIntegration(root, { schemaVersion: 1, identity: input.identity, commandId: input.integrationCommandId }, options)).manifest : null;
      const guard = await witness.confirm({ ...view, ...await new GitIntegrationDelivery(candidate ? { ...git, sourceRoot: candidate.workspace } : git).describe(view.from, view.to) });
      return async () => { // adoption and rollback move the shown branch (`view.resource`): still a configured target after the answer
        await guard();
        if (view.operation !== 'deliver-integration' && !(await loadConfig(root, { ...options, force: true, heal: false })).execution?.adoption.targets.includes(view.resource)) throw ErrorRegistry.createError('ADOPTION_TARGET_DENIED');
      };
    },
  });
  return { assertAvailable: witness.assertAvailable, // TESLIM-PENCERESI: the terminal window refuses a non-verified session before preparing a candidate.
    deliver: (root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions) => deliverWorkspaceIntegrationWithConfirmation(root, input, options, port(root, input, options)),
    adopt: (root: string, input: IntegrationAdoptionCommand, options: ConfigLoadOptions) => adoptWorkspaceIntegrationWithConfirmation(root, input, options, port(root, input, options)),
    rollback: (root: string, input: IntegrationRollbackCommand, options: ConfigLoadOptions) => rollbackWorkspaceIntegrationWithConfirmation(root, input, options, port(root, input, options)),
  };
}
