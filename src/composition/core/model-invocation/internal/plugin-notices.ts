import { NATIVE_CLI_HEADLESS_ADAPTER_ID } from '#domain/index.js';
import { z } from 'zod';
import { type ModelInvocationResult } from '#engine/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
const metadata = z.looseObject({ cliVersion: z.string().min(1), builtinPlugins: z.array(z.string().min(1)) });
const sessions = new WeakMap<object, Set<string>>();
/** Names and version are already durable invocation evidence. Only notice suppression is in memory,
 * per terminal process + scope + CLI version + name, until its runtime host restarts. No persistent counter. */
export async function notifyNativeBuiltinPlugins(result: ModelInvocationResult, language: Locale, session: object, terminal: string,
  notice: (text: string) => void | Promise<void>): Promise<void> {
  if (result.receipt.profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID) return;
  const parsed = metadata.safeParse(result.response?.native['headless']);
  if (!parsed.success || result.replayed) return;
  let seen = sessions.get(session);
  if (!seen) { seen = new Set(); sessions.set(session, seen); }
  for (const name of parsed.data.builtinPlugins) {
    const key = JSON.stringify([terminal, result.receipt.claim.scopeId, parsed.data.cliVersion, name]);
    if (seen.has(key)) continue;
    seen.add(key);
    await notice(t('headless.agent.builtinPlugin', { name: terminalSafeText(name),
      version: terminalSafeText(parsed.data.cliVersion) }, language));
  }
}
