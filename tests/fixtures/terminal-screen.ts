import { cells, graphemes } from '#surfaces/core/terminal-render/index.js';
/* eslint-disable no-control-regex -- This fixture interprets actual VT control bytes from a PTY. */

/** Replay the VT subset emitted by Ink into a terminal buffer (including scrollback).
 * Unknown controls fail visibly: stripping ANSI or deduplicating strings would hide real duplicate rows.
 * This fixture uses the PTY's dimensions; LF, CR, delayed wrapping, cursor movement and erasure all matter.
 */
export function terminalScreen(output: string, columns: number, rows = 40): string {
  return terminalBuffers(output, columns, rows).text;
}

/** The replay with both screens: `text` is what the terminal shows now (the alternate screen while it is active, else the main screen with
 * its scrollback); `main` is the main screen and its scrollback; `alternate` reports whether the alternate screen (DEC 1049) is active. */
export function terminalBuffers(output: string, columns: number, rows = 40): Readonly<{ text: string; main: string; alternate: boolean }> {
  let lines: string[][] = Array.from({ length: rows }, () => []);
  const history: string[] = [];
  let x = 0, y = 0, saved: Readonly<{ lines: string[][]; x: number; y: number }> | null = null;
  const lineFeed = () => {
    y++;
    // The alternate screen has no scrollback: a line scrolled off its top is gone.
    if (y === rows) { const gone = lines.shift()!.join('').trimEnd(); if (!saved) history.push(gone); lines.push([]); y--; }
  };
  const eraseLine = (mode: number) => {
    if (mode === 0) lines[y]!.splice(x);
    else if (mode === 1) for (let i = 0; i <= Math.min(x, columns - 1); i++) lines[y]![i] = ' ';
    else if (mode === 2) lines[y] = [];
    else throw new Error(`VT_ERASE_LINE:${mode}`);
  };
  const control = (parameters: string, command: string) => {
    const numbers = parameters.split(';').map(value => Number(value || 0)), n = numbers[0] || 1;
    // Ink's presentation-only controls: color, cursor visibility, synchronized output, keyboard protocol, mouse reporting (1000/1002/1006).
    // DEC 1049: save the cursor and switch to a cleared alternate screen; `l` restores the main screen and the cursor.
    if (parameters === '?1049' && command === 'h') { if (!saved) { saved = { lines, x, y }; lines = Array.from({ length: rows }, () => []); } return; }
    if (parameters === '?1049' && command === 'l') { if (saved) { ({ lines, x, y } = saved); saved = null; } return; }
    if (command === 'm' || (['h', 'l'].includes(command) && ['?25', '?1000', '?1002', '?1006', '?2004', '?2026'].includes(parameters))
      || (command === 'u' && /^[><=?][\d;]*$/u.test(parameters))) return;
    if (command === 'A') y = Math.max(0, y - n);
    else if (command === 'B') y = Math.min(rows - 1, y + n);
    else if (command === 'C') x = Math.min(columns - 1, x + n);
    else if (command === 'D') x = Math.max(0, x - n);
    else if (command === 'E') { y = Math.min(rows - 1, y + n); x = 0; }
    else if (command === 'F') { y = Math.max(0, y - n); x = 0; }
    else if (command === 'G') x = Math.min(columns - 1, n - 1);
    else if (command === 'H' || command === 'f') {
      y = Math.min(rows - 1, n - 1); x = Math.min(columns - 1, (numbers[1] || 1) - 1);
    } else if (command === 'K') eraseLine(numbers[0]!);
    else if (command === 'J') {
      const mode = numbers[0]!;
      if (mode === 0) { eraseLine(0); for (let i = y + 1; i < rows; i++) lines[i] = []; }
      else if (mode === 1) { eraseLine(1); for (let i = 0; i < y; i++) lines[i] = []; }
      else if (mode === 2) for (let i = 0; i < rows; i++) lines[i] = [];
      else if (mode === 3) history.length = 0; // ED 3 drops the main screen's scrollback from either screen
      else throw new Error(`VT_ERASE_DISPLAY:${mode}`);
    } else throw new Error(`VT_UNSUPPORTED_CSI:${parameters}${command}`);
  };
  for (let offset = 0; offset < output.length;) {
    const rest = output.slice(offset), char = rest[0]!;
    if (char === '\u001b') {
      const csi = /^\u001b\[([\x30-\x3f]*)([\x40-\x7e])/u.exec(rest);
      if (csi) { control(csi[1]!, csi[2]!); offset += csi[0].length; continue; }
      const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/u.exec(rest);
      if (osc) { offset += osc[0].length; continue; }
      throw new Error(`VT_UNSUPPORTED_ESCAPE:${JSON.stringify(rest.slice(0, 20))}`);
    }
    if (char === '\r') x = 0;
    else if (char === '\n') lineFeed();
    else if (char === '\b') x = Math.max(0, x - 1);
    else if (char === '\t') x = Math.min(columns - 1, (Math.floor(x / 8) + 1) * 8);
    else if (char !== '\u0007') {
      const text = /^[^\u0000-\u001f\u007f]+/u.exec(rest)?.[0];
      if (!text) throw new Error(`VT_UNSUPPORTED_CONTROL:${char.charCodeAt(0)}`);
      for (const cluster of graphemes(text)) {
        const width = cells(cluster);
        if (width === 0) continue;
        if (x + width > columns) { x = 0; lineFeed(); }
        while (lines[y]!.length < x) lines[y]!.push(' ');
        lines[y]![x++] = cluster;
        if (width === 2) lines[y]![x++] = '';
      }
      offset += text.length; continue;
    }
    offset++;
  }
  const screen = (rowsOf: string[][]) => rowsOf.map(line => line.join('').trimEnd());
  const main = [...history, ...screen(saved ? saved.lines : lines)].join('\n').trimEnd();
  return { text: saved ? screen(lines).join('\n').trimEnd() : main, main, alternate: saved !== null };
}
