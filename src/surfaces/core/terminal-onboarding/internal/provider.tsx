import { useApp } from 'ink';
import { t, colorCapability, loadConfigTerminalLaunch } from '#platform/index.js';
import { type PanelLabels, type ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import { SettingsPanel } from '#surfaces/core/terminal-provider/index.js';
import { CardCopyContext, WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { runTerminalHost, streamCardCopy } from '#surfaces/core/terminal-host/index.js';
import { terminalPalette, TERMINAL_THEME_SETTINGS } from '#surfaces/core/terminal-kit/index.js';
import { prefersAsciiGlyphs } from '#surfaces/core/terminal-render/index.js';
import { cardCopyLabels, type CliCardIo } from '#surfaces/core/cli-human/index.js';
function ProviderScreen({ port, labels, finish, io }: { readonly port: ProviderPanelPort; readonly labels: PanelLabels; readonly finish: (error?: unknown) => void; readonly io: CliCardIo }) {
  const { exit } = useApp();
  const done = (error?: unknown) => { finish(error); exit(); };
  return <WindowStackProvider><SettingsPanel kind="provider" ports={{ provider: port }} labels={labels}
    push={rows => { for (const row of rows) ((io.stdout ?? process.stdout) as NodeJS.WriteStream).write(`${row.text}\n`); }} onClose={() => done()}
    onError={done} errorText={error => error instanceof Error ? error.message : String(error)}
    openApproval={() => done(new Error(t('onboarding.provider.approval', {}, io.locale)))} /></WindowStackProvider>;
}
/** Reuse the existing connection, masked-key, discovery and activation owner in the current onboarding step. */
export async function runOnboardingProvider(port: ProviderPanelPort, labels: PanelLabels, subscriptionIds: readonly string[], io: CliCardIo & { readonly root?: string }) {
  if (io.signal?.aborted) return;
  const decorated = { ...port, async inspect() { const view = await port.inspect(); return { ...view,
    kinds: view.kinds.map(row => subscriptionIds.includes(row.id) ? { ...row, label: `${row.label} · ${t('onboarding.subscription.noExtraCharge', {}, io.locale)}` } : row) }; } };
  let failure: unknown;
  const env = io.env ?? process.env;
  const presentation = await loadConfigTerminalLaunch(io.root ?? process.cwd(), { env }).catch(() => null);
  if (io.signal?.aborted) return;
  const setting = TERMINAL_THEME_SETTINGS.find(value => value === presentation?.terminal['theme']) ?? TERMINAL_THEME_SETTINGS[0];
  const theme = { setting, capability: colorCapability({ env, isTTY: true, argv: process.argv }), colorfgbg: env['COLORFGBG'] };
  await runTerminalHost({ palette: terminalPalette(setting, theme.capability, theme.colorfgbg), theme,
    stdout: (io.stdout ?? process.stdout) as NodeJS.WriteStream, stdin: (io.stdin ?? process.stdin) as NodeJS.ReadStream,
    ...(io.signal ? { signal: io.signal } : {}), ascii: prefersAsciiGlyphs(env), clearScreen: false, fullscreen: false,
    view: () => <CardCopyContext.Provider value={streamCardCopy((io.stdout ?? process.stdout) as NodeJS.WriteStream, cardCopyLabels(io.locale), env)}>
      <ProviderScreen port={decorated} labels={labels} io={io} finish={error => { failure = error; }} />
    </CardCopyContext.Provider> });
  if (failure) throw failure;
}
