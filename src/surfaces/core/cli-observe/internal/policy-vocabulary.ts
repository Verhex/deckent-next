import { ErrorRegistry } from '#platform/index.js';
import { getPolicyVocabulary } from '#engine/index.js';
import { vocabularyText } from '#surfaces/core/cli-approval/index.js';
import type { KernelCall } from './kernel.js';

/** `deckent policy vocabulary`: the policy vocabulary, read-only; a person reads a table, `--json` stays the versioned matrix (C-APPROVE). */
export function policyVocabularyCommand({ args, output, locale, env }: KernelCall): void {
  const [, action] = args.positionals;
  if (action !== 'vocabulary' || args.positionals.length !== 2 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  output(getPolicyVocabulary(), data => vocabularyText(data, locale, env));
}
