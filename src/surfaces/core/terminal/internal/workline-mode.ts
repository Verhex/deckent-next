import { useCallback, useRef, useState } from 'react';
import { useInput } from 'ink';
import { PERMISSION_MODES, type PermissionMode, type PermissionModeChange, type PermissionModeView } from '#domain/index.js';
import { type WorkLedgerEntry, notice, fillTemplate } from '#surfaces/core/terminal-ledger/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import { useFocusOwner } from '#surfaces/core/terminal-window/index.js';

/**
 * The person's permission mode through the runtime service (T-L4 slice 4c, protocol v15; MODES-3 v17). The surface reads and writes no
 * file: it asks the service for the mode and sets it conditionally on the revision it last read; a moved revision is the service's typed
 * conflict. `askEdits` absent keeps the person's "ask for edits too" preference.
 */
export interface WorklinePermissionModePort {
  inspect(signal?: AbortSignal): Promise<PermissionModeView>;
  /** `session` (v21 FA-SESSION): full access for this terminal session only — decided and audited by the service, never stored. */
  set(mode: PermissionMode, expectedRevision: string, askEdits?: boolean, session?: WorklineModeSession): Promise<PermissionModeChange>;
}
/** The terminal session a session-only full access belongs to (its conversation id; null before the first one). */
export interface WorklineModeSession { readonly sessionId: string | null }
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
  /** T2 (owner 2026-10-07): full access is switched into inside a session only on the company grant; this says which grant is missing. */
  readonly fullAccessGrant?: string;
  /** MODES-3: the start mode was saved as full access (next launch); this session keeps its mode (`/mode start full-access`, an explicit request). */
  readonly startSaved?: string;
  /** MODES-3: the "ask for edits too" preference is on / off (`/mode ask-edits on|off`). */
  readonly askEditsOn?: string; readonly askEditsOff?: string;
  /** T2 T-MODE-CYCLE: the word of each cycle stop (status row and notices), and the one-line notice of a Shift+Tab step (`{previous}`, `{mode}`);
   * `cycledFullAccess` is the step into full access, which also says what that means. Neutral catalog ids meanwhile. */
  readonly stops?: Readonly<Record<PermissionModeStop, string>>;
  readonly cycled?: string; readonly cycledFullAccess?: string;
}
// Until the catalog carries these templates the notices stay language-neutral: the command, the catalog mode and the policy field.
const NEUTRAL: WorklineModeLabels = { current: '/mode · {mode}', changed: '/mode · {previous} → {mode}', inert: ' · modeEligible: 0',
  unsupported: '/mode · {mode} · policy v1', usage: '/mode [standart|full-auto|full-access] · /mode ask-edits on|off · /mode start full-access' };
const SWITCHABLE: readonly PermissionMode[] = PERMISSION_MODES;

/**
 * T2 T-MODE-CYCLE (owner 2026-10-07, corrected): the stops Shift+Tab walks — every mode the person may take here. `ask-edits` is `standart` with
 * the person's "ask for edits too" preference (not a policy mode). Full-auto is in the cycle unless the company's set grant leaves it out (an
 * older service that does not say keeps it in and answers the set itself); full access only on the company grant. A v1 policy has no cycle.
 */
export function permissionModeCycle(view: PermissionModeView): readonly PermissionModeStop[] {
  if (!view.supported) return [];
  return ['standart', 'ask-edits', ...(view.fullAuto === false ? [] : ['full-auto' as const]), ...(view.fullAccess ? ['full-access' as const] : [])];
}
export function permissionModeStop(view: PermissionModeView, fullAccess: boolean): PermissionModeStop {
  const mode = sessionMode(view, fullAccess);
  return mode === 'standart' && view.askEdits ? 'ask-edits' : mode;
}
/** The stop after `current`; a current stop the cycle no longer holds (a grant withdrawn meanwhile) goes back to the start, standart. */
export function nextPermissionModeStop(cycle: readonly PermissionModeStop[], current: PermissionModeStop): PermissionModeStop | null {
  return cycle.length ? cycle[(cycle.indexOf(current) + 1) % cycle.length]! : null;
}
const STOP_TARGET: Readonly<Record<PermissionModeStop, { readonly mode: PermissionMode; readonly askEdits: boolean }>> = {
  standart: { mode: 'standart', askEdits: false }, 'ask-edits': { mode: 'standart', askEdits: true },
  'full-auto': { mode: 'full-auto', askEdits: false }, 'full-access': { mode: 'full-access', askEdits: false },
};

