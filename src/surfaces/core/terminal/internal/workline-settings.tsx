import { useCallback, useMemo, useRef } from 'react';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import type { LocalExecution, WorklinePanel } from '#surfaces/core/terminal-work/index.js';
import type { PanelSnapshot, TerminalLocalContext } from '#surfaces/core/terminal-kit/index.js';
import { SettingsPanel, type PanelKind, type PanelLabels, type PanelPorts } from '#surfaces/core/terminal-panels/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import type { WorklinePermissionModePort } from './workline-mode.js';

/** T3 L4: the `/config` and `/mcp` window ports and every panel's words; `/mode`'s port is the workline's own mode hook. */
export type WorklinePanels = Readonly<{ ports: Omit<PanelPorts, 'mode'>; labels: PanelLabels }>;
type Mode = Readonly<{ stop: PermissionModeStop | undefined; select: (stop: PermissionModeStop) => Promise<void> }>;

/** The config window also intercepts typed arguments. Other settings retain their bare-command routing. */
function settingsPanelOf(command: string, args: string, ports: PanelPorts | null): PanelKind | null {
  if (!ports) return null;
  if (command === 'config' && ports.config) return 'config';
  if (args.trim()) return null;
  return command === 'mode' && ports.mode ? 'mode' : command === 'config' && ports.config ? 'config' : command === 'mcp' && ports.mcp ? 'mcp' : null;
}

/**
 * The workline's settings windows (T3 L4). `open` runs inside the command that asked for one: the window is a picker of the panel controller
 * (queued lines wait, one input owner), and an approval the `/config` window caused (a write the policy holds) opens when it closes, in the
 * same command. `window` is the open window, or null.
 */
export function useWorklineSettings(input: { readonly panels: WorklinePanels | undefined; readonly permissionMode: WorklinePermissionModePort | undefined; readonly mode: Mode;
  readonly panel: WorklinePanel; readonly state: PanelSnapshot<TerminalLocalContext>; readonly openApprovals: (approvalId: string, execution: LocalExecution) => Promise<void>;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string; readonly blocked: boolean }) {
  const { panels, permissionMode, panel, state, push, errorText } = input;
  const modeNow = useRef(input.mode); modeNow.current = input.mode;
  const ports = useMemo<PanelPorts | null>(() => panels ? { ...panels.ports, ...(permissionMode ? { mode: {
    inspect: () => permissionMode.inspect(), current: () => modeNow.current.stop ?? null, select: (stop: PermissionModeStop) => modeNow.current.select(stop) } } : {}) } : null,
  [panels, permissionMode]);
  const approvalAfter = useRef<string | null>(null), openApprovals = useRef(input.openApprovals); openApprovals.current = input.openApprovals;
  const open = useCallback(async (command: string, args: string, execution: LocalExecution): Promise<boolean> => {
    const kind = settingsPanelOf(command, args, ports);
    if (!kind) return false;
    approvalAfter.current = null;
    await panel.pick(execution, { kind: 'settings', panel: kind }, ['close']);
    const approvalId = approvalAfter.current; approvalAfter.current = null;
    if (approvalId && !execution.signal.aborted) {
      try { await openApprovals.current(approvalId, execution); } catch (error) { push([notice('error', errorText(error))]); }
    }
    return true;
  }, [errorText, panel, ports, push]);
  const presentation = panel.presentation(state), kind = presentation?.kind === 'settings' && state.picker ? presentation.panel : null;
  const handle = useRef<string | undefined>(undefined); handle.current = kind ? state.picker?.pickerHandle : undefined;
  const window = kind && ports && panels && !input.blocked
    ? <SettingsPanel kind={kind} ports={ports} labels={panels.labels} push={notices => push(notices.map(item => notice(item.level, item.text)))}
      onError={error => push([notice('error', errorText(error))])} errorText={errorText} openApproval={approvalId => { approvalAfter.current = approvalId; }}
      onClose={() => { panel.choose(handle.current, 'close'); }} /> : null;
  return { open, openKind: kind, window };
}
