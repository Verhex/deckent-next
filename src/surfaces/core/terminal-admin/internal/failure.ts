import { ErrorRegistry, t, type Locale } from '#platform/index.js';

/** A typed failure in catalog words with its code; anything else is one fixed sentence (no transport or provider text on screen). */
export function queryFailureText(error: unknown, locale: Locale): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ErrorRegistry.has(code)) {
    const params = (error as { params?: Readonly<Record<string, string | number>> }).params ?? {};
    return `${ErrorRegistry.get(code, locale, params)?.message ?? code} [${code}]`;
  }
  return t('terminal.admin.queryFailed', {}, locale);
}

/** One part of a multi-part answer: a failed or unwired query is named and says it was not read; an earlier value is never shown in its place. */
export async function part(label: string, locale: Locale, read: (() => Promise<readonly string[]>) | null): Promise<readonly string[]> {
  if (!read) return [t('terminal.admin.partUnavailable', { part: label }, locale)];
  try { return await read(); }
  catch (error) { return [t('terminal.admin.partFailed', { part: label, reason: queryFailureText(error, locale) }, locale)]; }
}

/** Like `part`, but the value stays typed: a read that failed or is not wired comes back as the line that names it (`note`), never as a value. */
export async function attempt<T>(label: string, locale: Locale, read: (() => Promise<T>) | null): Promise<Readonly<{ value: T }> | Readonly<{ note: string }>> {
  if (!read) return { note: t('terminal.admin.partUnavailable', { part: label }, locale) };
  try { return { value: await read() }; }
  catch (error) { return { note: t('terminal.admin.partFailed', { part: label, reason: queryFailureText(error, locale) }, locale) }; }
}