/** The mode this session runs in: full access only while the session holds it (launched so, or switched into on the company grant); a stored
 * full-access mode without that runs as standart (the decision's own reading). */
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
/** What the person can try next: every other mode they may take here with its sentence; without the full-access grant, which grant it needs. */
function options(view: PermissionModeView, labels: WorklineModeLabels, fullAccess: boolean): WorkLedgerEntry[] {
  if (!view.supported || !labels.effect || !labels.switch) return [];
  const current = sessionMode(view, fullAccess);
  const others = SWITCHABLE.filter(mode => mode !== current && (mode !== 'full-access' || view.fullAccess) && (mode !== 'full-auto' || view.fullAuto !== false))
    .map(mode => `/mode ${mode} (${labels.effect![mode]})`);
  return [...(others.length ? [notice('info', fillTemplate(labels.switch, { options: others.join('; ') }))] : []),
    ...(labels.fullAccessGrant && !view.fullAccess && !fullAccess ? [notice('info', labels.fullAccessGrant)] : [])];
}

/**
 * `/mode` shows the mode; `/mode standart|full-auto|full-access` sets it with the revision last read (read first when none is known). Full
 * access (T2, owner 2026-10-07) is switched into inside the session through the same service set, for this session only (FA-SESSION): the
 * service decides the company grant and audits the switch (`permission-mode-session`) but stores nothing, so the next launch starts in the last
 * stored mode; every later turn is admitted and audited on the grant again; choosing standart or full-auto leaves it (and stores that mode). `/mode ask-edits on|off` sets the person's preference; `/mode start full-access` saves full access as the start mode of
 * the next launch while this session keeps its mode. Anything else is the usage line and calls nothing. Port failures propagate.
 */
export async function runModeCommand(args: string, port: WorklinePermissionModePort, known: PermissionModeView | null, labels: WorklineModeLabels = NEUTRAL,
  fullAccess = false, terminal: WorklineModeSession = { sessionId: null }): Promise<{ readonly entries: readonly WorkLedgerEntry[]; readonly view: PermissionModeView | null; readonly fullAccess: boolean }> {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  const done = (entries: readonly WorkLedgerEntry[], view: PermissionModeView | null, session = fullAccess) => ({ entries, view, fullAccess: session });
  if (words.length === 0) { const view = await port.inspect(); return done([notice('info', line(view, labels, fullAccess)), ...options(view, labels, fullAccess)], view); }
  const askEdits = words.length === 2 && words[0] === 'ask-edits' && (words[1] === 'on' || words[1] === 'off') ? words[1] === 'on' : undefined;
  const start = words.length === 2 && words[0] === 'start' && words[1] === 'full-access';
  const mode = words.length === 1 ? SWITCHABLE.find(value => value === words[0]) : undefined;
  if (!mode && askEdits === undefined && !start) return done([notice('error', labels.usage)], known);
  const base = known ?? await port.inspect();
  // A v1 policy has no modes: there is nothing to set, so the service is not asked (it would only refuse, and the person needs the way forward).
  if (!base.supported) return done([notice('error', line(base, labels, fullAccess))], base);
  const target = start ? 'full-access' : mode ?? base.mode;
  const changed = mode === 'full-access' ? await port.set(target, base.revision, undefined, terminal) : await port.set(target, base.revision, askEdits);
  const { previous, changed: wrote, ...view } = changed;
  if (start) return done([notice('info', labels.startSaved ?? line(view, labels, fullAccess))], view);
  // The service set the mode (a refused full access throws): the session follows it; a preference change keeps the session's mode.
  const session = mode ? mode === 'full-access' : fullAccess;
  const said = askEdits === undefined ? (wrote || fullAccess !== session ? line(view, labels, session, fullAccess ? 'full-access' : previous) : line(view, labels, session))
    : (askEdits ? labels.askEditsOn : labels.askEditsOff) ?? line(view, labels, session);
  return done([notice(mode === 'full-access' ? 'error' : 'info', said)], view, session);
}

/**
 * One Shift+Tab step (T2 T-MODE-CYCLE): the next stop of the cycle set through the service with the revision last read and the stop's
 * explicit `askEdits` (full-auto never inherits "ask for edits too"). The service decides each grant and audits every change; a refusal or a
 * moved revision propagates. Returns the one-line notice, the new view and whether the session now holds full access.
 */
