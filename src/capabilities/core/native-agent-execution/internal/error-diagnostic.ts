import { previewRecordStream, redactForDiagnostic, type KnownSecretSnapshot } from '#platform/index.js';

type ErrorRule = Readonly<{ pattern: string; errorClass: string }>;
/** KG8 P11: a registry rule (parsed once, so stable by identity) compiles once, when first tried; non-global, so `.test` keeps no state. */
const compiled = new WeakMap<ErrorRule, RegExp>();
const patternOf = (rule: ErrorRule) => compiled.get(rule) ?? compiled.set(rule, new RegExp(rule.pattern, 'iu')).get(rule)!;
/** Private invocation content only. Redact the whole message before truncating so a boundary cannot expose a token prefix. */
export function errorDiagnostic(text: string | null, rules: readonly ErrorRule[], known: KnownSecretSnapshot, maxBytes: number): Readonly<{ errorClass: string; errorText: string }> {
  const head = text?.slice(0, maxBytes), errorClass = rules.find(rule => head !== undefined && patternOf(rule).test(head))?.errorClass ?? 'unclassified';
  const safe = previewRecordStream({ held: redactForDiagnostic(text ?? '', known), withheld: false }, known).replace(/\p{Cc}/gu, ' ');
  let errorText = '', bytes = 0;
  for (const char of safe) { bytes += Buffer.byteLength(char, 'utf8'); if (bytes > maxBytes) break; errorText += char; }
  return { errorClass, errorText };
}
