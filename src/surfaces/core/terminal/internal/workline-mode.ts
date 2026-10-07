import { useCallback, useRef, useState } from 'react';
import { PERMISSION_MODES, type PermissionMode, type PermissionModeChange, type PermissionModeView } from '#domain/index.js';
import { type WorkLedgerEntry, notice, fillTemplate } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The person's permission mode through the runtime service (T-L4 slice 4c, protocol v15; MODES-3 v17). The surface reads and writes no
 * file: it asks the service for the mode and sets it conditionally on the revision it last read; a moved revision is the service's typed
 * conflict. `askEdits` absent keeps the person's "ask for edits too" preference.
 */
export interface WorklinePermissionModePort {
  inspect(signal?: AbortSignal): Promise<PermissionModeView>;
  set(mode: PermissionMode, expectedRevision: string, askEdits?: boolean): Promise<PermissionModeChange>;
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
  /** MODES-3: `/mode full-access` inside a session (refused: full access starts only at launch — how to start it). */
  readonly fullAccessLaunch?: string;
  /** MODES-3: the start mode was saved as full access (next launch); this session keeps its mode. */
  readonly startSaved?: string;
  /** MODES-3: the "ask for edits too" preference is on / off (`/mode ask-edits on|off`). */
  readonly askEditsOn?: string; readonly askEditsOff?: string;
}
// Until the catalog carries these templates the notices stay language-neutral: the command, the catalog mode and the policy field.
const NEUTRAL: WorklineModeLabels = { current: '/mode · {mode}', changed: '/mode · {previous} → {mode}', inert: ' · modeEligible: 0',
  unsupported: '/mode · {mode} · policy v1', usage: '/mode [standart|full-auto] · /mode ask-edits on|off · /mode start full-access' };
const SWITCHABLE: readonly PermissionMode[] = PERMISSION_MODES.filter(mode => mode !== 'full-access');

/** The mode this session runs in: full access only when it was launched so (and not tightened since); a stored full-access start mode
 * without a launched session runs as standart (the decision's own reading). */
function sessionMode(view: PermissionModeView, fullAccess: boolean): PermissionMode {
  return fullAccess ? 'full-access' : view.mode === 'full-access' ? 'standart' : view.mode;
}
function line(view: PermissionModeView, labels: WorklineModeLabels, fullAccess: boolean, previous?: PermissionMode): string {
  const mode = sessionMode(view, fullAccess);
  if (!view.supported) return fillTemplate(labels.unsupported, { mode });
  const text = previous === undefined ? fillTemplate(labels.current, { mode }) : fillTemplate(labels.changed, { previous, mode });
  const said = labels.effect ? `${text} — ${labels.effect[mode]}` : text;
  const edits = view.askEdits && mode !== 'full-access' && labels.askEditsOn ? ` · ${labels.askEditsOn}` : '';
  return view.eligible || mode === 'full-access' ? `${said}${edits}` : `${said}${edits}${labels.inert}`;
}
/** What the person can try next: every other switchable mode with its sentence, and how full access starts (never switched into). */
function options(view: PermissionModeView, labels: WorklineModeLabels, fullAccess: boolean): WorkLedgerEntry[] {
  if (!view.supported || !labels.effect || !labels.switch) return [];
  const current = sessionMode(view, fullAccess);
  const others = SWITCHABLE.filter(mode => mode !== current).map(mode => `/mode ${mode} (${labels.effect![mode]})`);
  return [notice('info', fillTemplate(labels.switch, { options: others.join('; ') })), ...(labels.fullAccessLaunch && !fullAccess ? [notice('info', labels.fullAccessLaunch)] : [])];
}

/**
 * `/mode` shows the mode; `/mode standart|full-auto` sets it with the revision last read (read first when none is known) — in a full-access
 * session it also ends full access for the rest of the session; `/mode ask-edits on|off` sets the person's preference; `/mode start full-access`
 * saves full access as the start mode of the next launch (a company grant is needed; this session keeps its mode). `/mode full-access` is
 * refused here — the service is not asked — with how to start it. Anything else is the usage line and calls nothing. Port failures propagate.
 */
