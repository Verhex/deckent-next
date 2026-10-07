import { type WorkLedgerEntry, notice, fillTemplate } from '#surfaces/core/terminal-ledger/index.js';

/** What the service did with one `@path` of a submitted line (T-L5 `@file`). */
export type WorklineMentionNote =
  | { readonly path: string; readonly status: 'attached'; readonly bytes: number; readonly totalBytes: number; readonly truncated: boolean }
  | { readonly path: string; readonly status: 'refused'; readonly reason: string };
/** `content`: the user message as sent (typed text plus labelled, bounded file content); the ledger keeps showing the typed text. */
export interface WorklineMentionAttachment {
  readonly content: string;
  readonly notes: readonly WorklineMentionNote[];
}
/** Attaches the mentioned files through the runtime service; the surface itself reads no file. */
export type WorklineAttachMentions = (text: string, paths: readonly string[], signal: AbortSignal) => Promise<WorklineMentionAttachment>;
/** Templates with `{path}`, `{bytes}`, `{total}`, `{reason}`. */
export interface WorklineMentionLabels {
  readonly attached: string;
  readonly truncated: string;
  readonly refused: string;
}
// Until the catalog carries the templates the notice stays language-neutral: the path, a byte count or the typed refusal code.
const NEUTRAL: WorklineMentionLabels = { attached: '@{path} · {bytes} B', truncated: '@{path} · {bytes}/{total} B', refused: '@{path} · {reason}' };

export function mentionNotices(notes: readonly WorklineMentionNote[], labels: WorklineMentionLabels = NEUTRAL): readonly WorkLedgerEntry[] {
  return notes.map(note => note.status === 'refused'
    ? notice('error', fillTemplate(labels.refused, { path: note.path, reason: note.reason }))
    : notice('info', fillTemplate(note.truncated ? labels.truncated : labels.attached, { path: note.path, bytes: note.bytes, total: note.totalBytes })));
}

/** The message to send for a chat line: its `@path` mentions attached through the port, with one notice per file; a failure keeps the text. */
export async function messageWithMentions(text: string, mentioned: readonly string[], attach: WorklineAttachMentions | undefined, signal: AbortSignal,
  push: (entries: readonly WorkLedgerEntry[]) => void, errorText: (error: unknown) => string, labels?: WorklineMentionLabels): Promise<string> {
  if (!mentioned.length || !attach) return text;
  try {
    const attached = await attach(text, mentioned, signal);
    push(mentionNotices(attached.notes, labels));
    return attached.content;
  } catch (error) {
    if (!signal.aborted) push([notice('error', errorText(error))]);
    return text;
  }
}
