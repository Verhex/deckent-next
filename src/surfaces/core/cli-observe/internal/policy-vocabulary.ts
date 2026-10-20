import { ErrorRegistry, loadConfigLanguage, resolveLocale } from '#platform/index.js';
import { getPolicyVocabulary } from '#engine/index.js';
import { vocabularyText } from '#surfaces/core/cli-approval/index.js';
import type { KernelCall } from './kernel.js';

/** `deckent policy vocabulary`: the policy vocabulary, read-only; a person reads a table, `--json` stays the versioned matrix (C-APPROVE). */
export async function policyVocabularyCommand({ args, output, env, root }: KernelCall): Promise<void> {
  const [, action] = args.positionals;
  if (action !== 'vocabulary' || args.positionals.length !== 2 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  // The installation's language when a project is here (presentation-only read, never blocks: the command needs no installation).
  const locale = resolveLocale(args.language, env, await loadConfigLanguage(root, { env }).catch(() => undefined));
  output(getPolicyVocabulary(), data => vocabularyText(data, locale, env));
}
