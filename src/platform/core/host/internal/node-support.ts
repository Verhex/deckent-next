/** Whether a Node.js version satisfies the package's `>=X.Y.Z` engine floor (the manifest range, never a source literal).
 * Node 24.21 and older 24.x carry a heap overrun in unaligned UTF-16LE decoding (fixed upstream in 24.22.0). */
export interface NodeSupport { readonly version: string; readonly floor: string | null; readonly status: 'supported' | 'unsupported' | 'unknown' }
const TRIPLE = /(\d+)\.(\d+)\.(\d+)/;
const triple = (value: string): readonly [number, number, number] | null => {
  const match = TRIPLE.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
export function assessNodeSupport(version: string, range: string): NodeSupport {
  const floor = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1] ?? null;
  const have = triple(version), need = floor ? triple(floor) : null;
  if (!have || !need) return { version, floor, status: 'unknown' };
  for (let index = 0; index < 3; index += 1) if (have[index]! !== need[index]!) return { version, floor, status: have[index]! > need[index]! ? 'supported' : 'unsupported' };
  return { version, floor, status: 'supported' };
}
