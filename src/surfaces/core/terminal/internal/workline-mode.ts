import { useCallback, useState } from 'react';
import { PERMISSION_MODES, type PermissionMode, type PermissionModeChange, type PermissionModeView } from '#domain/index.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { notice } from './workline-actions.js';
import { fillTemplate } from './worker-line.js';

/**
 * The person's permission mode through the runtime service (T-L4 slice 4c, protocol v15). The surface reads and writes no file: it
 * asks the service for the mode and sets it conditionally on the revision it last read; a moved revision is the service's typed conflict.
 */
export interface WorklinePermissionModePort {
  inspect(signal?: AbortSignal): Promise<PermissionModeView>;
  set(mode: PermissionMode, expectedRevision: string): Promise<PermissionModeChange>;
}
/** Templates with `{mode}` and `{previous}`; `inert` is appended when no company rule is mode-eligible here. */
export interface WorklineModeLabels {
  readonly current: string;
  readonly changed: string;
  readonly inert: string;
  readonly unsupported: string;
  readonly usage: string;
}
// Until the catalog carries these templates the notices stay language-neutral: the command, the catalog mode and the policy field.
const NEUTRAL: WorklineModeLabels = { current: '/mode · {mode}', changed: '/mode · {previous} → {mode}', inert: ' · modeEligible: 0',
  unsupported: '/mode · {mode} · policy v1', usage: `/mode ${PERMISSION_MODES.join('|')}` };

function line(view: PermissionModeView, labels: WorklineModeLabels, previous?: PermissionMode): string {
  if (!view.supported) return fillTemplate(labels.unsupported, { mode: view.mode });
  const text = previous === undefined ? fillTemplate(labels.current, { mode: view.mode }) : fillTemplate(labels.changed, { previous, mode: view.mode });
  return view.eligible ? text : `${text}${labels.inert}`;
}

/** `/mode` shows the mode; `/mode <mode>` sets a catalog mode with the revision last read (read first when none is known). Anything else is
 * the usage line and calls nothing. Port failures propagate to the caller (typed errors render there). */
export async function runModeCommand(args: string, port: WorklinePermissionModePort, known: PermissionModeView | null,
  labels: WorklineModeLabels = NEUTRAL): Promise<{ readonly entries: readonly WorkLedgerEntry[]; readonly view: PermissionModeView | null }> {
  const requested = args.trim();
  if (!requested) { const view = await port.inspect(); return { entries: [notice('info', line(view, labels))], view }; }
  const mode = PERMISSION_MODES.find(value => value === requested);
  if (!mode) return { entries: [notice('error', labels.usage)], view: known };
  const base = known ?? await port.inspect();
  const changed = await port.set(mode, base.revision);
  const { previous, changed: wrote, ...view } = changed;
  return { entries: [notice('info', wrote ? line(view, labels, previous) : line(view, labels))], view };
}

/** The status row's mode (null: unknown or unsupported — no segment) and the `/mode` command; a failure refreshes the view. */
export function useWorklineMode(port: WorklinePermissionModePort | undefined, push: (entries: readonly WorkLedgerEntry[]) => void,
  errorText: (error: unknown) => string, unavailable: string, labels?: WorklineModeLabels) {
  const [view, setView] = useState<PermissionModeView | null>(null);
  const refresh = useCallback(async () => {
    if (!port) return;
    try { setView(await port.inspect()); } catch { setView(null); }
  }, [port]);
  const run = useCallback(async (args: string) => {
    if (!port) { push([notice('error', unavailable)]); return; }
    try {
      const result = await runModeCommand(args, port, view, labels);
      push(result.entries);
      setView(result.view);
    } catch (error) { push([notice('error', errorText(error))]); await refresh(); }
  }, [errorText, labels, port, push, refresh, unavailable, view]);
  return { mode: view?.supported ? view.mode : undefined, refresh, run };
}
