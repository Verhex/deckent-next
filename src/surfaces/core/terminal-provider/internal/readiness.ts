import { nativeAgentReadinessSchema, nativeAgentReasonText, type NativeAgentReadiness } from '#capabilities/index.js';
import { DeckentError, headlessDiagnostic, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelPanelView, ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { ProviderPanelHost, ProviderWindowPort, SubscriptionReadinessPort } from './context.js';
import presentation from './presentation.json' with { type: 'json' };

type LocalReadiness = NativeAgentReadiness & { readonly diagnostic?: DeckentError };
const unknown = (): LocalReadiness => ({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED',
  diagnostic: headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-readiness-verifier-unavailable' }) });
export function subscriptionReadinessText(value: LocalReadiness, locale: Locale): string {
  if (value.state === 'ready') return t('headless.agent.readiness.ready', {}, locale);
  const reason = value.diagnostic?.localize?.(locale).message ?? nativeAgentReasonText(value.reason, locale, value.state === 'unknown');
  return value.state === 'unknown' ? t('headless.agent.readiness.unknown', { reason }, locale) : t('headless.agent.readiness.unavailable', { reason }, locale);
}
/** The host owns K7's scoped observation read. No inspection can mint a seal or refresh a login. */
export function subscriptionReadinessPort(root: string, scopeId: string, host: ProviderPanelHost, options: ConfigLoadOptions): SubscriptionReadinessPort {
  const inspectMany: SubscriptionReadinessPort['inspectMany'] = async (surface, references) => {
    if (!host.inspectSubscriptionReadiness) return references.map(unknown);
    if (!references.length) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await Promise.race([host.inspectSubscriptionReadiness(root, { scopeId, surface, references }, options),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), presentation.readinessInspectionMs); })]);
      return references.map((_, index) => {
        const value = values?.[index];
        if (typeof value !== 'object' || value === null) return unknown();
        const { diagnostic, ...facts } = value as Record<string, unknown>;
        const parsed = nativeAgentReadinessSchema.safeParse(facts);
        return parsed.success ? { ...parsed.data, ...(diagnostic instanceof DeckentError && { diagnostic }) } : unknown();
      });
    } catch { return references.map(() => ({ state: 'unknown', reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' })); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return {
    recognizes: reference => Boolean(host.providerConnect?.kinds.some(kind => kind.headlessLogin && (kind.catalogProviderId ?? kind.id) === reference.providerId)),
    inspectMany,
    async inspect(surface, reference) { return (await inspectMany(surface, [reference]))[0]!; },
  };
}
/** `/model` keeps the existing catalog/activation owner, adding the same subscription prerequisite read as `/provider`. */
export async function subscriptionModelView(view: ModelPanelView, provider: ProviderPanelPort | Pick<ProviderWindowPort, 'subscriptionReadiness'> | undefined, locale: Locale): Promise<ModelPanelView> {
  if (view.subscriptionChecked) return view;
  const port = (provider as ProviderWindowPort | undefined)?.subscriptionReadiness;
  if (!port) return view;
  const logins = view.choices.filter(choice => port.recognizes(choice.reference)), readiness = await port.inspectMany('chat', logins.map(choice => choice.reference));
  return { ...view, choices: view.choices.map(choice => {
    const at = logins.indexOf(choice); if (at < 0) return choice;
    const text = subscriptionReadinessText(readiness[at]!, locale);
    return { ...choice, detail: text, blocked: choice.blocked ?? (readiness[at]!.state === 'unavailable' ? text : null) }; // unknown stays selectable: the guarded first turn verifies it
  }) };
}
