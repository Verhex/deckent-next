import { ERROR_CODES, ErrorRegistry } from './registry.js';
/** Consumed by contract tests and, through `assertErrorRegistry`, by the composition root's seal; the registry cannot silently grow invalid rows. */
export function lintErrorRegistry(): readonly string[] {
  const issues: string[] = [];
  for (const code of ERROR_CODES) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(code)) issues.push(code);
    for (const locale of ['en', 'tr'] as const) if (!ErrorRegistry.get(code, locale)?.message.trim()) issues.push(`${code}:${locale}`);
  }
  if (new Set(ERROR_CODES).size !== ERROR_CODES.length) issues.push('ERROR_REGISTRY_DUPLICATE');
  return Object.freeze(issues);
}
let checked = false; // the table is frozen at import, so one passing check holds for the process; a failure is never cached
export function assertErrorRegistry(): void {
  if (checked) return;
  const issues = lintErrorRegistry();
  if (issues.length) throw new Error(issues.join(','));
  checked = true;
}
