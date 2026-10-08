import { useCallback, useMemo, useRef } from 'react';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import type { LocalExecution, WorklinePanel } from '#surfaces/core/terminal-work/index.js';
import type { PanelSnapshot, TerminalLocalContext } from '#surfaces/core/terminal-kit/index.js';
import { SettingsPanel, type ModelPanelChoice, type ModelPanelReference, type ModelPanelSource, type PanelKind, type PanelLabels, type PanelPorts } from '#surfaces/core/terminal-panels/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import type { WorklinePermissionModePort } from './workline-mode.js';

/** T3 L4: the `/config` and `/mcp` window ports and every panel's words; `/mode`'s port is the workline's own mode hook. T4: `/model`'s source
 * (the session pin is the workline's own) and the `/provider` port. */
export type WorklinePanels = Readonly<{ ports: Omit<PanelPorts, 'mode' | 'model'> & { readonly model?: ModelPanelSource }; labels: PanelLabels }>;
/** T4 MODEL-SWITCH: the session's pinned model, read when a turn starts (the next turn carries it). */
export type WorklineSessionModel = Readonly<{ pinned: () => ModelPanelReference | null; pin: (choice: ModelPanelChoice) => void }>;
type Mode = Readonly<{ stop: PermissionModeStop | undefined; select: (stop: PermissionModeStop) => Promise<void> }>;

const PANEL_COMMANDS: readonly PanelKind[] = ['mode', 'config', 'mcp', 'model', 'provider'];
/** The settings window a bare `/mode`, `/config`, `/mcp`, `/model` or `/provider` opens, when its port is here (any argument keeps the text command). */
function settingsPanelOf(command: string, args: string, ports: PanelPorts | null): PanelKind | null {
  if (!ports || args.trim()) return null;
  const kind = PANEL_COMMANDS.find(item => item === command);
  return kind && ports[kind] ? kind : null;
}

/**
 * The workline's settings windows (T3 L4). `open` runs inside the command that asked for one: the window is a picker of the panel controller
 * (queued lines wait, one input owner), and an approval the `/config` window caused (a write the policy holds) opens when it closes, in the
 * same command. `window` is the open window, or null.
 */
export function useWorklineSettings(input: { readonly panels: WorklinePanels | undefined; readonly permissionMode: WorklinePermissionModePort | undefined; readonly mode: Mode;
  readonly panel: WorklinePanel; readonly state: PanelSnapshot<TerminalLocalContext>; readonly openApprovals: (approvalId: string, execution: LocalExecution) => Promise<void>;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string; readonly blocked: boolean;
  readonly sessionModel?: WorklineSessionModel }) {
  const { panels, permissionMode, panel, state, push, errorText } = input;
  const modeNow = useRef(input.mode); modeNow.current = input.mode;
  const sessionModel = useRef(input.sessionModel); sessionModel.current = input.sessionModel;
  const pinnable = Boolean(input.sessionModel);
  const ports = useMemo<PanelPorts | null>(() => {
    if (!panels) return null;
    const { model, ...rest } = panels.ports;
    return { ...rest, ...(permissionMode ? { mode: {
      inspect: () => permissionMode.inspect(), current: () => modeNow.current.stop ?? null, select: (stop: PermissionModeStop) => modeNow.current.select(stop) } } : {}),
    ...(model && pinnable ? { model: { inspect: () => model.inspect(), ...(model.makeDefault ? { makeDefault: (choice: ModelPanelChoice) => model.makeDefault!(choice) } : {}),
      pinned: () => sessionModel.current?.pinned() ?? null, pin: (choice: ModelPanelChoice) => sessionModel.current?.pin(choice) } } : {}) };
  }, [panels, permissionMode, pinnable]);
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
