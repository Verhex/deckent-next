import { openHostProjectInstructionReader, selectWorkTarget, workerInstructionFile, workerInstructionSelection } from '#adapters/index.js';
import { getConfigKnownSecrets, type ConfigLoadOptions, type CoreConfig } from '#platform/index.js';
/** DECKENT-MD-WORKERS (owner Q3): one bounded read of the project's selected worker instruction file at the Git work target root, once per
 * admission. No Git execution configured = explicit no-op; absent selection = `deckent-md` when that file exists, else nothing. */
export async function readWorkerInstructions(projectRoot: string, config: CoreConfig, options: ConfigLoadOptions) {
  const selected = config.execution?.workerInstructions?.source, source = selected ?? 'deckent-md';
  if (!config.execution || source === 'none') return { parts: [], withheld: null, oversize: false };
  // A missing or unreadable target root is a visible reason, never an unexpected admission failure (the target's own checks still apply).
  const reader = await openHostProjectInstructionReader(selectWorkTarget(config.execution)?.path ?? projectRoot, options.env ?? process.env,
    getConfigKnownSecrets(config), [workerInstructionFile(source)]).catch(() => null);
  const { part, withheld } = workerInstructionSelection(reader ? await reader.inspect() : { status: 'blocked', reason: 'unreadable' }, source, selected !== undefined);
  // An oversized file is the same overflow refusal as a snapshot that does not fit the prompt budget; other reasons are visible warnings.
  return { parts: part ? [part] : [], oversize: withheld?.reason === 'size',
    withheld: withheld && withheld.reason !== 'size' ? { code: 'WORKER_INSTRUCTIONS_WITHHELD' as const, ...withheld, reason: withheld.reason } : null };
}
