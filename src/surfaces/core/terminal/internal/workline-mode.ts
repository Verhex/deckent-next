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
  /** One sentence per catalog mode on what it changes; `switch` has `{options}` (the other modes with their sentences). Both optional: the
   * neutral notice stays a bare mode line. */
  readonly effect?: Readonly<Record<PermissionMode, string>>;
  readonly switch?: string;
}
// Until the catalog carries these templates the notices stay language-neutral: the command, the catalog mode and the policy field.
const NEUTRAL: WorklineModeLabels = { current: '/mode · {mode}', changed: '/mode · {previous} → {mode}', inert: ' · modeEligible: 0',
  unsupported: '/mode · {mode} · policy v1', usage: `/mode ${PERMISSION_MODES.join('|')}` };

function line(view: PermissionModeView, labels: WorklineModeLabels, previous?: PermissionMode): string {
  if (!view.supported) return fillTemplate(labels.unsupported, { mode: view.mode });
  const text = previous === undefined ? fillTemplate(labels.current, { mode: view.mode }) : fillTemplate(labels.changed, { previous, mode: view.mode });
  const said = labels.effect ? `${text} — ${labels.effect[view.mode]}` : text;
  return view.eligible ? said : `${said}${labels.inert}`;
}
/** What the person can try next: every other catalog mode with its sentence (relaxing needs a company grant; the service answers a refusal). */
function options(view: PermissionModeView, labels: WorklineModeLabels): WorkLedgerEntry[] {
  if (!view.supported || !labels.effect || !labels.switch) return [];
  const others = PERMISSION_MODES.filter(mode => mode !== view.mode).map(mode => `/mode ${mode} (${labels.effect![mode]})`);
  return [notice('info', fillTemplate(labels.switch, { options: others.join('; ') }))];
}

/** `/mode` shows the mode; `/mode <mode>` sets a catalog mode with the revision last read (read first when none is known). Anything else is
 * the usage line and calls nothing. Port failures propagate to the caller (typed errors render there). */
export async function runModeCommand(args: string, port: WorklinePermissionModePort, known: PermissionModeView | null,
  labels: WorklineModeLabels = NEUTRAL): Promise<{ readonly entries: readonly WorkLedgerEntry[]; readonly view: PermissionModeView | null }> {
  const requested = args.trim();
  if (!requested) { const view = await port.inspect(); return { entries: [notice('info', line(view, labels)), ...options(view, labels)], view }; }
  const mode = PERMISSION_MODES.find(value => value === requested);
  if (!mode) return { entries: [notice('error', labels.usage)], view: known };
  const base = known ?? await port.inspect();
  // A v1 policy has no modes: there is nothing to set, so the service is not asked (it would only refuse, and the person needs the way forward).
  if (!base.supported) return { entries: [notice('error', line(base, labels))], view: base };
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
