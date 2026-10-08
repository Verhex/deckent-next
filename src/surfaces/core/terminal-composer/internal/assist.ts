/** Paste chips, slash completion and `@` mention tokens for the composer. Pure data helpers; no I/O. */
import { WORKLINE_SLASH_COMMANDS, type SlashCommand } from '#surfaces/core/terminal-kit/index.js';

/** Collapse thresholds (legacy terminal-workline composer defaults): above either one a paste becomes a chip. */
export const PASTE_COLLAPSE = Object.freeze({ maxLines: 3, maxChars: 512 });
export type PastePolicy = Readonly<{ maxLines: number; maxChars: number }>;

/** A collapsed paste: the draft shows `chip`, the submitted text carries `body`. */
export interface PasteChip {
  readonly chip: string;
  readonly body: string;
}

/** CRLF/CR become LF; other C0 controls and DEL are dropped (no escape injection into the draft). */
export function cleanText(text: string): string {
  return [...text.replace(/\r\n?/g, '\n')].filter(char => char === '\n' || char === '\t' || (char >= ' ' && char !== '\u007f')).join('');
}

export function shouldCollapse(text: string, policy: PastePolicy): boolean {
  return text.split('\n').length > policy.maxLines || text.length > policy.maxChars;
}

/** Chip text from the catalog template (`{lines}`); a repeated size gets a ` (#n)` suffix so every chip stays unique. */
export function chipFor(template: string, body: string, used: readonly PasteChip[]): string {
  const chip = template.replace('{lines}', String(body.split('\n').length));
  let candidate = chip;
  for (let index = 2; used.some(paste => paste.chip === candidate); index++) candidate = `${chip} (#${index})`;
  return candidate;
}

/** Intact chip spans in the draft, in text order. A chip the user broke by editing is no longer a span. */
export function chipSpans(text: string, pastes: readonly PasteChip[]): Array<{ start: number; end: number }> {
  return pastes.flatMap(paste => {
    const start = text.indexOf(paste.chip);
    return start < 0 ? [] : [{ start, end: start + paste.chip.length }];
  }).sort((left, right) => left.start - right.start);
}

/** Submitted text: every intact chip expands to its body; the draft (and history) keep the chip. */
export function expandChips(text: string, pastes: readonly PasteChip[]): string {
  return [...pastes].sort((left, right) => right.chip.length - left.chip.length)
    .reduce((wire, paste) => wire.split(paste.chip).join(paste.body), text);
}

/** True when every character of `query` occurs in `text` in order (case already folded by the caller). */
export function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at);
    if (at < 0) return false;
    at += char.length;
  }
  return true;
}

