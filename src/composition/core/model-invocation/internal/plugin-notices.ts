import { NATIVE_CLI_HEADLESS_ADAPTER_ID } from '#domain/index.js';
import { z } from 'zod';
import { type ModelInvocationResult } from '#engine/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
const metadata = z.looseObject({ cliVersion: z.string().min(1), builtinPlugins: z.array(z.string().min(1)) });
const sessions = new WeakMap<object, { seen: Set<string>; pending: Promise<void> }>();
// Presentation bounds, not plugin admission policy. Full identities stay in invocation evidence.
function singleLine(value: string, limit: number): string {
  const chars = [...terminalSafeText(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('') || '…';
}
/** Names and version are already durable invocation evidence. Only notice suppression is in memory,
 * per terminal process + scope + CLI version + name, until its runtime host restarts. No persistent counter. */
export async function notifyNativeBuiltinPlugins(result: ModelInvocationResult, language: Locale, session: object, terminal: string,
  notice: (text: string) => void | Promise<void>): Promise<void> {
  if (result.receipt.profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID) return;
  const parsed = metadata.safeParse(result.response?.native['headless']);
  if (!parsed.success || result.replayed) return;
  let state = sessions.get(session);
  if (!state) { state = { seen: new Set(), pending: Promise.resolve() }; sessions.set(session, state); }
  const { seen } = state;
  // Serialize delivery so concurrent invocations deduplicate without marking a failed delivery as shown.
  const delivered = state.pending.then(async () => {
    const unseen = [...new Set(parsed.data.builtinPlugins)].map(name => ({ name,
      key: JSON.stringify([terminal, result.receipt.claim.scopeId, parsed.data.cliVersion, name]) })).filter(item => !seen.has(item.key));
    if (!unseen.length) return;
    const names = unseen.slice(0, 4).map(item => singleLine(item.name, 128));
    if (unseen.length > names.length) names.push(t('headless.agent.builtinPluginsMore', { count: unseen.length - names.length }, language));
    const params = { name: names.join(', '), version: singleLine(parsed.data.cliVersion, 64) };
    await notice(unseen.length === 1 ? t('headless.agent.builtinPlugin', params, language) : t('headless.agent.builtinPlugins', params, language));
    for (const item of unseen) seen.add(item.key);
  });
  state.pending = delivered.catch(() => undefined);
  await delivered;
}
