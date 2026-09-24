import { span, type Span, type SpanStyle } from './spans.js';

/**
 * Inline markdown → spans (legacy chat-render inline passes as a single scanner): `code`, **bold**, __bold__, *italic*,
 * _italic_, ~~strike~~ and [label](url). Links show the label plus the URL as text, so any terminal can detect it;
 * no OSC 8 bytes are emitted. Unmatched markers stay literal.
 */
const INLINE = new RegExp([
  '(`+)([^`]+?)\\1',
  '\\*\\*(?=\\S)(.+?)\\*\\*',
  '(?<![\\w\\\\])__(?=\\S)(.+?)__(?!\\w)',
  '~~(?=\\S)(.+?)~~',
  '(?<![*\\w])\\*(?=[^*\\s])([^*]+?)\\*(?!\\*)',
  '(?<![\\w\\\\])_(?=[^_\\s])([^_]+?)_(?!\\w)',
  '\\[([^\\]\\n]+)\\]\\(((?:[^()\\s]|\\([^()]*\\))+)(?:\\s+"[^"]*")?\\)',
].join('|'), 'g');

export function parseInline(text: string, style: SpanStyle = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  const plain = (value: string) => { if (value !== '') out.push(span(value, style)); };
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, , code, bold, underBold, strike, italic, underItalic, label, url] = match;
    if (code !== undefined) out.push(span(code, { ...style, role: 'code' }));
    else if (bold !== undefined || underBold !== undefined) out.push(...parseInline((bold ?? underBold)!, { ...style, bold: true }));
    else if (strike !== undefined) out.push(...parseInline(strike, { ...style, strike: true }));
    else if (italic !== undefined || underItalic !== undefined) out.push(...parseInline((italic ?? underItalic)!, { ...style, italic: true }));
    else if (label !== undefined && url !== undefined) {
      out.push(span(label, { ...style, role: 'link' }));
      if (label !== url) out.push(span(` (${url})`, { ...style, role: 'muted' }));
    }
  }
  plain(text.slice(last));
  return out;
}
