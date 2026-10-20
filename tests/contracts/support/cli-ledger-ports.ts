import { createWorklineLedgerPorts as createLedgerPorts } from '#surfaces/core/cli-terminal/index.js';
import { renderRunCancellation } from '#surfaces/core/cli-run/index.js';

/** The terminal's ledger ports with the CLI's `run cancel` text, as `deckent` binds them when it launches the terminal (surfaces/core/cli). */
export function createWorklineLedgerPorts(input: Omit<Parameters<typeof createLedgerPorts>[0], 'renderRunCancellation'>): ReturnType<typeof createLedgerPorts> {
  return createLedgerPorts({ ...input, renderRunCancellation });
}