export async function runModeCommand(args: string, port: WorklinePermissionModePort, known: PermissionModeView | null, labels: WorklineModeLabels = NEUTRAL,
  fullAccess = false): Promise<{ readonly entries: readonly WorkLedgerEntry[]; readonly view: PermissionModeView | null; readonly fullAccess: boolean }> {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  const done = (entries: readonly WorkLedgerEntry[], view: PermissionModeView | null, session = fullAccess) => ({ entries, view, fullAccess: session });
  if (words.length === 0) { const view = await port.inspect(); return done([notice('info', line(view, labels, fullAccess)), ...options(view, labels, fullAccess)], view); }
  if (words.length === 1 && words[0] === 'full-access') return done([notice('error', labels.fullAccessLaunch ?? labels.usage)], known);
  const askEdits = words.length === 2 && words[0] === 'ask-edits' && (words[1] === 'on' || words[1] === 'off') ? words[1] === 'on' : undefined;
  const start = words.length === 2 && words[0] === 'start' && words[1] === 'full-access';
  const mode = words.length === 1 ? SWITCHABLE.find(value => value === words[0]) : undefined;
  if (!mode && askEdits === undefined && !start) return done([notice('error', labels.usage)], known);
  const base = known ?? await port.inspect();
  // A v1 policy has no modes: there is nothing to set, so the service is not asked (it would only refuse, and the person needs the way forward).
  if (!base.supported) return done([notice('error', line(base, labels, fullAccess))], base);
  const target = start ? 'full-access' : mode ?? base.mode;
  const changed = await port.set(target, base.revision, askEdits);
  const { previous, changed: wrote, ...view } = changed;
  if (start) return done([notice('info', labels.startSaved ?? line(view, labels, fullAccess))], view);
  // Choosing standart or full-auto in a full-access session tightens it for the rest of the session; full access never comes back in it.
  const session = mode ? false : fullAccess;
  const said = askEdits === undefined ? (wrote || fullAccess !== session ? line(view, labels, session, fullAccess ? 'full-access' : previous) : line(view, labels, session))
    : (askEdits ? labels.askEditsOn : labels.askEditsOff) ?? line(view, labels, session);
  return done([notice('info', said)], view, session);
}

/** The status row's mode (null: unknown or unsupported — no segment; full access always shown) and the `/mode` command. A failure refreshes
 * the view. `launchedFullAccess`: the session was launched in full access (the launch already checked the company grant). */
export function useWorklineMode(port: WorklinePermissionModePort | undefined, push: (entries: readonly WorkLedgerEntry[]) => void,
  errorText: (error: unknown) => string, unavailable: string, labels?: WorklineModeLabels, launchedFullAccess = false) {
  const [view, setView] = useState<PermissionModeView | null>(null), [fullAccess, setFullAccess] = useState(launchedFullAccess);
  // Read by the turn when it starts (a `/mode` queued before a message holds for it although no render ran between them).
  const current = useRef(launchedFullAccess);
  const refresh = useCallback(async () => {
    if (!port) return;
    try { setView(await port.inspect()); } catch { setView(null); }
  }, [port]);
  const run = useCallback(async (args: string) => {
    if (!port) { push([notice('error', unavailable)]); return; }
    try {
      const result = await runModeCommand(args, port, view, labels, current.current);
      push(result.entries);
      setView(result.view);
      current.current = result.fullAccess; setFullAccess(result.fullAccess);
    } catch (error) { push([notice('error', errorText(error))]); await refresh(); }
  }, [errorText, labels, port, push, refresh, unavailable, view]);
  return { mode: fullAccess ? 'full-access' as const : view?.supported ? sessionMode(view, false) : undefined, fullAccess: current, refresh, run };
}
