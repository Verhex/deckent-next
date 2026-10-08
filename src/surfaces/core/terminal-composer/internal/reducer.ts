/**
 * Composer reducer: one pure transition per normalized key. Side effects leave as intents (submit, cancel, exit,
 * mention lookup) so the view owns no editing rules. Behavior mirrors the legacy repl composer (line-edit,
 * cursor-model, input-history, paste-composer, interrupt-policy, at-ref) without its disk or filesystem access.
 */
import type { SlashCommand } from '#surfaces/core/terminal-kit/index.js';
import { chipFor, chipSpans, cleanText, expandChips, mentionAt, mentionPaths, mentionText, PASTE_COLLAPSE, quotedMentionEnd, shouldCollapse, slashMatches, type PasteChip,
  type PastePolicy } from './assist.js';
import { lineEnd, lineStart, nextBoundary, previousBoundary, snapToCluster, verticalOffset, wordLeft, wordRight } from './text.js';

export const COMPOSER_LIMITS = Object.freeze({ historyEntries: 500, exitWindowMs: 2000 });

export interface ComposerHistoryEntry {
  readonly text: string;
  readonly pastes: readonly PasteChip[];
}

/** Persistence port for submitted drafts; the adapter owns storage, redaction and bounds. */
export interface ComposerHistoryPort {
  load(): Promise<readonly ComposerHistoryEntry[]>;
  append(entry: ComposerHistoryEntry): Promise<void> | void;
}

type Draft = ComposerHistoryEntry & { readonly cursor: number };

export interface ComposerState extends Draft {
  readonly killed: string;
  readonly history: readonly ComposerHistoryEntry[];
  readonly browsing: { readonly index: number; readonly saved: Draft } | null;
  readonly search: { readonly query: string; readonly skip: number; readonly saved: Draft } | null;
  readonly selected: number;
  /** Draft text at which the slash popup was closed with Esc; it reopens once the text changes. */
  readonly dismissed: string | null;
  readonly mentions: { readonly start: number; readonly items: readonly string[] } | null;
  /** Draft text at which the file picker was closed with Esc; it reopens (and looks up again) once the text changes. */
  readonly mentionDismissed: string | null;
  readonly shortcuts: boolean;
  readonly armedAt: number | null;
}

export const EMPTY_COMPOSER: ComposerState = Object.freeze({ text: '', cursor: 0, pastes: [], killed: '', history: [], browsing: null,
  search: null, selected: 0, dismissed: null, mentions: null, mentionDismissed: null, shortcuts: false, armedAt: null });

export type ComposerMove = 'left' | 'right' | 'wordLeft' | 'wordRight' | 'home' | 'end' | 'up' | 'down';
export type ComposerDelete = 'back' | 'forward' | 'wordBack' | 'spaceWordBack' | 'wordForward' | 'toStart' | 'toEnd';

export type ComposerKey =
  | { readonly type: 'text' | 'paste'; readonly text: string }
  | { readonly type: 'submit' | 'newline' | 'tab' | 'escape' | 'interrupt' | 'eof' | 'search' | 'yank' | 'tick' }
  | { readonly type: 'move'; readonly to: ComposerMove }
  | { readonly type: 'delete'; readonly span: ComposerDelete }
  | { readonly type: 'mentions'; readonly start: number; readonly query: string; readonly items: readonly string[] }
  | { readonly type: 'history'; readonly entries: readonly ComposerHistoryEntry[] };

export type ComposerIntent =
  /** `mentions`: the draft's `@path` / `@"path"` mentions outside paste chips, exact paths; the owner attaches them through the service. */
  | { readonly type: 'submit'; readonly text: string; readonly entry: ComposerHistoryEntry; readonly mentions: readonly string[] }
  | { readonly type: 'cancel' | 'exit' }
  | { readonly type: 'mention'; readonly start: number; readonly query: string };

export interface ComposerContext {
  readonly now: number;
  readonly busy: boolean;
  /** Chip template with `{lines}`. */
  readonly pasteChip: string;
  readonly policy?: PastePolicy;
  readonly commands?: readonly SlashCommand[];
}

export interface ComposerStep {
  readonly state: ComposerState;
  readonly intents: readonly ComposerIntent[];
}

const step = (state: ComposerState, ...intents: ComposerIntent[]): ComposerStep => ({ state, intents });
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Replace [from, to) with `insert` and reset completion state. Chip bodies stay until submit, so a killed or cleared
 * chip comes back intact with Ctrl-Y; only chips still intact in the text expand.
 */
