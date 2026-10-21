import { attestLocalInteractiveTerminal, readIdentityProfileConfig } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import REGISTRY from './grant-card.json' with { type: 'json' };

/**
 * PRE-8 first-use card (owner decisions 2026-10-21 `#pre8-secret-model-2026-10-21`, `#pre8-v2-decisions-2026-10-21` 1): whether this terminal
 * process may be asked to lend a main-vault key to the project. Only a solo installation (the selected identity profile, or none selected yet) at
 * a human terminal this process itself holds (stdin and stdout on its controlling terminal — the `approval decide` evidence); a pipe or an
 * agent's shell has none. Team, enterprise and custom installations get the refusal naming the admin command. This decides only whether the
 * card is shown: the grant itself is the governed `secret grant` application (policy cell, terminal witness, sealed decision), which refuses
 * on its own. An unreadable identity selection is not guessed: no card.
 */
export async function terminalSecretGrantOffer(projectRoot: string, options: ConfigLoadOptions = {},
  attest: () => Promise<boolean> = () => attestLocalInteractiveTerminal()): Promise<boolean> {
  let profile: string | null;
  try { profile = readIdentityProfileConfig((await loadComposedConfig(projectRoot, options))['identity'])?.profile.id ?? null; }
  catch { return false; }
  if (profile === null ? !REGISTRY.cardWithoutProfile : !REGISTRY.cardProfiles.includes(profile)) return false;
  return attest();
}
