/**
 * NATIVE-BAGLAM item 3: a model served without a reasoning parser (for example vLLM without `--reasoning-parser`, or a template that
 * leaves its thinking inline) writes its thinking into the answer text as a leading `<think>…</think>` block. That block is reasoning,
 * never the answer: it is routed to the reasoning channel (the terminal's thought line) and kept out of the answer and the history.
 * Only a LEADING block counts (optional whitespace first), so an answer that merely mentions the tag is never cut. Provider reasoning
 * fields (`reasoning`, `reasoning_content`, Anthropic thinking blocks, Responses reasoning summaries) are separated by the adapters already.
 *
 * The streamed split and the settled split agree: every text the router emitted is a prefix of `splitInlineReasoning` of the whole text,
 * and `finish` emits exactly the rest. Text that could still become an opening or closing tag is held until it is decided (at most the tag
 * length), so nothing shown is ever taken back.
 */
const OPEN = '<think>', CLOSE = '</think>';
export type InlineReasoningDelta = { readonly kind: 'text' | 'reasoning'; readonly text: string };

/** The settled split of a whole answer text. Without a leading block the text is unchanged; an unclosed block is all reasoning. */
export function splitInlineReasoning(text: string): { readonly content: string; readonly reasoning: string } {
  const lead = text.length - text.trimStart().length;
  if (!text.startsWith(OPEN, lead)) return { content: text, reasoning: '' };
  const end = text.indexOf(CLOSE, lead + OPEN.length);
  if (end < 0) return { content: '', reasoning: text.slice(lead + OPEN.length) };
  return { content: text.slice(end + CLOSE.length).trimStart(), reasoning: text.slice(lead + OPEN.length, end) };
}

/** Longest suffix of `text` that is a proper prefix of `tag` (the part that may still complete the tag). */
function heldTail(text: string, tag: string): number {
  for (let size = Math.min(tag.length - 1, text.length); size > 0; size--) if (tag.startsWith(text.slice(text.length - size))) return size;
  return 0;
}

/** One round's streaming router. `push` takes each text delta; `finish` flushes what was held once the round's text is complete. */
export function createInlineReasoningRouter() {
  let raw = '', state: 'undecided' | 'text' | 'thinking' | 'after' = 'undecided', shownContent = 0, shownReasoning = 0, scanned = 0;
  const emit = (target: { content: string; reasoning: string }): InlineReasoningDelta[] => {
    const out: InlineReasoningDelta[] = [];
    if (target.reasoning.length > shownReasoning) { out.push({ kind: 'reasoning', text: target.reasoning.slice(shownReasoning) }); shownReasoning = target.reasoning.length; }
    if (target.content.length > shownContent) { out.push({ kind: 'text', text: target.content.slice(shownContent) }); shownContent = target.content.length; }
    return out;
  };
  return {
    push(text: string): InlineReasoningDelta[] {
      if (!text) return [];
      // Decided text (no leading block, or the answer after the block has started) grows verbatim.
      if (state === 'text' || (state === 'after' && shownContent > 0)) { shownContent += text.length; raw += text; return [{ kind: 'text', text }]; }
      raw += text;
      const lead = raw.length - raw.trimStart().length, rest = raw.slice(lead);
      if (state === 'undecided') {
        if (rest.length < OPEN.length && OPEN.startsWith(rest)) return [];
        if (!rest.startsWith(OPEN)) { state = 'text'; return emit({ content: raw, reasoning: '' }); }
        state = 'thinking'; scanned = lead + OPEN.length;
      }
      const start = lead + OPEN.length;
      if (state === 'thinking') {
        const end = raw.indexOf(CLOSE, Math.max(start, scanned - CLOSE.length));
        if (end < 0) { scanned = raw.length; const body = raw.slice(start); return emit({ content: '', reasoning: body.slice(0, body.length - heldTail(body, CLOSE)) }); }
        state = 'after';
      }
      return emit(splitInlineReasoning(raw));
    },
    /** The rest of the settled split (held tag prefixes, an unclosed block's tail); the round's text is complete when this is called. */
    finish(): InlineReasoningDelta[] { return emit(splitInlineReasoning(raw)); },
  };
}