function edit(state: ComposerState, from: number, to: number, insert = '', kill = false): ComposerState {
  const text = state.text.slice(0, from) + insert + state.text.slice(to);
  const cursor = snapToCluster(text, from + insert.length);
  // Typing inside the same `@token` keeps the open picker until the new candidates arrive (no flicker per key).
  const mentions = state.mentions && mentionAt(text, cursor)?.start === state.mentions.start ? state.mentions : null;
  return { ...state, text, cursor, selected: 0, dismissed: null, mentions,
    killed: kill && to > from ? state.text.slice(from, to) : state.killed };
}

/** An insert never lands inside a chip: the caret first moves to the chip end. */
function insert(state: ComposerState, text: string): ComposerState {
  const inside = chipSpans(state.text, state.pastes).find(span => state.cursor > span.start && state.cursor < span.end);
  const at = inside ? inside.end : state.cursor;
  return text ? edit(state, at, at, text) : state;
}

function paste(state: ComposerState, raw: string, context: ComposerContext): ComposerState {
  const body = cleanText(raw).replace(/\n+$/u, '');
  if (!shouldCollapse(body, context.policy ?? PASTE_COLLAPSE)) return insert(state, body);
  const chip = chipFor(context.pasteChip, body, state.pastes);
  const before = state.text.slice(0, state.cursor), after = state.text.slice(state.cursor);
  const spaced = `${before && !/\s$/u.test(before) ? ' ' : ''}${chip}${after && !/^\s/u.test(after) ? ' ' : ''}`;
  const next = insert(state, spaced);
  return { ...next, pastes: [...state.pastes, { chip, body }] };
}

function load(state: ComposerState, draft: Draft, browsing: ComposerState['browsing']): ComposerState {
  return { ...state, text: draft.text, pastes: draft.pastes, cursor: draft.cursor, browsing, selected: 0, dismissed: null, mentions: null, mentionDismissed: null };
}

function browse(state: ComposerState, direction: -1 | 1): ComposerState {
  const { history, browsing } = state;
  if (!browsing) {
    if (direction > 0 || history.length === 0) return state;
    const entry = history.at(-1)!;
    return load(state, { ...entry, cursor: entry.text.length }, { index: history.length - 1, saved: state });
  }
  const index = browsing.index + direction;
  if (index >= history.length) return load(state, browsing.saved, null);
  const entry = history[Math.max(0, index)]!;
  return load(state, { ...entry, cursor: entry.text.length }, { ...browsing, index: Math.max(0, index) });
}

function move(state: ComposerState, to: ComposerMove): ComposerState {
  const { text, cursor } = state;
  const spans = chipSpans(text, state.pastes);
  const target = to === 'left' ? spans.find(span => span.end === cursor)?.start ?? previousBoundary(text, cursor)
    : to === 'right' ? spans.find(span => span.start === cursor)?.end ?? nextBoundary(text, cursor)
      : to === 'wordLeft' ? wordLeft(text, cursor) : to === 'wordRight' ? wordRight(text, cursor)
        : to === 'home' ? lineStart(text, cursor) : to === 'end' ? lineEnd(text, cursor)
          : verticalOffset(text, cursor, to === 'up' ? -1 : 1);
  if (target === null) return browse(state, to === 'up' ? -1 : 1);
  return { ...state, cursor: target, mentions: null };
}

function remove(state: ComposerState, span: ComposerDelete): ComposerState {
  const { text, cursor } = state;
  const spans = chipSpans(text, state.pastes);
  if (span === 'back') {
    const chip = spans.find(item => item.end === cursor);
    return edit(state, chip?.start ?? previousBoundary(text, cursor), cursor);
  }
  if (span === 'forward') return edit(state, cursor, spans.find(item => item.start === cursor)?.end ?? nextBoundary(text, cursor));
  if (span === 'wordForward') return edit(state, cursor, wordRight(text, cursor), '', true);
  if (span === 'toEnd') {
    const end = lineEnd(text, cursor);
    return edit(state, cursor, end === cursor && cursor < text.length ? cursor + 1 : end, '', true);
  }
  const from = span === 'toStart' ? lineStart(text, cursor) : wordLeft(text, cursor, span === 'spaceWordBack');
  return edit(state, from, cursor, '', true);
}

function submit(state: ComposerState): ComposerStep {
  const { text, cursor, pastes } = state;
  // A trailing backslash continues the draft on a new line (legacy TERMINAL-TOOLS-009), in every terminal.
  if (cursor === text.length && text.endsWith('\\')) return step(edit(state, cursor - 1, cursor, '\n'));
  if (!text.trim()) return step(state);
  const entry: ComposerHistoryEntry = { text, pastes: pastes.filter(paste => text.includes(paste.chip)) };
  const history = state.history.at(-1)?.text === text ? state.history : [...state.history, entry].slice(-COMPOSER_LIMITS.historyEntries);
  return step({ ...EMPTY_COMPOSER, history, killed: state.killed }, { type: 'submit', text: expandChips(text, pastes).trim(), entry,
    mentions: mentionPaths(text, pastes) });
}

