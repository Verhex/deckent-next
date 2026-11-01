import { previewRecordStream, redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';

/** Private invocation content only. Redact the whole message before truncating so a boundary cannot expose a token prefix. */
export function errorDiagnostic(text: string | null, rules: readonly Readonly<{ pattern: string; errorClass: string }>[], known: KnownSecretSnapshot, maxBytes: number): Readonly<{ errorClass: string; errorText: string }> {
  const errorClass = rules.find(rule => text !== null && new RegExp(rule.pattern, 'iu').test(text.slice(0, maxBytes)))?.errorClass ?? 'unclassified';
  let safe = redactForRecord(text ?? '', known);
  safe = safe.replace(/\b(?:Basic|Bearer)\s+\S+/giu, '[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gu, '[REDACTED]')
    .replace(/(?<![\w-])((?:["']?[\w-]*(?:password|passwd|pwd|token|secret|api[_-]?key|private[_-]?key|credentials?)["']?|["']?(?:authorization|cookie)["']?)\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.?)*(?:"|$)|'(?:[^'\\\r\n]|\\.?)*(?:'|$)|[^\s,;}]+)/gimu, '$1[REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu, value => value.replace(/(\/\/)[^/?#]*@/u, '$1[REDACTED]@').replace(/[?#].*$/u, '?[REDACTED]'))
    .replace(/(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+/giu, '[REDACTED]')
    .replace(/[A-Za-z0-9_+/.=-]{24,}/gu, '[REDACTED]');
  safe = previewRecordStream({ held: safe, withheld: false }, known).replace(/\p{Cc}/gu, ' ');
  let errorText = '', bytes = 0;
  for (const char of safe) { bytes += Buffer.byteLength(char, 'utf8'); if (bytes > maxBytes) break; errorText += char; }
  return { errorClass, errorText };
}
