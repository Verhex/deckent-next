import { describe, expect, it, vi } from 'vitest';
import { nativeAgentReadinessSchema, type NativeAgentExecution } from '#capabilities/core/native-agent-execution/index.js';
import { t } from '#platform/index.js';
import { subscriptionReadinessText } from '#surfaces/core/terminal-provider/index.js';
import { nativeChatReasonText, nativeChatPreflightReason } from '#composition/core/agent-turn/index.js';
import { inspectSubscriptionReadiness, type SubscriptionReadinessQuery, type SubscriptionReadinessObservations,
  type SubscriptionReadinessSurface } from '#composition/core/subscription-readiness/index.js';

const execution: NativeAgentExecution = Object.freeze({ schemaVersion: 1, capability: 'NativeAgentExecution', executable: '/fixture/cli',
  cliVersion: '1.2.3', flagSetDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), ownerUid: 1000 });
const query = (surface: SubscriptionReadinessSurface = 'chat'): SubscriptionReadinessQuery => ({ surface, scopeId: 'scope-a',
  reference: { providerId: 'subscription-fixture', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 },
  profileDigest: execution.profileDigest, flagSetDigest: execution.flagSetDigest });
const observations = (): SubscriptionReadinessObservations => ({ cli: true, login: true, environment: true,
  toolSurface: true, plugins: true, bridge: true, execution });
const reasonKeys = {
  NATIVE_AGENT_CLI_UNAVAILABLE: 'cli', NATIVE_AGENT_LOGIN_REQUIRED: 'login', NATIVE_AGENT_CAPABILITY_UNSEALED: 'sealed',
  NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED: 'tools', NATIVE_AGENT_PLUGIN_UNEXPECTED: 'plugins',
  NATIVE_AGENT_BRIDGE_UNAVAILABLE: 'bridge', NATIVE_AGENT_ENVIRONMENT_REFUSED: 'environment',
} as const;

