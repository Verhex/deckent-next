import type { EffectApprovalGate } from './application.js';

/** One change the sandboxed command made to the project, as the lower (the real project) must receive it. `lowerVersion`: the sha256 of the
 * lower file when scanned, or `absent` — the write's precondition. */
export type SandboxWriteChange = { readonly kind: 'write'; readonly rel: string; readonly digest: string; readonly size: number; readonly mode: number;
  readonly lowerVersion: string } | { readonly kind: 'delete'; readonly rel: string; readonly lowerVersion: string }
  /** A lower directory the command removed (Astra 2180 R1): an entry like the others — classified, decided, its own effect — applied after the
   * removals beneath it and only when it is empty then (the file target's `empty-directory` version). */
  | { readonly kind: 'rmdir'; readonly rel: string };
/** Why an entry cannot be applied at all (not a policy question: the kind of file). */
export type SandboxWriteRefusal = 'symbolic-link' | 'special-file' | 'hard-link' | 'setuid-setgid' | 'not-a-regular-file';
export type SandboxWriteSetScan = {
  readonly ok: true;
  readonly changes: readonly SandboxWriteChange[];
  readonly refused: readonly { readonly rel: string; readonly reason: SandboxWriteRefusal }[];
  /** Lower paths that changed after the call started (their ctime is not older than the start mark): the project moved under the call. */
  readonly conflicts: readonly string[];
  /** New directories the command left empty (not applied: directories are created only as parents of an applied file). */
  readonly emptyDirectories: readonly string[];
  /** Upper directory modes by path (a created parent gets the mode the command gave it). */
  readonly directoryModes: ReadonlyMap<string, number>;
  /** Directories the command made that the lower lacks (absent there, or a file there it replaced): a parent the apply would create, so
   * each is classified and decided like an entry before any is made (Astra 2182 R3). */
  readonly newDirectories: ReadonlySet<string>;
} | { readonly ok: false; readonly reason: string };

/** The edit cell a write-set entry is decided under (the same three an edit tool call can be), or a path the edit rules deny. */
export type SandboxWriteCell = 'edit' | 'edit-floor' | 'edit-authority' | 'edit-self-source';
export type SandboxWriteDecision = { readonly ok: true; readonly gate: EffectApprovalGate }
  | { readonly ok: false; readonly reason: 'write-floor' | 'configuration-file' | 'approval-required' | 'denied-by-policy' | 'audit-unavailable' };
