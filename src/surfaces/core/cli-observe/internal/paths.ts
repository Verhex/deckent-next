import { ErrorRegistry, formatValue, inspectProductPaths } from '#platform/index.js';
import type { KernelCall } from './kernel.js';

/** `deckent paths`: the product paths this installation resolves, read-only. */
export async function pathsCommand({ args, root, options, output }: KernelCall): Promise<void> {
  if (args.dryRun || args.positionals.length !== 1) throw ErrorRegistry.createError('CLI_USAGE');
  output(await inspectProductPaths(root, { ...options, globalOnly: args.global }), data => formatValue(data));
}
