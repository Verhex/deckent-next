/**
 * A copy of one input value with every credential-named key at any depth replaced by `[redacted]` (objects and arrays alike), before anything
 * is serialized. Bounded by `nodes` (the card budget): past it a subtree is `…`, so deep or huge input never costs more than the card shows.
 */
function scrub(value: unknown, sensitive: (key: string) => boolean, nodes: { left: number }): unknown {
  if (--nodes.left < 0) return '…';
  if (Array.isArray(value)) return value.map(item => scrub(item, sensitive, nodes));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, sensitive(key) ? '[redacted]' : scrub(item, sensitive, nodes)]));
  return value;
}
/** One input value on one card line: strings as written, other values as compact JSON. */
const shown = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
/**
 * BeUser (lead 2026-10-28): what an operation approval card says the command will change: one `label: value` line per top-level input field
 * (label from the catalog's `inputLabels`, else the field name), in the input's order. A credential-named key (`sensitive`) at any depth shows `[redacted]`; every
 * other value passes `redact` (known secrets and credential patterns). Bounded by `budget`; fields that do not fit are counted on a last line.
 * Presentation only: the input digest on the binding line stays the integrity anchor of what is approved.
 */
export function describeOperationInput(input: unknown, labels: Readonly<Record<string, string>> | undefined, redact: (text: string) => string,
  sensitive: (key: string) => boolean, budget: number, more: (count: number) => string): string | null {
  const entries = input !== null && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [['input', input] as const];
  const lines: string[] = [], nodes = { left: budget };
  let used = 0;
  for (const [index, [key, value]] of entries.entries()) {
    const line = redact(`${labels?.[key] ?? key}: ${sensitive(key) ? '[redacted]' : shown(scrub(value, sensitive, nodes))}`).replace(/[\r\n]+/gu, ' ');
    const tail = more(entries.length - index);
    if (used + line.length + 1 + (index + 1 < entries.length ? tail.length + 1 : 0) > budget) { if (used + tail.length <= budget) lines.push(tail); break; }
    lines.push(line); used += line.length + 1;
  }
  return lines.length ? lines.join('\n') : null;
}