export function searchMatches(state: ComposerState): readonly ComposerHistoryEntry[] {
  const query = fold(state.search?.query ?? '');
  return state.history.filter(entry => fold(entry.text).includes(query)).reverse();
}

function searchKey(state: ComposerState, key: ComposerKey): ComposerStep {
  const search = state.search!;
  const matches = searchMatches(state);
  if (key.type === 'text') return step({ ...state, search: { ...search, query: search.query + cleanText(key.text).replace(/\n/gu, ' '), skip: 0 } });
  if (key.type === 'delete' && key.span === 'back') return step({ ...state, search: { ...search, query: search.query.slice(0, previousBoundary(search.query, search.query.length)), skip: 0 } });
  if (key.type === 'search') return step({ ...state, search: { ...search, skip: Math.min(search.skip + 1, Math.max(0, matches.length - 1)) } });
  if (key.type === 'escape') return step(load({ ...state, search: null }, search.saved, state.browsing));
  if (key.type === 'submit' || key.type === 'tab' || key.type === 'move') {
    const match = matches[search.skip];
    return step(match ? load({ ...state, search: null }, { ...match, cursor: match.text.length }, null) : { ...state, search: null });
  }
  return step(state);
}

/** Ctrl-C: cancel a running turn; otherwise close what is open, clear a draft, or arm exit and exit on a second press. */
function interrupt(state: ComposerState, context: ComposerContext): ComposerStep {
  if (context.busy) return step(state, { type: 'cancel' });
  if (state.search) return step(load({ ...state, search: null }, state.search.saved, state.browsing));
  if (state.shortcuts) return step({ ...state, shortcuts: false });
  if (state.text) return step({ ...EMPTY_COMPOSER, history: state.history, pastes: state.pastes, killed: state.text });
  if (exitArmed(state, context.now)) return step({ ...state, armedAt: null }, { type: 'exit' });
  return step({ ...state, armedAt: context.now });
}

export function exitArmed(state: ComposerState, now: number): boolean {
  return state.armedAt !== null && now - state.armedAt <= COMPOSER_LIMITS.exitWindowMs;
}

export type ComposerMenu =
  | { readonly kind: 'slash'; readonly items: readonly SlashCommand[]; readonly selected: number }
  | { readonly kind: 'mention'; readonly items: readonly string[]; readonly selected: number; readonly start: number };

/** The popup that is open for this state, if any: live slash matches, or mention candidates from the port. */
export function composerMenu(state: ComposerState, commands?: readonly SlashCommand[]): ComposerMenu | null {
  if (state.search) return null;
  const mention = state.mentions;
  if (mention && mentionAt(state.text, state.cursor)?.start === mention.start && mention.items.length > 0) {
    return { kind: 'mention', items: mention.items, selected: state.selected % mention.items.length, start: mention.start };
  }
  const items = state.dismissed === state.text ? [] : slashMatches(state.text, commands);
  return items.length ? { kind: 'slash', items, selected: state.selected % items.length } : null;
}

/**
 * The picked path is written in the form the submit parser reads back as exactly that path (`@"src/a b.ts"` for a spaced name,
 * Astra 2134 R3). Inside a closed `@"..."` the whole token is replaced so no half quote stays behind.
 */
function completeMention(state: ComposerState, start: number, path: string): ComposerState {
  return { ...edit(state, start, quotedMentionEnd(state.text, state.cursor) ?? state.cursor, `${mentionText(path)} `), mentions: null };
}

function menuKey(state: ComposerState, key: ComposerKey, menu: ComposerMenu): ComposerStep | null {
  const count = menu.items.length;
  if (key.type === 'move' && (key.to === 'up' || key.to === 'down')) {
    return step({ ...state, selected: (menu.selected + (key.to === 'up' ? count - 1 : 1)) % count });
  }
  if (key.type === 'escape') return step(menu.kind === 'slash' ? { ...state, dismissed: state.text } : { ...state, mentions: null, mentionDismissed: state.text });
  // A path typed out in full, in the form the submit parser reads back exactly, is already a reference: Enter sends the line
  // (Tab still completes it with a trailing space). `@src/a.ts!` is not that form for `src/a.ts!`, so Enter completes it.
  if (menu.kind === 'mention' && key.type === 'submit' && state.text.slice(menu.start, state.cursor) === mentionText(menu.items[menu.selected]!)) return null;
  if (menu.kind === 'mention' && (key.type === 'tab' || key.type === 'submit')) return step(completeMention(state, menu.start, menu.items[menu.selected]!));
  if (menu.kind === 'slash' && key.type === 'tab') return step(edit(state, 0, state.text.length, `/${menu.items[menu.selected]!.name} `));
  if (menu.kind === 'slash' && key.type === 'submit') return runSlash(state, menu.items[menu.selected]!);
  return null;
}

