import { createHash } from 'node:crypto';

/** The sealed summary and streamed card share this reason; ordinary cells retain their existing summary. */
export function agentToolApprovalSummary(input: { readonly tool: string; readonly resource: string; readonly argsDigest: string;
  readonly cell: string | null; readonly selfSourceReason: string }): string {
  const binding = `${input.tool} · ${input.resource} · ${input.argsDigest.slice(0, 12)}`;
  return input.cell === 'edit-self-source' ? `${binding}\n${input.selfSourceReason}` : binding;
}

/** Largest approval preview in UTF-8 bytes: far below the event bound and any frame, whatever the script (Astra 2094 R3). */
export const APPROVAL_PREVIEW_MAX_BYTES = 16_384;

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0, end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size; end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The preview an approval card shows. A text within the bound is shown whole; a larger one is cut to whole lines (the first line
 * itself cut at a character boundary when it alone is too long) under a first-line marker — the card shows the top lines, so the
 * marker is always visible — naming what is not shown, the sha256 of the whole text and, when kept, the file holding all of it.
 */
export function boundApprovalPreview(text: string, fullAt: string | null = null, maxBytes = APPROVAL_PREVIEW_MAX_BYTES): string {
  return boundApprovalPreviewFacts(text, fullAt, maxBytes).text;
}
/** What a cut preview's marker states, as data for a card (Astra 2431: the surface never parses the preview text). */
export interface ApprovalPreviewCut { readonly shown: number; readonly total: number; readonly bytes: number; readonly totalBytes: number; readonly digest: string; readonly kept: string | null }
/** `boundApprovalPreview` with the facts of its cut (null: shown whole). */
export function boundApprovalPreviewFacts(text: string, fullAt: string | null = null, maxBytes = APPROVAL_PREVIEW_MAX_BYTES):
  { readonly text: string; readonly cut: ApprovalPreviewCut | null } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { text, cut: null };
  const lines = text.split('\n'), digest = createHash('sha256').update(text).digest('hex');
  const marker = (shown: number, bytes: number) => `[Deckent: preview cut to ${shown} of ${lines.length} lines (${bytes} of ${total} bytes); `
    + `whole text sha256 ${digest}${fullAt ? `; complete at ${fullAt}` : '; not kept'}]`;
  const budget = maxBytes - Buffer.byteLength(marker(lines.length, total), 'utf8') - 1;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size <= budget) { kept.push(line); bytes += size; continue; }
    if (kept.length === 0) { const part = utf8Prefix(line, Math.max(0, budget - 4)); kept.push(`${part} …`); bytes += Buffer.byteLength(`${part} …`, 'utf8') + 1; }
    break;
  }
  return { text: [marker(kept.length, bytes), ...kept].join('\n'),
    cut: Object.freeze({ shown: kept.length, total: lines.length, bytes, totalBytes: total, digest, kept: fullAt }) };
}
