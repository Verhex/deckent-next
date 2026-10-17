import { expect, it } from 'vitest';
import { cells, graphemes, wrapCells } from '#surfaces/core/terminal-render/index.js';

// The monitor wraps thousands of lines per snapshot; the incremental wrap must equal the previous line-re-measuring algorithm exactly.
function reference(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (cells(text) <= limit) return [text];
  const lines: string[] = []; let line = '';
  for (const token of text.split(/(\s+)/)) {
    if (token === '') continue;
    if (cells(line + token) <= limit) { line += token; continue; }
    if (line.trim() !== '') lines.push(line.trimEnd());
    line = '';
    if (/^\s+$/.test(token)) continue;
    let chunk = '';
    for (const cluster of graphemes(token)) {
      if (chunk !== '' && cells(chunk + cluster) > limit) { lines.push(chunk); chunk = ''; }
      chunk += cluster;
    }
    line = chunk;
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}
it('wraps exactly like the line-re-measuring algorithm across ASCII, Turkish, wide, emoji, combining and control text', () => {
  const pieces = ['iş', 'görev', 'İzleyici', 'çalışıyor', 'queue-verify-c51d5b2350cafd7f84d2a05bead33c', '漢字テキスト', '👩‍💻', '🇹🇷', 'é', '́x', '️',
    'a‍b', '\t', '  ', ' ', '\n', '\r\n', 'x', '—', '✗', 'readme-clone-note: Aborted (core dumped)'];
  let seed = 7; const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let sample = 0; sample < 300; sample++) {
    const text = Array.from({ length: 1 + next() % 40 }, () => pieces[next() % pieces.length]).join(next() % 3 ? ' ' : '');
    for (const width of [1, 2, 5, 12, 40, 120]) expect(wrapCells(text, width)).toEqual(reference(text, width));
  }
  expect(cells('plain ascii line')).toBe(16); expect(cells('iş')).toBe(2); expect(cells('漢字')).toBe(4); expect(cells('a\tb')).toBe(2);
});
