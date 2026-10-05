import { redactForRecord } from '#platform/core/redaction/index.js';

/** Compatibility entry: the canonical B7 record producer. */
export function redactSensitive(value: string): string { return redactForRecord(value); }
