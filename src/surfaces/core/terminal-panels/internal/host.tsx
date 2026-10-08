import { ConfigPanel } from './config-panel.js';
import { McpPanel } from './mcp-panel.js';
import { ModePanel } from './mode-panel.js';
import { ModelPanel } from './model-panel.js';
import { ProviderPanel } from './provider-panel.js';
import type { PanelKind, PanelLabels, PanelNotice, PanelPorts } from './contract.js';

/**
 * The one open settings window of the workline (T3 L4): `/mode`, `/config`, `/mcp`, and (T4) `/model` or `/provider`. It is a layer of the window stack while open (the
 * composer and Shift+Tab wait), its finished lines go to scrollback through `push`, and a port failure is reported through `onError`.
 */
export function SettingsPanel({ kind, ports, labels, push, onError, errorText, openApproval, onClose }: { readonly kind: PanelKind; readonly ports: PanelPorts;
  readonly labels: PanelLabels; readonly push: (notices: readonly PanelNotice[]) => void; readonly onError: (error: unknown) => void; readonly errorText: (error: unknown) => string;
  readonly openApproval: (approvalId: string) => void; readonly onClose: () => void }) {
  if (kind === 'mode' && ports.mode) return <ModePanel port={ports.mode} labels={labels} onError={onError} onClose={onClose} />;
  if (kind === 'config' && ports.config) return <ConfigPanel port={ports.config} labels={labels} push={push} openApproval={openApproval} onError={onError} onClose={onClose} />;
  if (kind === 'model' && ports.model) return <ModelPanel port={ports.model} labels={labels} push={push} openApproval={openApproval} onError={onError} onClose={onClose} />;
  if (kind === 'provider' && ports.provider) return <ProviderPanel port={ports.provider} labels={labels} push={push} onError={onError} onClose={onClose} />;
  if (kind === 'mcp' && ports.mcp) return <McpPanel port={ports.mcp} labels={labels} push={push} onError={onError} errorText={errorText} onClose={onClose} />;
  return null;
}
