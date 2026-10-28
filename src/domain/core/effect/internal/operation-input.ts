/** One input value on one card line: strings as written, other values as compact JSON. */
const shown = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
/**
 * BeUser (lead 2026-10-28): what an operation approval card says the command will change: one `label: value` line per top-level input field
 * (label from the catalog's `inputLabels`, else the field name), in the input's order. A credential-named field (`sensitive`) shows `[redacted]`; every
 * other value passes `redact` (known secrets and credential patterns). Bounded by `budget`; fields that do not fit are counted on a last line.
 * Presentation only: the input digest on the binding line stays the integrity anchor of what is approved.
 */
export function describeOperationInput(input: unknown, labels: Readonly<Record<string, string>> | undefined, redact: (text: string) => string,
  sensitive: (key: string) => boolean, budget: number, more: (count: number) => string): string | null {
  const entries = input !== null && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [['input', input] as const];
  const lines: string[] = [];
  let used = 0;
  for (const [index, [key, value]] of entries.entries()) {
    const line = redact(`${labels?.[key] ?? key}: ${sensitive(key) ? '[redacted]' : shown(value)}`).replace(/[\r\n]+/gu, ' ');
    const tail = more(entries.length - index);
    if (used + line.length + 1 + (index + 1 < entries.length ? tail.length + 1 : 0) > budget) { if (used + tail.length <= budget) lines.push(tail); break; }
    lines.push(line); used += line.length + 1;
  }
  return lines.length ? lines.join('\n') : null;
}
