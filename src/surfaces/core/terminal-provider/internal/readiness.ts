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
  return {
    recognizes: reference => Boolean(host.providerConnect?.kinds.some(kind => kind.headlessLogin && (kind.catalogProviderId ?? kind.id) === reference.providerId)),
    async inspect(surface, reference) {
      if (!host.inspectSubscriptionReadiness) return unknown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([host.inspectSubscriptionReadiness(root, { scopeId, surface, reference }, options),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), presentation.readinessInspectionMs); })]);
        const parsed = nativeAgentReadinessSchema.safeParse(value);
        return parsed.success ? parsed.data : unknown();
      } catch { return { state: 'unknown', reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' }; }
      finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}
/** `/model` keeps the existing catalog/activation owner, adding the same subscription prerequisite read as `/provider`. */
export async function subscriptionModelView(view: ModelPanelView, provider: ProviderPanelPort | undefined, locale: Locale): Promise<ModelPanelView> {
  const port = (provider as ProviderWindowPort | undefined)?.subscriptionReadiness;
  if (!port) return view;
  return { ...view, choices: await Promise.all(view.choices.map(async choice => {
    if (!port.recognizes(choice.reference)) return choice;
    const readiness = await port.inspect('chat', choice.reference), text = subscriptionReadinessText(readiness, locale);
    return { ...choice, detail: text, blocked: choice.blocked ?? (readiness.state === 'unavailable' ? text : null) }; // unknown stays selectable: the guarded first turn verifies it
  })) };
}
