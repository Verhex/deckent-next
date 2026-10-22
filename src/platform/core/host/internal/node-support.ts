/** Whether a Node.js version satisfies the package's engine range (the manifest range, never a source literal).
 * The range is one or more `||` clauses, each `>=X.Y.Z` with an optional `<M` upper major: one patched floor per supported major.
 * Node 24.21 and older 24.x carry a heap overrun in unaligned UTF-16LE decoding (fixed in 24.22.0); 24.22.1 and 26.12.1 are the
 * 2026-10-21 security release (Brotli out-of-bounds write, TLS hostname checks). An unparsable range or version is `unknown`. */
export interface NodeSupport { readonly version: string; readonly floor: string | null; readonly status: 'supported' | 'unsupported' | 'unknown' }
type Triple = readonly [number, number, number];
interface Clause { readonly floor: string; readonly min: Triple; readonly belowMajor: number | null }
const TRIPLE = /(\d+)\.(\d+)\.(\d+)/;
const CLAUSE = /^>=\s*(\d+\.\d+\.\d+)(?:\s+<\s*(\d+))?$/;
const triple = (value: string): Triple | null => {
  const match = TRIPLE.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function clauses(range: string): readonly Clause[] | null {
  const parsed = range.split('||').map(part => {
    const match = CLAUSE.exec(part.trim());
    return match ? { floor: match[1]!, min: triple(match[1]!)!, belowMajor: match[2] === undefined ? null : Number(match[2]) } : null;
  });
  if (!parsed.every((clause): clause is Clause => clause !== null)) return null;
  return [...parsed].sort((a, b) => compare(a.min, b.min));
}
/** Every clause floor, lowest first (`['24.22.1', '26.12.1']`); empty for an unparsable range. */
export function nodeEngineFloors(range: string): readonly string[] {
  return (clauses(range) ?? []).map(clause => clause.floor);
}
export function assessNodeSupport(version: string, range: string): NodeSupport {
  const sorted = clauses(range), have = triple(version);
  if (!sorted || !have) return { version, floor: sorted?.[0]?.floor ?? null, status: 'unknown' };
  const satisfied = sorted.find(clause => compare(have, clause.min) >= 0 && (clause.belowMajor === null || have[0] < clause.belowMajor));
  if (satisfied) return { version, floor: satisfied.floor, status: 'supported' };
  // Name the same major's floor, else the next higher major's, else the highest.
  const named = sorted.find(clause => clause.min[0] === have[0]) ?? sorted.find(clause => clause.min[0] > have[0]) ?? sorted[sorted.length - 1]!;
  return { version, floor: named.floor, status: 'unsupported' };
}
