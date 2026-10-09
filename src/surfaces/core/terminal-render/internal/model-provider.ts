import { span, type Span } from './spans.js';

export type ModelProviderLabel = Readonly<{ model: string; provider: string }>;

/** Style only substrings of the already projected whole text; identity never adds text. */
export function modelProviderSpans(text: string, identity?: ModelProviderLabel): readonly Span[] {
  if (!identity) return [span(text)];
  const phrase = `${identity.model} (${identity.provider})`, result: Span[] = [];
  let offset = 0, at = text.indexOf(phrase);
  while (at >= 0) {
    result.push(span(text.slice(offset, at)), span(identity.model, { role: 'model' }), span(' ('),
      span(identity.provider, { role: 'provider' }), span(')'));
    offset = at + phrase.length; at = text.indexOf(phrase, offset);
  }
  result.push(span(text.slice(offset)));
  return result;
}
