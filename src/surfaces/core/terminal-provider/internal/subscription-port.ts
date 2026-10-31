import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { renderHeadlessLogin } from '#surfaces/core/cli-models/index.js';
import type { ModelConnectCommand, ModelConnectResult } from '#domain/index.js';
import type { PanelLine, ProviderModelOutcome } from '#surfaces/core/terminal-panels/index.js';
import { type ProviderConnectHost, type ProviderDelegateClass, type ProviderSubscriptionPort } from './context.js';

type Connect = (kind: string, cli: ModelConnectCommand['cli'] | null, delegate: readonly ProviderDelegateClass[] | undefined) =>
  Promise<Readonly<{ outcome: ProviderModelOutcome; result: ModelConnectResult | null; observationFailed?: true }>>;
const quoted = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;

/**
 * PV 3: the `/provider` side of `models login` + `models connect` for a CLI subscription. The sign-in, its person check, realm seal and time bound
 * are the composition's existing `models login` path; this port only words what it reported. The consent the person gives is sent as the same
 * typed `delegate` field the CLI twin's `--delegate` sends.
 */
export function subscriptionPort(input: Readonly<{ scopeId: string; options: ConfigLoadOptions; locale: Locale; errorText: (error: unknown) => string;
  connect: ProviderConnectHost & Required<Pick<ProviderConnectHost, 'login' | 'loginDir'>>; kindLabel: (id: string) => string; refusal: () => unknown; connectModel: Connect }>): ProviderSubscriptionPort {
  const { scopeId, options, locale, errorText, connect } = input, owned = new Map<string, string>();
  const words: ProviderSubscriptionPort['words'] = { action: t('tui.provider.login.action', {}, locale), dirTitle: t('tui.provider.login.dirTitle', {}, locale),
    dirOwned: t('tui.provider.login.dirOwned', {}, locale), dirOther: t('tui.provider.login.dirOther', {}, locale), otherTitle: t('tui.provider.login.otherTitle', {}, locale),
    otherHint: t('tui.provider.login.otherHint', {}, locale), otherAbsolute: t('tui.provider.login.otherAbsolute', {}, locale), banner: t('tui.provider.login.banner', {}, locale),
    retryKeys: t('tui.provider.login.retryKeys', {}, locale), consentTitle: t('tui.provider.login.consentTitle', {}, locale), consentNow: t('tui.provider.login.consentNow', {}, locale),
    consentConfirm: t('tui.provider.login.consentConfirm', {}, locale), onlyYou: t('tui.provider.login.onlyYou', {}, locale), youAnd: t('tui.provider.login.youAnd', {}, locale),
    system: t('tui.provider.login.system', {}, locale), ai: t('tui.provider.login.ai', {}, locale), mcp: t('tui.provider.login.mcp', {}, locale),
    mcpBlocked: t('tui.provider.login.mcpBlocked', {}, locale), question: t('tui.provider.login.question', {}, locale), questionKeys: t('tui.provider.login.questionKeys', {}, locale) };
  const twin = (kind: string, configDir: string | null) => ['deckent', 'models', 'login', '--connection', kind, ...(configDir ? ['--config-dir', configDir] : [])].map(quoted).join(' ');
  return {
    kinds: connect.kinds.filter(kind => kind.headlessLogin && kind.available).map(kind => kind.id), words,
    refusal(kind, usable) {
      return { title: t('tui.provider.isolation.title', { kind: input.kindLabel(kind) }, locale), lines: [
        { label: t('tui.provider.field.check', {}, locale), text: errorText(input.refusal()), tone: 'warning' },
        { label: t('tui.provider.isolation.usableLabel', {}, locale), text: usable.length ? usable.join(', ') : t('tui.provider.isolation.noneUsable', {}, locale) },
        { label: t('tui.provider.field.next', {}, locale), text: t('tui.provider.isolation.next', {}, locale), tone: 'muted' }] };
    },
    async prepare(kind) {
      const dir = await connect.loginDir(kind, options).catch((error: unknown) => error as Error);
      if (dir instanceof Error) return { owned: null, title: t('tui.provider.login.refusedTitle', { kind: input.kindLabel(kind) }, locale), lines: [{ label: '', text: errorText(dir), tone: 'warning' }] };
      owned.set(kind, dir.owned);
      return { owned: dir.owned, lines: [{ label: '', text: t('tui.provider.login.what', { kind: input.kindLabel(kind) }, locale) },
        { label: t('tui.provider.login.twinLabel', {}, locale), text: `${twin(kind, null)} && deckent models connect --connection ${quoted(kind)} --scope ${quoted(scopeId)}`, tone: 'muted' }] };
    },
    async login(kind, configDir) {
      const label = input.kindLabel(kind);
      try {
        const view = await connect.login({ connection: kind, ...(configDir ? { configDir } : {}) }, options);
        if (!view) return { signedIn: false, refused: true, title: t('tui.provider.login.refusedTitle', { kind: label }, locale), lines: [] };
        const signedIn = view.signedIn && view.exit === 'completed';
        return { signedIn, refused: false, title: signedIn ? t('tui.provider.login.doneTitle', { kind: label }, locale) : t('tui.provider.login.failedTitle', { kind: label }, locale),
          lines: renderHeadlessLogin(view, locale, kind).split('\n').map((text, index) => ({ label: '', text, ...(index === 0 ? { tone: 'muted' as const } : signedIn ? {} : { tone: 'warning' as const }) })) };
      } catch (error) {
        return { signedIn: false, refused: true, title: t('tui.provider.login.refusedTitle', { kind: label }, locale), lines: [{ label: '', text: errorText(error), tone: 'warning' }] };
      }
    },
    async connect(kind, configDir, delegate) {
      const cli = configDir && configDir !== owned.get(kind) ? { configDir } : null;
      const { outcome, result, observationFailed } = await input.connectModel(kind, cli, delegate).catch((error: unknown) => ({ result: null, observationFailed: false,
        outcome: { connected: false, title: input.kindLabel(kind), summary: '', approvalId: null,
          lines: [{ label: t('tui.provider.field.check', {}, locale), text: errorText(error), tone: 'warning' as const }] } }));
      if (!result) {
        const summary = t('tui.provider.login.notApplied', {}, locale);
        return { ...outcome, title: summary, summary, state: 'not-applied', delegate: null, lines: [{ label: '', text: summary, tone: 'warning' }, ...outcome.lines] };
      }
      if (result.status === 'approval-pending') return { ...outcome, state: 'approval-pending', delegate: null };
      if (observationFailed) return { ...outcome, state: 'applied-unverified', delegate: null };
      const classes = (result.cli?.delegate ?? []) as readonly ProviderDelegateClass[];
      const lines: PanelLine[] = [...outcome.lines, ...(result?.cli ? [{ label: t('tui.provider.login.field.delegate', {}, locale),
        text: classes.length ? t('headless.connect.delegated', { classes: classes.join(', ') }, locale) : t('tui.provider.login.personOnly', {}, locale) }] : [])];
      return { ...outcome, state: 'applied', lines, delegate: classes };
    },
  };
}
