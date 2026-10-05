import { redactForDecision, terminalSafeText, type KnownSecretSnapshot } from '#platform/index.js';
import { plainText, projectHiddenText, sliceSpans, span, type Span } from '#surfaces/core/terminal-render/index.js';

import type { ApprovalDecisionProjection } from './types.js';

// Existing picker-summary bound relocated with its exact admission identity; no new product limit.
const SUMMARY_MAX = 160;

export function projectApprovalDecisionText(raw: string, known?: KnownSecretSnapshot): ApprovalDecisionProjection {
  const received = redactForDecision(raw, known);
  // Scrubbing can reconstruct a known value; preserve the canonical decision mode on both sides of that boundary.
  const display = redactForDecision(terminalSafeText(received.text), known);
  const exact = projectHiddenText(display.text, 'exact');
  return Object.freeze({ ...exact, patternMatches: received.patternMatches });
}

/** Projection is already complete before whitespace collapse and the summary's existing local UTF-16 bound. */
export function approvalSummarySpans(projection: ApprovalDecisionProjection, limit = SUMMARY_MAX): readonly Span[] {
  const flat: Span[] = [];
  let gap = false;
  for (const part of projection.spans) {
    if (part.hiddenCodePoint !== undefined) {
      if (gap && flat.length) flat.push(span(' '));
      gap = false; flat.push(part); continue;
    }
    for (const word of part.text.split(/(\s+)/u)) {
      if (!word) continue;
      if (/^\s+$/u.test(word)) { gap = true; continue; }
      if (gap && flat.length) flat.push(span(' '));
      gap = false; flat.push(Object.freeze({ ...part, text: word }));
    }
  }
  if (plainText(flat).length <= limit) return Object.freeze(flat);
  let end = limit - 1, offset = 0;
  for (const part of flat) {
    if (part.hiddenCodePoint !== undefined && offset < end && offset + part.text.length > end) end = offset;
    offset += part.text.length;
  }
  return Object.freeze([...sliceSpans(flat, 0, end), span('…')]);
}

/** Catalog interpolation retains each field's trusted marker metadata; it does not classify or redact again. */
export function approvalTemplateSpans(template: string, values: Readonly<Record<string, readonly Span[] | string | number>>): readonly Span[] {
  const out: Span[] = []; let cursor = 0;
  for (const match of template.matchAll(/\{(\w+)\}/gu)) {
    out.push(span(template.slice(cursor, match.index)));
    const value = values[match[1]!];
    if (value === undefined) out.push(span(match[0]));
    else if (typeof value === 'string' || typeof value === 'number') out.push(span(String(value)));
    else out.push(...value);
    cursor = match.index + match[0].length;
  }
  out.push(span(template.slice(cursor)));
  return Object.freeze(out);
}