/** Decides one entry exactly like an edit of that path (design §6); the decision's owner audits a relaxation before handing out the gate. */
export interface SandboxWriteDecider { decide(rel: string, cell: SandboxWriteCell): Promise<SandboxWriteDecision> }
export interface SandboxWriteSetReport {
  /** The whole set was not applied (its bound or its listing); null otherwise. */
  readonly refused: string | null;
  readonly applied: readonly string[];
  readonly notApplied: readonly { readonly rel: string; readonly reason: string }[];
  /** The project changed under the call: nothing was applied. */
  readonly conflicts: readonly string[];
  /** Entries whose outcome is unknown: read the file to see its state. */
  readonly unknown: readonly string[];
  readonly emptyDirectories: readonly string[];
  /** New directories made as parents of applied entries (each decided like an entry; not a C11 record of its own). */
  readonly createdDirectories: readonly string[];
  /** Stopped before the end (cancellation, a precondition that changed at write time, an unknown outcome): the rest was not tried. */
  readonly stopped: boolean;
}
const REASONS: Readonly<Record<string, string>> = {
  'write-floor': 'write floor: the owner approves — use edit_file/write_file',
  'configuration-file': 'the installation\'s configuration file: the owner approves — use edit_file/write_file', 'approval-required': 'needs the owner\'s approval — use edit_file/write_file',
  'denied-by-policy': 'denied by policy', 'audit-unavailable': 'the decision could not be recorded', denied: 'denied path', 'symbolic-link': 'symbolic link',
  'special-file': 'special file', 'hard-link': 'hard link', 'setuid-setgid': 'setuid/setgid bit', 'not-a-regular-file': 'not a regular file',
  'parent-refused': 'its directory could not be created', 'not-empty': 'something beneath it was not applied, so it is not empty', rejected: 'the write was refused', conflict: 'changed during the apply (conflict)',
};
const list = (items: readonly string[], max = 20) => items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')}, … (${items.length - max} more)`;
/** The result lines (trusted metadata, bounded): what the project received from the call and what it did not, and why. */
export function describeSandboxWriteSet(report: SandboxWriteSetReport): string {
  if (report.refused !== null) return `[deckent] write set: nothing was applied (${report.refused}); the project is unchanged.`;
  return [report.conflicts.length ? `[deckent] write set: nothing was applied — the project changed during the call: ${list(report.conflicts)}.` : '',
    report.applied.length ? `[deckent] write set: applied ${report.applied.length} (${list(report.applied)}).` : '',
    report.notApplied.length ? `[deckent] write set: not applied: ${list(report.notApplied.map(entry => `${entry.rel} (${REASONS[entry.reason] ?? entry.reason})`), 12)}.` : '',
    report.unknown.length ? `[deckent] write set: outcome unknown (read the file to see its state): ${list(report.unknown)}.` : '',
    report.stopped ? '[deckent] write set: stopped before the end; the rest was not applied.' : '',
    report.createdDirectories.length ? `[deckent] write set: new directories created: ${list(report.createdDirectories.map(directory => `${directory}/`))}.` : '',
    report.emptyDirectories.length ? `[deckent] write set: empty new directories were not created: ${list(report.emptyDirectories)}.` : ''].filter(Boolean).join('\n');
}

/**
 * Applies a scanned write set (design §5–§6) through the caller's ports: `classify` is the edit path rules (a denied path, else its cell),
 * `decider` the edit decision, `execute` one entry's C11 effect with the gate the decision handed out. A conflict found by the scan
 * applies nothing; deletions go first, then emptied directories, then writes (with their missing parents); a changed precondition or an
 * unknown outcome stops the rest. Nothing is applied to a path the decision did not allow — a new parent directory included (Astra 2182
 * R3): after the write's own decision, each one it needs is classified as a directory and decided like an entry (once per set, shown as
 * `dir/`); when any is refused,
 * none of them is made and the write is not applied (`parent-refused`); `ensureParents` makes only the decided ones.
 */
