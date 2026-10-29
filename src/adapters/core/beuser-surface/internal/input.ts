// Type-only: this module also loads in a bare Node ESM context (screen rendering), so it imports no runtime module.
import type { BeuserKeyName } from '#engine/index.js';
export type SurfaceFailure = 'BEUSER_SURFACE_UNAVAILABLE' | 'BEUSER_SURFACE_INVALID' | 'BEUSER_SURFACE_LIMIT'
  | 'BEUSER_SURFACE_BUSY' | 'BEUSER_CAPTURE_BLOCKED' | 'BEUSER_SURFACE_EOF' | 'BEUSER_ACTION_INVALID';
export class BeuserSurfaceError extends Error {
  constructor(readonly code: SurfaceFailure) { super(code); this.name = 'BeuserSurfaceError'; }
}
export function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  return value;
}
/** Text cannot smuggle Enter, escape sequences, bracketed-paste terminators or C1 controls; null refuses it before any input is sent. */
export function literalInput(text: string, maxBytes: number): string | null {
  return !text || /[\p{Cc}\p{Cs}]/u.test(text) || Buffer.byteLength(text) > maxBytes ? null : text;
}
const keys: Readonly<Record<BeuserKeyName, string>> = Object.freeze({ Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+O': '\x0f' });
/** Bytes of one named key or one printable character; null refuses it before any input is sent. */
export function atomicKey(name: string, applicationCursor: boolean): string | null {
  const fixed = Object.hasOwn(keys, name) ? keys[name as BeuserKeyName] : undefined;
  if (fixed) return applicationCursor && /^Arrow/u.test(name) ? fixed.replace('[', 'O') : fixed;
  return [...name].length === 1 && !/[\p{Cc}\p{Cs}]/u.test(name) ? name : null;
}
