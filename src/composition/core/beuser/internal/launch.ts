import { BEUSER_REALM_RECIPE, type BeuserDriverBoot } from '#adapters/index.js';
import type { BeuserJourneyProfile } from '#composition/core/supervisors/index.js';
import { BeuserContractError } from '#engine/index.js';

/** The installed profile declares one CLI tuple; only its packaged entry can execute it. */
export function beuserJourneyLaunch(data: { readonly entry: BeuserJourneyProfile['entry']; readonly summary: Pick<BeuserJourneyProfile['summary'], 'journeyId'> }) {
  if (data.entry.nodeExecutable !== BEUSER_REALM_RECIPE.nodeExecutable) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const prefix = [BEUSER_REALM_RECIPE.nodeExecutable, `${BEUSER_REALM_RECIPE.packageTarget}/dist/composition/core/cli/internal/entry.js`];
  const command = { commandId: data.summary.journeyId, args: [...data.entry.args] };
  const initialCommand = data.entry.mode === 'argv' ? command : undefined;
  const commands: BeuserDriverBoot['commands'] = initialCommand
    ? { [command.commandId]: { prefix, allowedArgs: [command.args] } } : {};
  return { entry: [...prefix, ...command.args], commands, catalog: initialCommand ? [command] : [], initialCommand };
}
