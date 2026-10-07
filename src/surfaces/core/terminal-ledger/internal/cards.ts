import { shortId } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, type WorkerLineLabels } from './worker-line.js';
import { parseTaskPhases, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from './work-ledger.js';

/** Catalog words of the run and worker cards; the terminal package never resolves locale text itself. */
export interface LedgerCardLabels {
  /** `{run}` (short form) `{scope}` */
  readonly runHead: string;
  /** `{revision}` */
  readonly runRevision: string;
  readonly runCancelRequested: string;
  /** Task phase → `{count} waiting`-style words, keyed by the phase name (`pending`, `active`, …). */
  readonly runPhases: Readonly<Record<string, string>>;
  /** A phase without its own words: `{count}` `{phase}` (the typed name stays visible). */
  readonly runPhaseOther: string;
  readonly runNoTasks: string;
  /** Worker process state and observation authority in words, keyed by the state / authority name. */
  readonly workerProcess: Readonly<Record<string, string>>;
  readonly workerAuthority: Readonly<Record<string, string>>;
  /** Notice rows: the level in words, as a `{text}` template (`Error: {text}`), so a notice never differs from its neighbours by colour alone. */
  readonly notice?: Readonly<Record<'info' | 'warning' | 'error', string>>;
}

/** Run card body: where it is, the revision with a requested cancellation, and the task phases as counts in words (`2 waiting, 1 running`). */
export function formatRunCardLines(entry: WorkLedgerRunEntry, labels: LedgerCardLabels): readonly string[] {
  const phases = parseTaskPhases(entry.taskPhases).map(([phase, count]) => fillTemplate(labels.runPhases[phase] ?? labels.runPhaseOther, { count, phase }));
  return Object.freeze([fillTemplate(labels.runHead, { run: shortId(entry.runId), scope: entry.scopeId }),
    [fillTemplate(labels.runRevision, { revision: entry.revision }), ...(entry.cancellationRequested ? [labels.runCancelRequested] : [])].join(' · '),
    phases.length ? phases.join(', ') : labels.runNoTasks]);
}

/** Worker card head: the worker's number (or a short task identity for a source without one) and its process state; second line: provider and who observed it. */
export function formatWorkerCardLines(entry: WorkLedgerWorkerEntry, line: WorkerLineLabels): readonly string[] {
  const card = line.card;
  const who = entry.ordinal === undefined ? shortId(entry.taskId) : fillTemplate(line.ordinal, { n: entry.ordinal });
  return Object.freeze([[who, card?.workerProcess[entry.process] ?? entry.process].join(' · '), [entry.provider, card?.workerAuthority[entry.authority] ?? entry.authority].join(' · ')]);
}
