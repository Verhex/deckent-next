import { useCallback } from 'react';
import type { ScratchClearance, ScratchView } from '#domain/index.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { notice } from './workline-actions.js';
import { fillTemplate } from './worker-line.js';

/**
 * The conversation's scratch area through the runtime service (SCR-A, protocol v16): the surface reads and deletes no file. The area
 * belongs to the conversation (`/new` starts another, `/resume` returns to one), so every call names the current session.
 */
export interface WorklineScratchPort {
  inspect(sessionId: string, signal?: AbortSignal): Promise<ScratchView>;
  clear(sessionId: string): Promise<ScratchClearance>;
}
/** Templates: `{path}`, `{count}`, `{bytes}`, `{limit}`. */
export interface WorklineScratchLabels {
  readonly summary: string; readonly empty: string; readonly entry: string; readonly more: string; readonly path: string;
  readonly cleared: string; readonly usage: string;
}
// Until the catalog carries these templates the notices stay language-neutral: the command, the path and the numbers.
const NEUTRAL: WorklineScratchLabels = { summary: '/scratch · {path} · {count} files · {bytes} of {limit} bytes', empty: '/scratch · {path} · empty',
  entry: '  {path} · {bytes} bytes', more: '  … {count} more', path: '/scratch · {path}',
  cleared: '/scratch clear · {count} files ({bytes} bytes) removed · {path}', usage: '/scratch [path|clear]' };
const LISTED = 20;

/** `/scratch` lists the area (newest first), `/scratch path` names it, `/scratch clear` empties it; anything else is the usage line and
 * calls nothing. Port failures propagate to the caller (typed errors render there). */
export async function runScratchCommand(args: string, sessionId: string, port: WorklineScratchPort,
  labels: WorklineScratchLabels = NEUTRAL): Promise<readonly WorkLedgerEntry[]> {
  const verb = args.trim().toLowerCase();
  if (verb === 'clear') {
    const done = await port.clear(sessionId);
    return [notice('info', fillTemplate(labels.cleared, { count: done.removedFiles, bytes: done.removedBytes, path: done.path }))];
  }
  if (verb !== '' && verb !== 'path') return [notice('error', labels.usage)];
  const view = await port.inspect(sessionId);
  if (verb === 'path') return [notice('info', fillTemplate(labels.path, { path: view.path }))];
  if (!view.files.length) return [notice('info', fillTemplate(labels.empty, { path: view.path }))];
  const shown = view.files.slice(0, LISTED);
  return [notice('info', fillTemplate(labels.summary, { path: view.path, count: view.files.length, bytes: view.bytes, limit: view.limits.sessionMaxBytes })),
    ...shown.map(file => notice('info', fillTemplate(labels.entry, { path: file.path, bytes: file.bytes }))),
    ...(view.files.length > shown.length ? [notice('info', fillTemplate(labels.more, { count: view.files.length - shown.length }))] : [])];
}

/** The `/scratch` command of the workline; without a port it says the service is unavailable. */
export function useWorklineScratch(port: WorklineScratchPort | undefined, sessionId: () => string, push: (entries: readonly WorkLedgerEntry[]) => void,
  errorText: (error: unknown) => string, unavailable: string, labels?: WorklineScratchLabels) {
  return useCallback(async (args: string) => {
    if (!port) { push([notice('error', unavailable)]); return; }
    try { push(await runScratchCommand(args, sessionId(), port, labels)); }
    catch (error) { push([notice('error', errorText(error))]); }
  }, [errorText, labels, port, push, sessionId, unavailable]);
}