describe('subscription prerequisite query', () => {
  it('reads the exact surface and scoped model once without invoking models, login or authority operations', async () => {
    const read = vi.fn(async () => observations()), invoke = vi.fn(() => { throw new Error('model call forbidden'); }),
      login = vi.fn(() => { throw new Error('login forbidden'); }), grant = vi.fn(() => { throw new Error('grant forbidden'); });
    const port = { read, invoke, login, grant };
    for (const surface of ['chat', 'worker', 'brain', 'agent', 'skill'] as const) {
      const input = query(surface), result = await inspectSubscriptionReadiness(input, port);
      expect(read).toHaveBeenLastCalledWith(input);
      expect(result).toEqual({ state: 'ready', execution });
      expect(nativeAgentReadinessSchema.safeParse(result).success).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.state === 'ready' && result.execution)).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(5);
    expect(invoke).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });

  it('keeps missing observations unknown, including no reader result and absent capability', async () => {
    expect(await inspectSubscriptionReadiness(query(), { read: async () => null }))
      .toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' });
    expect(await inspectSubscriptionReadiness(query(), { read: async () => undefined }))
      .toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' });
    const reasons = { cli: 'NATIVE_AGENT_CLI_UNAVAILABLE', login: 'NATIVE_AGENT_LOGIN_REQUIRED', environment: 'NATIVE_AGENT_ENVIRONMENT_REFUSED',
      toolSurface: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', plugins: 'NATIVE_AGENT_PLUGIN_UNEXPECTED', bridge: 'NATIVE_AGENT_BRIDGE_UNAVAILABLE',
      execution: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } as const;
    for (const [key, reason] of Object.entries(reasons)) {
      const missing = { ...observations(), [key]: null };
      expect(await inspectSubscriptionReadiness(query(), { read: async () => missing })).toEqual({ state: 'unknown', reason });
    }
    for (const locale of ['en', 'tr'] as const) for (const [reason, suffix] of Object.entries(reasonKeys)) {
      const typedReason = reason as keyof typeof reasonKeys, text = t(`headless.agent.unknown.${suffix}`, {}, locale);
      if (suffix === 'sealed') expect(text).toBe(locale === 'en'
        ? 'Tools are not verified yet for this CLI version and profile. Your first message verifies them; text chat works meanwhile.'
        : 'Araçlar bu CLI sürümü ve profil için henüz doğrulanmadı. İlk mesajın onları doğrular; bu arada metin sohbeti çalışır.');
      expect(subscriptionReadinessText({ state: 'unknown', reason: typedReason }, locale))
        .toBe(t('headless.agent.readiness.unknown', { reason: text }, locale));
      expect(nativeChatReasonText(typedReason, locale, true)).toBe(text);
    }
  });

  it('reports definite failures before unknowns without converting lack of evidence into a refusal', async () => {
    const reasons = { cli: 'NATIVE_AGENT_CLI_UNAVAILABLE', login: 'NATIVE_AGENT_LOGIN_REQUIRED', environment: 'NATIVE_AGENT_ENVIRONMENT_REFUSED',
      toolSurface: 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', plugins: 'NATIVE_AGENT_PLUGIN_UNEXPECTED', bridge: 'NATIVE_AGENT_BRIDGE_UNAVAILABLE' } as const;
    for (const [key, reason] of Object.entries(reasons)) {
      expect(await inspectSubscriptionReadiness(query(), { read: async () => ({ [key]: false }) }))
        .toEqual({ state: 'unavailable', reason });
    }
    for (const locale of ['en', 'tr'] as const) for (const reason of Object.keys(reasonKeys)) {
      const typedReason = reason as keyof typeof reasonKeys, text = t(`headless.agent.reason.${reason}`, {}, locale);
      expect(subscriptionReadinessText({ state: 'unavailable', reason: typedReason }, locale))
        .toBe(t('headless.agent.readiness.unavailable', { reason: text }, locale));
      expect(nativeChatReasonText(typedReason, locale)).toBe(text);
      for (const unknown of [false, true]) expect(nativeChatReasonText(typedReason, locale, unknown, true)).toBe(
        reason === 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' ? t('headless.agent.surfaceStopped', {}, locale)
          : nativeChatReasonText(typedReason, locale, unknown));
    }
  });

  it('keeps tools and plugin failures off the tool-less Brain while refusing every tool-bearing surface', async () => {
    const observed = { ...observations(), plugins: false, bridge: false, toolSurface: false };
    expect(await inspectSubscriptionReadiness(query('brain'), { read: async () => observed })).toEqual({ state: 'ready', execution });
    for (const surface of ['chat', 'worker', 'agent', 'skill'] as const) {
      expect(await inspectSubscriptionReadiness(query(surface), { read: async () => observed }))
        .toEqual({ state: 'unavailable', reason: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' });
    }
    expect(await inspectSubscriptionReadiness(query('brain'), { read: async () => ({ cli: true, login: true, environment: true, execution }) }))
      .toEqual({ state: 'ready', execution });
  });

  it('refuses a seal for another profile or flag set and leaves malformed seals unknown', async () => {
    for (const field of ['profileDigest', 'flagSetDigest'] as const) {
      expect(await inspectSubscriptionReadiness({ ...query(), [field]: 'c'.repeat(64) }, { read: async () => observations() }))
        .toEqual({ state: 'unavailable', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
    }
    expect(await inspectSubscriptionReadiness(query(), { read: async () => ({ ...observations(), execution: { capability: 'NativeAgentExecution' } as NativeAgentExecution }) }))
      .toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
  });

  it('does not reuse chat observations for a different surface, scope or model', async () => {
    const read = vi.fn(async (input: SubscriptionReadinessQuery) => input.surface === 'chat' && input.scopeId === 'scope-a'
      && input.reference.modelId === 'fixture-model' ? observations() : null);
    expect(await inspectSubscriptionReadiness(query(), { read })).toEqual({ state: 'ready', execution });
    for (const input of [{ ...query(), scopeId: 'scope-b' }, { ...query(), reference: { ...query().reference, modelId: 'another-model' } }, query('worker')]) {
      expect(await inspectSubscriptionReadiness(input, { read })).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' });
    }
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('takes an immutable query snapshot and returns unknown after a failed read without retry or error leakage', async () => {
    const input = query(), read = vi.fn(async (snapshot: SubscriptionReadinessQuery) => {
      expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.reference)).toBe(true);
      throw new Error('private credential canary');
    });
    expect(await inspectSubscriptionReadiness(input, { read })).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' });
    expect(read).toHaveBeenCalledTimes(1);
    for (const [error, reason] of [
      [{ code: 'HEADLESS_LOGIN_REQUIRED' }, 'NATIVE_AGENT_LOGIN_REQUIRED'],
      [{ code: 'HEADLESS_CLI_UNAVAILABLE' }, 'NATIVE_AGENT_CLI_UNAVAILABLE'],
      [{ code: 'constructor' }, 'NATIVE_AGENT_ENVIRONMENT_REFUSED'],
      [{ code: 'OTHER', message: 'private credential canary' }, 'NATIVE_AGENT_ENVIRONMENT_REFUSED'],
      [{ code: 1 }, 'NATIVE_AGENT_ENVIRONMENT_REFUSED'], [null, 'NATIVE_AGENT_ENVIRONMENT_REFUSED'],
    ] as const) expect(nativeChatPreflightReason(error)).toBe(reason);
  });
});
