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

/** `@path` under the caret: the `@` starts a word (emails and `@@` never match) and the caret is inside that word. */
export function mentionAt(text: string, cursor: number): MentionToken | null {
  for (let index = cursor - 1; index >= 0; index--) {
    const char = text[index]!;
    if (char === '@') {
      if ((index > 0 && !/\s/u.test(text[index - 1]!)) || text[index + 1] === '@') return null;
      return { start: index, query: text.slice(index + 1, cursor) };
    }
    if (/\s/u.test(char)) return null;
  }
  return null;
}

/**
 * The `@path` mentions of a submitted draft, in order and without repeats. Chip spans are blanked first: an `@name` inside pasted
 * content is text, not a request to attach a file. Trailing sentence punctuation is not part of a path.
 */
export function mentionPaths(text: string, pastes: readonly PasteChip[] = []): readonly string[] {
  let visible = text;
  for (const span of chipSpans(text, pastes).reverse()) visible = visible.slice(0, span.start) + ' '.repeat(span.end - span.start) + visible.slice(span.end);
  const paths = [...visible.matchAll(/(?:^|\s)@([^\s@]\S*)/gu)].map(match => match[1]!.replace(/[.,;:!?)\]}'"`]+$/u, '')).filter(path => path.length > 0);
  return [...new Set(paths)];
}

/** Completion candidates for a mention; the composer never reads the filesystem itself. */
export type ComposerMentionPort = (query: string, signal: AbortSignal) => Promise<readonly string[]>;
