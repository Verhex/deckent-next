import { span, type Span, type SpanStyle } from './spans.js';
import type { HumanTextProjector } from './human-text.js';

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

export function parseInline(text: string, style: SpanStyle = {}, project?: HumanTextProjector): Span[] {
  const out: Span[] = [];
  let last = 0;
  const append = (value: string, context: 'prose' | 'exact', nextStyle = style) => {
    if (value !== '') out.push(...(project ? project(value, context, nextStyle) : [span(value, nextStyle)]));
  };
  const plain = (value: string) => append(value, 'prose');
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, , code, bold, underBold, strike, italic, underItalic, label, url] = match;
    if (code !== undefined) append(code, 'exact', { ...style, role: 'code' });
    else if (bold !== undefined || underBold !== undefined) out.push(...parseInline((bold ?? underBold)!, { ...style, bold: true }, project));
    else if (strike !== undefined) out.push(...parseInline(strike, { ...style, strike: true }, project));
    else if (italic !== undefined || underItalic !== undefined) out.push(...parseInline((italic ?? underItalic)!, { ...style, italic: true }, project));
    else if (label !== undefined && url !== undefined) {
      append(label, label === url ? 'exact' : 'prose', { ...style, role: 'link' });
      if (label !== url) {
        if (!project) out.push(span(` (${url})`, { ...style, role: 'muted' }));
        else { append(' (', 'prose', { ...style, role: 'muted' }); append(url, 'exact', { ...style, role: 'muted' }); append(')', 'prose', { ...style, role: 'muted' }); }
      }
    }
  }
  plain(text.slice(last));
  return out;
}
