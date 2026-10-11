import { identitySchema } from './values.js';
/** Versioned protocol namespace. Reserved entries are security invariants, not mutable policy. */
export const SYSTEM_COMMAND_PREFIXES = Object.freeze({ schemaVersion: 1 as const, fence: 'dispatch-fence-', release: 'dispatch-release-' });
export class CommandIdError extends Error {
  readonly code = 'COMMAND_ID_RESERVED';
  constructor() { super('COMMAND_ID_RESERVED'); this.name = 'CommandIdError'; }
}
export const clientCommandIdSchema = identitySchema.transform(value => {
  if ([SYSTEM_COMMAND_PREFIXES.fence, SYSTEM_COMMAND_PREFIXES.release].some(prefix => value.startsWith(prefix))) throw new CommandIdError();
  return value;
});
