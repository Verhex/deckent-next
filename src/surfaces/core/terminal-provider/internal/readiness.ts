import { nativeAgentReadinessSchema, type NativeAgentReadiness } from '#capabilities/index.js';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelPanelView, ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { ProviderPanelHost, ProviderWindowPort, SubscriptionReadinessPort } from './context.js';
import presentation from './presentation.json' with { type: 'json' };

const unknown = (): NativeAgentReadiness => ({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
export function subscriptionReadinessText(value: NativeAgentReadiness, locale: Locale): string {
  if (value.state === 'ready') return t('headless.agent.k13.readiness.ready', {}, locale);
  const reason = (() => {
    switch (value.reason) {
      case 'NATIVE_AGENT_CLI_UNAVAILABLE': return value.state === 'unknown' ? t('headless.agent.k13.unknown.cli', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_CLI_UNAVAILABLE', {}, locale);
      case 'NATIVE_AGENT_LOGIN_REQUIRED': return value.state === 'unknown' ? t('headless.agent.k13.unknown.login', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_LOGIN_REQUIRED', {}, locale);
      case 'NATIVE_AGENT_CAPABILITY_UNSEALED': return value.state === 'unknown' ? t('headless.agent.k13.unknown.sealed', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_CAPABILITY_UNSEALED', {}, locale);
      case 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED': return value.state === 'unknown' ? t('headless.agent.k13.unknown.tools', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', {}, locale);
      case 'NATIVE_AGENT_PLUGIN_UNEXPECTED': return value.state === 'unknown' ? t('headless.agent.k13.unknown.plugins', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_PLUGIN_UNEXPECTED', {}, locale);
      case 'NATIVE_AGENT_BRIDGE_UNAVAILABLE': return value.state === 'unknown' ? t('headless.agent.k13.unknown.bridge', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_BRIDGE_UNAVAILABLE', {}, locale);
      case 'NATIVE_AGENT_ENVIRONMENT_REFUSED': return value.state === 'unknown' ? t('headless.agent.k13.unknown.environment', {}, locale) : t('headless.agent.reason.NATIVE_AGENT_ENVIRONMENT_REFUSED', {}, locale);
    }
  })();
  return value.state === 'unknown' ? t('headless.agent.k13.readiness.unknown', { reason }, locale) : t('headless.agent.k13.readiness.unavailable', { reason }, locale);
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
      return references.map((_, index) => { const parsed = nativeAgentReadinessSchema.safeParse(values?.[index]); return parsed.success ? parsed.data : unknown(); });
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
export async function subscriptionModelView(view: ModelPanelView, provider: ProviderPanelPort | undefined, locale: Locale): Promise<ModelPanelView> {
  const port = (provider as ProviderWindowPort | undefined)?.subscriptionReadiness;
  if (!port) return view;
  const logins = view.choices.filter(choice => port.recognizes(choice.reference)), readiness = await port.inspectMany('chat', logins.map(choice => choice.reference));
  return { ...view, choices: view.choices.map(choice => {
    const at = logins.indexOf(choice); if (at < 0) return choice;
    const text = subscriptionReadinessText(readiness[at]!, locale);
    return { ...choice, detail: text, blocked: choice.blocked ?? (readiness[at]!.state === 'unavailable' ? text : null) }; // unknown stays selectable: the guarded first turn verifies it
  }) };
}