/** Popup candidates while the draft is a bare `/prefix` (no whitespace yet): prefix matches first, then fuzzy (subsequence) ones. */
export function slashMatches(text: string, commands: readonly SlashCommand[] = WORKLINE_SLASH_COMMANDS): readonly SlashCommand[] {
  if (!/^\/\S*$/u.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  const prefix = commands.filter(command => command.name.startsWith(query));
  return [...prefix, ...commands.filter(command => !prefix.includes(command) && isSubsequence(query, command.name))];
}

/** The palette row form of a command: no argument hint, because the terminal palette takes no typed arguments (the registry keeps `argumentKey` for line mode and the CLI). */
export function paletteCommand(command: SlashCommand): SlashCommand {
  return { name: command.name, descriptionKey: command.descriptionKey, ...(command.group ? { group: command.group } : {}) };
}

/** The command whose argument is being typed: `/run ` with nothing after it shows the argument hint. */
export function pendingArgument(text: string, commands: readonly SlashCommand[] = WORKLINE_SLASH_COMMANDS): SlashCommand | null {
  const match = /^\/(\S+) $/u.exec(text);
  return commands.find(command => command.name === match?.[1]?.toLowerCase() && command.argumentKey !== undefined) ?? null;
}

export interface MentionToken {
  /** Offset of the `@`. */
  readonly start: number;
  readonly query: string;
}

/**
 * One mention in draft text. Syntax (Astra 2134 R3): an `@` at the start of the text or after whitespace, not followed by another
 * `@` (`@@` and emails never match). `@"path"` runs to the closing quote and keeps every character in between; `\"` and `\\` are
 * its only escapes. A bare `@path` runs to whitespace and drops trailing sentence punctuation. An unclosed `@"` is read as a bare
 * mention (`open` marks it) and never swallows the mentions after it.
 */
interface MentionSpan {
  readonly start: number;
  /** End of the written token: after the closing quote, or after the bare word. */
  readonly end: number;
  readonly path: string;
  readonly quoted: boolean;
  /** An unclosed `@"`: while typing, everything after the quote up to the caret is the query. */
  readonly open: boolean;
}

const QUOTED = /@"((?:[^"\\]|\\[\s\S])*)"/uy;
const BARE = /@(\S*)/uy;
const SENTENCE_END = /[.,;:!?)\]}'"`]+$/u;
const unquote = (body: string) => body.replace(/\\(["\\])/gu, '$1');

function scanMentions(text: string): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (let index = text.indexOf('@'); index >= 0; index = text.indexOf('@', Math.max(index + 1, spans.at(-1)?.end ?? 0))) {
    if ((index > 0 && !/\s/u.test(text[index - 1]!)) || text[index + 1] === '@') continue;
    QUOTED.lastIndex = index;
    const quoted = text[index + 1] === '"' ? QUOTED.exec(text) : null;
    if (quoted) { spans.push({ start: index, end: index + quoted[0].length, path: unquote(quoted[1]!), quoted: true, open: false }); continue; }
    BARE.lastIndex = index;
    const word = BARE.exec(text)![1]!;
    spans.push({ start: index, end: index + 1 + word.length, path: word.replace(SENTENCE_END, ''), quoted: false, open: text[index + 1] === '"' });
  }
  return spans;
}

/** The mention under the caret: the latest one whose written token (or unclosed quote) holds the caret. */
export function mentionAt(text: string, cursor: number): MentionToken | null {
  let found: MentionSpan | null = null;
  for (const span of scanMentions(text)) {
    if (span.start >= cursor) break;
    const inside = span.quoted ? cursor >= span.start + 2 && cursor < span.end : span.open ? cursor >= span.start + 2 : cursor <= span.end;
    if (inside) found = span;
  }
  if (!found) return null;
  return { start: found.start, query: found.quoted || found.open ? unquote(text.slice(found.start + 2, cursor)) : text.slice(found.start + 1, cursor) };
}

/** End of the closed `@"..."` that holds the caret, if any: a completion there replaces the whole quoted token. */
export function quotedMentionEnd(text: string, cursor: number): number | null {
  const span = scanMentions(text).find(item => item.quoted && item.start + 2 <= cursor && cursor < item.end);
  return span ? span.end : null;
}

/** How the picker writes a path: bare when the bare form reads back as exactly this path, otherwise quoted with `"` and `\` escaped. */
export function mentionText(path: string): string {
  const bare = `@${path}`;
  const spans = path.startsWith('"') ? [] : scanMentions(bare);
  return spans.length === 1 && spans[0]!.path === path && spans[0]!.end === bare.length ? bare : `@"${path.replace(/["\\]/gu, '\\$&')}"`;
}

/**
 * The `@path` mentions of a submitted draft, in order and without repeats. Chip spans are blanked first and a quoted mention that
 * reaches into a chip is dropped: an `@name` inside pasted content is text, not a request to attach a file.
 */
export function mentionPaths(text: string, pastes: readonly PasteChip[] = []): readonly string[] {
  const chips = chipSpans(text, pastes);
  let visible = text;
  for (const span of [...chips].reverse()) visible = visible.slice(0, span.start) + ' '.repeat(span.end - span.start) + visible.slice(span.end);
  const paths = scanMentions(visible)
    .filter(span => span.path.length > 0 && !chips.some(chip => span.start < chip.end && chip.start < span.end))
    .map(span => span.path);
  return [...new Set(paths)];
}

/** Completion candidates for a mention; the composer never reads the filesystem itself. */
export type ComposerMentionPort = (query: string, signal: AbortSignal) => Promise<readonly string[]>;
