import { ErrorRegistry, formatValue } from '#platform/index.js';
import { getPolicyVocabulary } from '#engine/index.js';
import type { KernelCall } from './kernel.js';

/** `deckent policy vocabulary`: the policy vocabulary, read-only. */
export function policyVocabularyCommand({ args, output }: KernelCall): void {
  const [, action] = args.positionals;
  if (action !== 'vocabulary' || args.positionals.length !== 2 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  output(getPolicyVocabulary(), data => formatValue(data));
}