export async function applySandboxWriteSet(input: { readonly scan: SandboxWriteSetScan; readonly decider: SandboxWriteDecider;
  /** The edit path rules for one entry (a directory removal or a new parent directory, `mkdir`, is classified as a directory: its own name
   * and what lies beneath it). */
  readonly classify: (rel: string, kind: SandboxWriteChange['kind'] | 'mkdir') => SandboxWriteCell | 'denied';
  /** Makes the missing directories above `rel`, only those `admit` names (the decided ones); false when any other would be needed. */
  readonly ensureParents: (rel: string, modeOf: (directory: string) => number, admit: (directory: string) => boolean) => Promise<boolean>;
  readonly execute: (change: SandboxWriteChange, gate: EffectApprovalGate) => Promise<void>; readonly signal: AbortSignal }): Promise<SandboxWriteSetReport> {
  const { scan } = input;
  const report = { refused: null, applied: [] as string[], notApplied: [] as { rel: string; reason: string }[], conflicts: [] as readonly string[], unknown: [] as string[],
    emptyDirectories: [] as readonly string[], createdDirectories: [] as string[], stopped: false };
  if (!scan.ok) return { ...report, refused: scan.reason };
  report.notApplied.push(...scan.refused);
  if (scan.conflicts.length) return { ...report, conflicts: scan.conflicts };
  report.emptyDirectories = scan.emptyDirectories;
  const shown = (change: SandboxWriteChange) => change.kind === 'rmdir' ? `${change.rel}/` : change.rel;
  // Astra 2180 R1: a directory removal is an entry like any other (classified, decided, its own effect, reported); it is held back when
  // anything beneath it stayed (held back, refused or unknown), since the directory is not empty then.
  const stayedBeneath = (rel: string) => [...report.notApplied.map(entry => entry.rel), ...report.unknown].some(other => other.startsWith(`${rel}/`));
  // Astra 2182 R3: the new directories above a write, shallowest first, each decided once per set like an entry; the new ones this write
  // still needs, or null when one of them is refused (reported once, as `dir/` with its own reason).
  const verdicts = new Map<string, boolean>(), created = new Set<string>();
  const newParents = async (rel: string): Promise<string[] | null> => {
    const needed: string[] = [], segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/');
      if (!scan.newDirectories.has(directory) || created.has(directory)) continue;
      let allowed = verdicts.get(directory);
      if (allowed === undefined) {
        const cell = input.classify(directory, 'mkdir');
        const decision = cell === 'denied' ? { ok: false as const, reason: 'denied' } : await input.decider.decide(`${directory}/`, cell);
        allowed = decision.ok;
        verdicts.set(directory, allowed);
        if (!decision.ok) report.notApplied.push({ rel: `${directory}/`, reason: decision.reason });
      }
      if (!allowed) return null;
      needed.push(directory);
    }
    return needed;
  };
  for (const phase of ['delete', 'rmdir', 'write'] as const) {
    for (const change of scan.changes.filter(entry => entry.kind === phase)) {
      if (report.stopped || input.signal.aborted) { report.stopped = true; break; }
      if (change.kind === 'rmdir' && stayedBeneath(change.rel)) { report.notApplied.push({ rel: shown(change), reason: 'not-empty' }); continue; }
      const cell = input.classify(change.rel, change.kind);
      if (cell === 'denied') { report.notApplied.push({ rel: shown(change), reason: 'denied' }); continue; }
      const decision = await input.decider.decide(change.rel, cell);
      if (!decision.ok) { report.notApplied.push({ rel: shown(change), reason: decision.reason }); continue; }
      // Astra 2182 x SBX-05 (lead 2026-10-09): a floor file an approval admits is written only into existing directories, so a shell call never
      // makes a floor-named directory for it (an unattended floor entry is never admitted, so this only bounds approved ones).
      if (change.kind === 'write' && cell !== 'edit' && change.rel.split('/').slice(0, -1).some((_, i, parts) => scan.newDirectories.has(parts.slice(0, i + 1).join('/')))) {
        report.notApplied.push({ rel: change.rel, reason: cell === 'edit-authority' ? 'configuration-file' : 'write-floor' }); continue;
      }
      // The entry's own reason comes first (a refused entry never decides its directories); then each new directory it needs.
      const parents = change.kind === 'write' ? await newParents(change.rel) : [];
      if (parents === null) { report.notApplied.push({ rel: change.rel, reason: 'parent-refused' }); continue; }
      if (change.kind === 'write' && !await input.ensureParents(change.rel, directory => scan.directoryModes.get(directory) ?? 0o755, directory => verdicts.get(directory) === true)) {
        report.notApplied.push({ rel: change.rel, reason: 'parent-refused' }); continue;
      }
      for (const directory of parents) { created.add(directory); report.createdDirectories.push(directory); }
      try { await input.execute(change, decision.gate); report.applied.push(shown(change)); }
      catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'EFFECT_PRECONDITION_CHANGED') { report.notApplied.push({ rel: shown(change), reason: 'conflict' }); report.stopped = true; }
        else if (code === 'EFFECT_OUTCOME_UNKNOWN') { report.unknown.push(shown(change)); report.stopped = true; }
        else report.notApplied.push({ rel: shown(change), reason: code === 'POLICY_DENIED' ? 'denied-by-policy' : code === 'EFFECT_APPROVAL_REQUIRED' ? 'approval-required' : 'rejected' });
      }
    }
  }
  return report;
}
