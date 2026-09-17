import { ERROR_CODES, ErrorRegistry } from './registry.js';
/** Runtime startup gate also consumed by contract tests; the registry cannot silently grow invalid rows. */
export function lintErrorRegistry(): readonly string[] {
  const issues: string[] = [];
  for (const code of ERROR_CODES) {
    if (!/^(?:DECKENT_E\d{3}|[A-Z][A-Z0-9_]+)$/.test(code)) issues.push(code);
    for (const locale of ['en', 'tr'] as const) if (!ErrorRegistry.get(code, locale)?.message.trim()) issues.push(`${code}:${locale}`);
  }
  if (new Set(ERROR_CODES).size !== ERROR_CODES.length) issues.push('ERROR_REGISTRY_DUPLICATE');
  return Object.freeze(issues);
}
export function assertErrorRegistry(): void {
  const issues = lintErrorRegistry();
  if (issues.length) throw new Error(issues.join(','));
}
