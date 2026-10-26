import { render, useApp } from 'ink';
import { t, colorCapability } from '#platform/index.js';
import { SettingsPanel, type PanelLabels, type ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, prefersAsciiGlyphs, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
function ProviderScreen({ port, labels, finish, io }: { readonly port: ProviderPanelPort; readonly labels: PanelLabels; readonly finish: (error?: unknown) => void; readonly io: CliCardIo }) {
  const { exit } = useApp();
  const done = (error?: unknown) => { finish(error); exit(); };
  return <WindowStackProvider><SettingsPanel kind="provider" ports={{ provider: port }} labels={labels}
    push={rows => { for (const row of rows) ((io.stdout ?? process.stdout) as NodeJS.WriteStream).write(`${row.text}\n`); }} onClose={() => done()}
    onError={done} errorText={error => error instanceof Error ? error.message : String(error)}
    openApproval={() => done(new Error(t('onboarding.provider.approval', {}, io.locale)))} /></WindowStackProvider>;
}
/** Reuse the existing connection, masked-key, discovery and activation owner in the current onboarding step. */
export async function runOnboardingProvider(port: ProviderPanelPort, labels: PanelLabels, subscriptionIds: readonly string[], io: CliCardIo) {
  if (io.signal?.aborted) return;
  const decorated = { ...port, async inspect() { const view = await port.inspect(); return { ...view,
    kinds: view.kinds.map(row => subscriptionIds.includes(row.id) ? { ...row, label: `${row.label} · ${t('onboarding.subscription.noExtraCharge', {}, io.locale)}` } : row) }; } };
  let failure: unknown;
  const palette = resolveWorklinePalette(colorCapability({ env: io.env ?? process.env, isTTY: true, argv: [] }));
  const view = render(<WorklinePaletteProvider palette={palette}><RenderGlyphsContext.Provider value={resolveRenderGlyphs(prefersAsciiGlyphs(io.env ?? process.env))}>
    <ProviderScreen port={decorated} labels={labels} io={io} finish={error => { failure = error; }} />
  </RenderGlyphsContext.Provider></WorklinePaletteProvider>, { interactive: true, patchConsole: false, exitOnCtrlC: false,
    stdin: (io.stdin ?? process.stdin) as NodeJS.ReadStream, stdout: (io.stdout ?? process.stdout) as NodeJS.WriteStream });
  const stop = () => view.unmount(); io.signal?.addEventListener('abort', stop, { once: true });
  try { await view.waitUntilExit(); } finally { view.unmount(); io.signal?.removeEventListener('abort', stop); }
  if (failure) throw failure;
}
