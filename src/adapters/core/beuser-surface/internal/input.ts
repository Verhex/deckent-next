export type SurfaceFailure = 'BEUSER_SURFACE_UNAVAILABLE' | 'BEUSER_SURFACE_INVALID' | 'BEUSER_SURFACE_LIMIT'
  | 'BEUSER_SURFACE_BUSY' | 'BEUSER_CAPTURE_BLOCKED' | 'BEUSER_SURFACE_EOF';
export class BeuserSurfaceError extends Error {
  constructor(readonly code: SurfaceFailure) { super(code); this.name = 'BeuserSurfaceError'; }
}
export function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  return value;
}
export function literalInput(text: string, maxBytes: number): string {
  // Text cannot smuggle Enter, escape sequences, bracketed-paste terminators or C1 controls.
  if (!text || /[\p{Cc}\p{Cs}]/u.test(text) || Buffer.byteLength(text) > maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
  return text;
}
const keys: Readonly<Record<string, string>> = Object.freeze({ Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+O': '\x0f' });
export function atomicKey(key: string, applicationCursor: boolean): string {
  const fixed = keys[key];
  if (fixed) return applicationCursor && /^Arrow/u.test(key) ? fixed.replace('[', 'O') : fixed;
  if ([...key].length === 1 && !/[\p{Cc}\p{Cs}]/u.test(key)) return key;
  throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
}