export async function cyclePermissionMode(port: WorklinePermissionModePort, known: PermissionModeView | null, labels: WorklineModeLabels = NEUTRAL,
  fullAccess = false, session: WorklineModeSession = { sessionId: null }): Promise<{ readonly entries: readonly WorkLedgerEntry[]; readonly view: PermissionModeView | null; readonly fullAccess: boolean }> {
  const base = known ?? await port.inspect();
  if (!base.supported) return { entries: [notice('error', line(base, labels, fullAccess))], view: base, fullAccess };
  const current = permissionModeStop(base, fullAccess), next = nextPermissionModeStop(permissionModeCycle(base), current) ?? 'standart';
  const target = STOP_TARGET[next];
  // FA-SESSION: the full-access stop is this session's only; every other stop is stored (the next launch's mode).
  const changed = next === 'full-access' ? await port.set('full-access', base.revision, undefined, session) : await port.set(target.mode, base.revision, target.askEdits);
  const view: PermissionModeView = Object.freeze({ schemaVersion: changed.schemaVersion, scopeId: changed.scopeId, supported: changed.supported, mode: changed.mode,
    askEdits: changed.askEdits, revision: changed.revision, eligible: changed.eligible, fullAccess: changed.fullAccess, ...(changed.fullAuto === undefined ? {} : { fullAuto: changed.fullAuto }) });
  const word = (stop: PermissionModeStop) => labels.stops?.[stop] ?? stop;
  const template = next === 'full-access' ? labels.cycledFullAccess ?? labels.changed : labels.cycled ?? labels.changed;
  return { entries: [notice(next === 'full-access' ? 'error' : 'info', fillTemplate(template, { previous: word(current), mode: word(next) }))], view, fullAccess: next === 'full-access' };
}

/** The status row's mode stop (null: unknown or unsupported — no segment; full access always shown), `/mode` and the Shift+Tab step. A failure
 * refreshes the view. `launchedFullAccess`: the session was launched in full access (the launch already checked the company grant). */
export function useWorklineMode(port: WorklinePermissionModePort | undefined, push: (entries: readonly WorkLedgerEntry[]) => void,
  errorText: (error: unknown) => string, unavailable: string, labels?: WorklineModeLabels, launchedFullAccess = false, sessionId: () => string | null = () => null) {
  const [view, setView] = useState<PermissionModeView | null>(null), [fullAccess, setFullAccess] = useState(launchedFullAccess);
  // Read by the turn when it starts (a `/mode` queued before a message holds for it although no render ran between them).
  const current = useRef(launchedFullAccess);
  // One step at a time: a Shift+Tab pressed while a set is in flight is not queued behind a revision it would conflict with.
  const stepping = useRef(false);
  const refresh = useCallback(async () => {
    if (!port) return;
    try { setView(await port.inspect()); } catch { setView(null); }
  }, [port]);
  const apply = useCallback(async (work: () => ReturnType<typeof runModeCommand>) => {
    try {
      const result = await work();
      push(result.entries);
      setView(result.view);
      current.current = result.fullAccess; setFullAccess(result.fullAccess);
    } catch (error) { push([notice('error', errorText(error))]); await refresh(); }
  }, [errorText, push, refresh]);
  const run = useCallback(async (args: string) => {
    if (!port) { push([notice('error', unavailable)]); return; }
    await apply(() => runModeCommand(args, port, view, labels, current.current, { sessionId: sessionId() }));
  }, [apply, labels, port, push, sessionId, unavailable, view]);
  const cycle = useCallback(async () => {
    if (!port) { push([notice('error', unavailable)]); return; }
    if (stepping.current) return;
    stepping.current = true;
    try { await apply(() => cyclePermissionMode(port, view, labels, current.current, { sessionId: sessionId() })); } finally { stepping.current = false; }
  }, [apply, labels, port, push, sessionId, unavailable, view]);
  const stop = fullAccess ? 'full-access' as const : view?.supported ? permissionModeStop(view, false) : undefined;
  return { mode: fullAccess ? 'full-access' as const : view?.supported ? sessionMode(view, false) : undefined, stop, fullAccess: current, refresh, run, cycle };
}

/**
 * T2 T-MODE-CYCLE + TS-WINDOW: Shift+Tab (Alt+M where the console cannot report Shift+Tab) steps the mode only while the base layer owns the
 * keyboard — `active` (no card, picker or running turn) and the window stack idle. Any open window, including one that is neither a card
 * nor a picker, owns Shift+Tab, so the mode never changes behind a window. Rendered inside the `WindowStackProvider`.
 */
export function PermissionModeKeys({ active, onCycle }: { readonly active: boolean; readonly onCycle: () => void }): null {
  const owner = useFocusOwner();
  useInput((input, key) => { if ((key.tab && key.shift) || (key.meta && !key.ctrl && input === 'm')) onCycle(); }, { isActive: active && owner.idle });
  return null;
}