/**
 * Enter on a palette row (SLASH-WINDOWS, owner 2026-10-08): every command runs at once as `/name` and opens its own window or picker.
 * The palette never completes to `/name ` and waits for typed text, whatever `argumentKey` the registry keeps for line mode and the CLI.
 */
function runSlash(state: ComposerState, command: SlashCommand): ComposerStep {
  if (state.text.toLowerCase() === `/${command.name}`) return submit(state);
  return submit(edit(state, 0, state.text.length, `/${command.name}`));
}

/** Candidates for the token under the caret. Only the latest query counts; a single candidate is offered, never typed for the user. */
function mentionResult(state: ComposerState, key: Extract<ComposerKey, { type: 'mentions' }>): ComposerState {
  const token = mentionAt(state.text, state.cursor);
  if (token?.start !== key.start || token.query !== key.query || state.mentionDismissed === state.text) return state;
  return { ...state, mentions: { start: key.start, items: key.items }, selected: 0 };
}

/** After an edit, the `@token` under the caret is looked up (the view debounces); a picker closed with Esc stays closed for this text. */
function withMentionLookup(result: ComposerStep): ComposerStep {
  const { state } = result;
  if (state.search || result.intents.some(intent => intent.type === 'submit')) return result;
  const token = mentionAt(state.text, state.cursor);
  if (!token || state.mentionDismissed === state.text) return result;
  return { state, intents: [...result.intents, { type: 'mention', ...token }] };
}

function textKey(state: ComposerState, text: string, context: ComposerContext): ComposerStep {
  // Fast typing, a PTY or an unbracketed paste can deliver text and Enter in one chunk. One line plus a trailing
  // Enter submits; a chunk with inner newlines is a paste and never submits by itself.
  const body = text.replace(/[\r\n]+$/u, '');
  if (text.length > 1 && /[\r\n]/u.test(body)) return step(paste(state, text, context));
  if (text.length > 1 && body !== text) {
    // Text and Enter in one chunk take the same palette rule as a separate Enter: the highlighted command, never the bare prefix.
    const typed = insert(state, cleanText(body));
    const menu = composerMenu(typed, context.commands);
    return menu?.kind === 'slash' ? runSlash(typed, menu.items[menu.selected]!) : submit(typed);
  }
  if (text.length > 1 && shouldCollapse(text, context.policy ?? PASTE_COLLAPSE)) return step(paste(state, text, context));
  return step(insert(state, cleanText(text)));
}

export function reduceComposer(state: ComposerState, key: ComposerKey, context: ComposerContext): ComposerStep {
  if (key.type === 'tick') return step(state.armedAt !== null && !exitArmed(state, context.now) ? { ...state, armedAt: null } : state);
  if (key.type === 'history') return step({ ...state, history: [...key.entries, ...state.history].slice(-COMPOSER_LIMITS.historyEntries) });
  if (key.type === 'mentions') return step(mentionResult(state, key));
  if (key.type === 'interrupt') return interrupt(state, context);
  if (state.search) return searchKey(state, key);
  if (state.shortcuts) {
    state = { ...state, shortcuts: false };
    if (key.type === 'escape' || (key.type === 'text' && key.text === '?')) return step(state);
  } else if (key.type === 'text' && key.text === '?' && !state.text) return step({ ...state, shortcuts: true });
  const menu = composerMenu(state, context.commands);
  // While walking history, Up/Down keep walking even when a recalled `/command` opens the popup.
  const walking = state.browsing !== null && key.type === 'move' && (key.to === 'up' || key.to === 'down');
  const handled = menu && !walking && menuKey(state, key, menu);
  if (handled) return handled;
  switch (key.type) {
    case 'text': return withMentionLookup(textKey(state, key.text, context));
    case 'paste': return step(paste(state, key.text, context));
    case 'submit': return submit(state);
    case 'newline': return step(insert(state, '\n'));
    case 'move': return step(move(state, key.to));
    case 'delete': return withMentionLookup(step(remove(state, key.span)));
    case 'yank': return withMentionLookup(step(insert(state, state.killed)));
    case 'search': return step({ ...state, search: { query: '', skip: 0, saved: state } });
    case 'escape':
      if (context.busy) return step(state, { type: 'cancel' });
      // Esc before the candidates arrived also closes the picker: a late answer must not open it.
      return step(mentionAt(state.text, state.cursor) ? { ...state, mentions: null, mentionDismissed: state.text } : state);
    case 'eof':
      if (state.text) return step(remove(state, 'forward'));
      return context.busy ? step(state) : step(state, { type: 'exit' });
    case 'tab': {
      const token = mentionAt(state.text, state.cursor);
      return token ? step(state, { type: 'mention', ...token }) : step(state);
    }
  }
}
