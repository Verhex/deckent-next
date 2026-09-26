/** Diffs larger than this many line comparisons are summarized instead of computed (bounded service work). */
const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT = 3;

/**
 * Unified diff of two texts for the approval preview (presentation only; the approval binds the call's digest and the write is
 * conditional on the file version). Line LCS by dynamic programming, bounded by MAX_DIFF_CELLS; a larger change is summarized.
 */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = before === null ? [] : before.split('\n'), b = after.split('\n');
  const header = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  if (a.length * b.length > MAX_DIFF_CELLS) return [...header, `@@ ${a.length} lines -> ${b.length} lines (too large to diff here) @@`].join('\n');
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: ' ', text: a[i]!, ai: i, bi: j }); i++; j++; }
    // Removals before additions at a tie (the usual diff reading order).
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: '-', text: a[i]!, ai: i, bi: j }); i++; }
    else { ops.push({ kind: '+', text: b[j]!, ai: i, bi: j }); j++; }
  }
  // Changed positions grouped into hunks: each change with CONTEXT lines around it, groups closer than 2 × CONTEXT merged.
  const changes = ops.flatMap((op, index) => op.kind === ' ' ? [] : [index]);
  const ranges: [number, number][] = [];
  for (const index of changes) {
    const from = Math.max(0, index - CONTEXT), to = Math.min(ops.length, index + CONTEXT + 1), last = ranges.at(-1);
    if (last && from <= last[1]) last[1] = to; else ranges.push([from, to]);
  }
  const hunks: string[] = [];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to), first = slice[0]!;
    const removed = slice.filter(op => op.kind !== '+').length, added = slice.filter(op => op.kind !== '-').length;
    hunks.push(`@@ -${first.ai + (removed ? 1 : 0)},${removed} +${first.bi + (added ? 1 : 0)},${added} @@`, ...slice.map(op => `${op.kind}${op.text}`));
  }
  return [...header, ...hunks].join('\n');
}
