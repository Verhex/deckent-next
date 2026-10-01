import { WORKSPACE_ATTACHMENT_MAX_BYTES, type WorkspaceAttachment, type WorkspaceAttachmentRequest, type WorkspaceFileMatches, type WorkspaceFileQuery } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
/** Runtime v15 composer `@file` operations; the shipped executable wires the local runtime client. */
export interface TerminalMentionPorts {
  find(projectRoot: string, query: WorkspaceFileQuery, options: ConfigLoadOptions, signal?: AbortSignal): Promise<WorkspaceFileMatches>;
  attach(projectRoot: string, request: WorkspaceAttachmentRequest, options: ConfigLoadOptions, signal?: AbortSignal): Promise<WorkspaceAttachment>;
}
/** At most this many files per message; later mentions stay plain text and are reported. */
export const TERMINAL_MENTION_MAX_FILES = 8;
/** All attached content of one message together (each file also at most `WORKSPACE_ATTACHMENT_MAX_BYTES`). */
export const TERMINAL_MENTION_TOTAL_BYTES = 131_072;
export const TERMINAL_MENTION_CANDIDATES = 20;
export type TerminalMentionNote =
  | { readonly path: string; readonly status: 'attached'; readonly bytes: number; readonly totalBytes: number; readonly truncated: boolean }
  | { readonly path: string; readonly status: 'refused'; readonly reason: string };
/** Composer candidates for `@query` from the service's scoped read port. */
export async function findTerminalMentions(input: { readonly projectRoot: string; readonly scopeId: string; readonly query: string; readonly options: ConfigLoadOptions;
  readonly signal?: AbortSignal }, ports: TerminalMentionPorts): Promise<readonly string[]> {
  const found = await ports.find(input.projectRoot, { schemaVersion: 1, scopeId: input.scopeId, query: input.query, limit: TERMINAL_MENTION_CANDIDATES },
    input.options, input.signal);
  return found.paths;
}
/**
 * The user message of a line with `@path` mentions: the typed text, then one labelled block per attached file. Content comes from
 * the service (bounded per file and per message); a cut says how much was sent of how much. The block labels are model-facing
 * protocol text, not catalog strings. Refusals and skipped mentions are reported, never silently dropped.
 */
export async function attachTerminalMentions(input: { readonly projectRoot: string; readonly scopeId: string; readonly text: string; readonly paths: readonly string[];
  readonly options: ConfigLoadOptions; readonly signal?: AbortSignal }, ports: TerminalMentionPorts): Promise<{ content: string; notes: readonly TerminalMentionNote[] }> {
  const blocks: string[] = [], notes: TerminalMentionNote[] = [];
  let remaining = TERMINAL_MENTION_TOTAL_BYTES;
  for (const [index, path] of input.paths.entries()) {
    if (index >= TERMINAL_MENTION_MAX_FILES || remaining < 1) { notes.push({ path, status: 'refused', reason: 'limit' }); continue; }
    const attached = await ports.attach(input.projectRoot, { schemaVersion: 1, scopeId: input.scopeId, path,
      maxBytes: Math.min(WORKSPACE_ATTACHMENT_MAX_BYTES, remaining) }, input.options, input.signal);
    if (attached.status === 'refused') { notes.push({ path: attached.path, status: 'refused', reason: attached.reason }); continue; }
    remaining -= attached.bytes;
    notes.push({ path: attached.path, status: 'attached', bytes: attached.bytes, totalBytes: attached.totalBytes, truncated: attached.truncated });
    const size = attached.truncated ? `first ${attached.bytes} of ${attached.totalBytes} bytes; the rest was not attached` : `${attached.totalBytes} bytes`;
    blocks.push(`--- attached file ${attached.path} (${size}) ---\n${attached.content}${attached.content.endsWith('\n') ? '' : '\n'}--- end of ${attached.path} ---`);
  }
  return { content: blocks.length ? `${input.text}\n\n${blocks.join('\n\n')}` : input.text, notes };
}
