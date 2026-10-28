import headless, { type Terminal } from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { BeuserSurfaceError, positive } from './input.js';
/* eslint-disable no-control-regex -- The streaming VT recognizer must match actual protocol control bytes. */
// UTF-8 encoding invariant, not an operator memory policy.
const UTF8_SCALAR_BYTES = Buffer.byteLength('\u{10ffff}', 'utf8');

export interface ScreenSize { readonly columns: number; readonly rows: number; readonly scrollback: number }
export interface RenderedScreen {
  readonly text: string; readonly main: string; readonly scrollback: string; readonly alternate: boolean;
  readonly caret: { readonly x: number; readonly y: number }; readonly columns: number; readonly rows: number;
}
/** A strict streaming recognizer rejects unsupported VT instead of letting xterm silently ignore it. */
class VtGuard {
  private pending = '';
  private utf8Remaining = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  get complete(): boolean { return this.pending === '' && this.utf8Remaining === 0; }
  write(bytes: Uint8Array, limit: number): void {
    let text: string;
    try { text = this.pending + this.decoder.decode(bytes, { stream: true }); }
    catch { throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID'); }
    for (const byte of bytes) {
      if (byte >= 240) this.utf8Remaining = 3;
      else if (byte >= 224) this.utf8Remaining = 2;
      else if (byte >= 192) this.utf8Remaining = 1;
      else if (byte >= 128) this.utf8Remaining--;
    }
    this.pending = '';
    for (let i = 0; i < text.length;) {
      const code = text.charCodeAt(i);
      if (code === 27) {
        const rest = text.slice(i);
        if (rest.length === 1) { this.pending = rest; break; }
        if (rest[1] === '[') {
          const match = /^\x1b\[([\x20-\x3f]*)([\x40-\x7e])/u.exec(rest);
          if (!match) {
            if (/^\x1b\[[\x20-\x3f]*$/u.test(rest)) { this.pending = rest; break; }
            throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
          }
          const [, parameters = '', final = ''] = match;
          const numeric = /^[\d;]*$/u.test(parameters) && parameters.split(';').every(value => Number(value) <= 0x7fffffff);
          const numbers = parameters.split(';').map(Number);
          const erase = final === 'J' ? numbers.length === 1 && [0, 1, 2, 3].includes(numbers[0]!)
            : final === 'K' && numbers.length === 1 && [0, 1, 2].includes(numbers[0]!);
          const regular = numeric && (/^[ABCDEFGHLMPSTX`adef@]$/u.test(final)
            || erase || /^[su]$/u.test(final) && parameters === '');
          const color = final === 'm' && numeric && this.colors(numbers);
          const mode = /^[hl]$/u.test(final) && (parameters === '4' || parameters.startsWith('?')
            && parameters.slice(1).split(';').every(value => /^(?:1|6|7|12|25|47|1047|1048|1049|1000|1002|1004|1006|2004|2026)$/u.test(value)));
          // Ink's keyboard-protocol negotiation is presentation metadata, never input authority.
          const keyboard = final === 'u' && /^[><=?][\d;]*$/u.test(parameters);
          if (!regular && !color && !mode && !keyboard) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
          i += match[0].length;
        } else if (rest[1] === ']') {
          const match = /^\x1b\](0|1|2|8);[^\x00-\x06\x08-\x1f]*(?:\x07|\x1b\\)/u.exec(rest);
          if (!match) {
            if (!/[\x07]/u.test(rest) && !rest.includes('\x1b\\')) { this.pending = rest; break; }
            throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
          }
          i += match[0].length;
        } else if (/^[78DEM=>c]$/u.test(rest[1]!)) i += 2;
        else throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
      } else {
        if (code < 32 && ![0, 7, 8, 9, 10, 11, 12, 13].includes(code) || code >= 127 && code <= 159) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
        i++;
      }
    }
    if (Buffer.byteLength(this.pending) > limit) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
  }
  private colors(parameters: number[]): boolean {
    for (let i = 0; i < parameters.length; i++) {
      const code = parameters[i]!;
      if ([38, 48, 58].includes(code)) {
        const format = parameters[++i], count = format === 5 ? 1 : format === 2 ? 3 : 0;
        if (!count || parameters.length - i - 1 < count) return false;
        for (let c = 0; c < count; c++) if (parameters[++i]! > 255) return false;
      } else if (!(code <= 9 || code >= 21 && code <= 37 || [39, 49, 53, 55, 59].includes(code)
        || code >= 40 && code <= 47 || code >= 90 && code <= 97 || code >= 100 && code <= 107)) return false;
    }
    return true;
  }
  finish(): void {
    try { if (this.pending || this.decoder.decode()) throw new Error(); }
    catch { throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID'); }
  }
}

export class BeuserScreenRenderer {
  private readonly terminal: Terminal;
  private readonly guard = new VtGuard();
  private invalid = false;
  private busy = false;
  constructor(size: ScreenSize, private readonly maxBytes: number) {
    positive(maxBytes); positive(size.columns); positive(size.rows);
    if (!Number.isSafeInteger(size.scrollback) || size.scrollback < 0 || (size.rows + size.scrollback) * size.columns * UTF8_SCALAR_BYTES > maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    this.terminal = new headless.Terminal({ cols: size.columns, rows: size.rows, scrollback: size.scrollback, allowProposedApi: true,
      // Parser diagnostics must never print target bytes (which can contain secrets).
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} }, logLevel: 'off' });
    this.terminal.loadAddon(new unicode11.Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
  }
  get applicationCursor(): boolean { return this.terminal.modes.applicationCursorKeysMode; }
  get complete(): boolean { return this.guard.complete; }
  get dimensions(): { columns: number; rows: number } { return { columns: this.terminal.cols, rows: this.terminal.rows }; }
  async write(bytes: Uint8Array): Promise<void> {
    if (this.invalid) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
    if (this.busy) throw new BeuserSurfaceError('BEUSER_SURFACE_BUSY');
    this.busy = true;
    try {
      if (bytes.byteLength > this.maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
      this.guard.write(bytes, this.maxBytes);
      if (bytes.length) await new Promise<void>(resolve => this.terminal.write(bytes, resolve));
    } catch (error) { this.invalid = true; throw error; }
    finally { this.busy = false; }
  }
  snapshot(): RenderedScreen {
    if (this.busy || this.invalid || !this.guard.complete) throw new BeuserSurfaceError('BEUSER_SURFACE_INVALID');
    const { active, normal } = this.terminal.buffer;
    const lines = (buffer: typeof active, start: number, end: number) => Array.from({ length: end - start },
      (_, offset) => buffer.getLine(start + offset)?.translateToString(true) ?? '').join('\n').trimEnd();
    const result = { text: lines(active, active.baseY, active.baseY + this.terminal.rows), main: lines(normal, 0, normal.length),
      scrollback: lines(normal, 0, normal.baseY), alternate: active.type === 'alternate',
      caret: { x: active.cursorX, y: active.cursorY }, columns: this.terminal.cols, rows: this.terminal.rows };
    if (Buffer.byteLength(JSON.stringify(result)) > this.maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    return result;
  }
  resize(columns: number, rows: number): void {
    positive(columns); positive(rows);
    if ((rows + this.terminal.options.scrollback!) * columns * UTF8_SCALAR_BYTES > this.maxBytes) throw new BeuserSurfaceError('BEUSER_SURFACE_LIMIT');
    this.terminal.resize(columns, rows);
  }
  finish(): void { this.guard.finish(); }
  dispose(): void { this.invalid = true; this.terminal.dispose(); }
}
