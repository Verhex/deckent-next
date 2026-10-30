/**
 * Composer view: the single input owner of the workline. Keys go through the pure reducer; this component only
 * renders the draft and turns intents into the callbacks the workline owns (submit, cancel, exit).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { slashCommandRow, useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { cleanText, mentionText, paletteCommand, type ComposerMentionPort, type PastePolicy } from './assist.js';
import { composerKey } from './keys.js';
import { COMPOSER_LIMITS, composerMenu, EMPTY_COMPOSER, exitArmed, reduceComposer, searchMatches, type ComposerHistoryEntry, type ComposerHistoryPort, type ComposerKey, type ComposerMenu } from './reducer.js';
import { caretRow, displayWidth, graphemes, layoutRows } from './text.js';

export interface ComposerLabels {
  /** Paste chip template with `{lines}`. */
  readonly pasteChip: string;
  readonly search: string;
  readonly exitArmed: string;
  /** Keyboard help: first line is the title, one shortcut per following line. */
  readonly shortcuts: string;
  /** Dim hint after the caret while the draft is empty; never part of the draft. */
  readonly placeholder?: string;
  /** Shown while a draft is put aside with Ctrl+S and the composer is empty (how to bring it back). */
  readonly stashed?: string;
  /** Slash description and argument texts by catalog key (`SlashCommand.descriptionKey` / `argumentKey`). */
  readonly slash: Readonly<Record<string, string>>;
}

export interface ComposerProps {
  readonly prompt: string;
  readonly labels: ComposerLabels;
  readonly busy: boolean;
  /** False while another component owns the keyboard (e.g. an open decision card); keys and pastes are then not consumed. */
  readonly active?: boolean;
  /** Immediate focus guard for keys arriving in the same chunk as a window focus switch. */
  readonly acceptsInput?: () => boolean;
  /** Total visible rows, including the frame. The full draft remains editable behind this caret-following viewport. */
  readonly maxRows?: number | undefined;
  /** `mentions`: the draft's `@path` tokens outside paste chips (attached by the owner through the service, never read here). */
  /** `entry`: the draft as typed (chips unexpanded), before `historyText`. */
  readonly onSubmit: (text: string, mentions: readonly string[], entry: ComposerHistoryEntry) => void;
  readonly onCancel: () => void;
  readonly onExit: () => void;
  /** Persistent history; load/append failures never block input (history is a convenience, not a submit precondition). */
  readonly history?: ComposerHistoryPort;
  /** What a submitted line is remembered as (in-memory recall and `history`); the owner strips what must never be kept (SLASH-WINDOWS I-1:
   *  a rich terminal keeps only `/command`, never a typed slash argument). The submitted text itself is unchanged. */
  readonly historyText?: (text: string) => string;
  /** A line sent for the person outside the composer (a new `seq` each time): kept in recall and `history` like a submitted one. */
  readonly remember?: Readonly<{ seq: number; entry: ComposerHistoryEntry }> | null;
  /** A sent line the owner gives back as the draft (a new `seq` each time), e.g. a message that waits for a model to be connected. */
  readonly restore?: Readonly<{ seq: number; entry: ComposerHistoryEntry }> | null;
  readonly mentions?: ComposerMentionPort;
  /** T3 (Alt+Up on an empty draft): the owner takes its last queued message out of the queue and returns it, or null when none is left. */
  readonly onWithdraw?: () => ComposerHistoryEntry | null;
  /** T4 (Ctrl+G): the owner opens the text in the person's editor; the edited text replaces the draft, null keeps it. One editor at a time. */
  readonly onEditor?: (text: string) => Promise<string | null>;
  /** Quiet time after the last key before `mentions` is asked (default 60 ms); earlier lookups are aborted. */
  readonly mentionDelayMs?: number;
  /** 'marker' draws `|` before the caret for terminals where inverse video is suppressed (no colour tier). */
  readonly caret?: 'inverse' | 'marker';
  readonly now?: () => number;
  readonly policy?: PastePolicy;
}

const MENU_ROWS = 6;
const MENTION_DELAY_MS = 60;
const ignore = () => undefined;

function CaretRow({ text, at, marker }: { readonly text: string; readonly at: number; readonly marker: boolean }): ReactNode {
  const cluster = graphemes(text.slice(at))[0] ?? '';
  if (marker) return `${text.slice(0, at)}|${text.slice(at)}`;
  return <>{text.slice(0, at)}<Text inverse>{cluster || ' '}</Text>{text.slice(at + cluster.length)}</>;
}

function MenuRows({ menu, labels, limit = MENU_ROWS }: { readonly menu: ComposerMenu; readonly labels: ComposerLabels; readonly limit?: number }): ReactNode {
  const palette = useWorklinePalette();
  const first = Math.max(0, Math.min(menu.selected - limit + 1, menu.items.length - limit));
  const rows = menu.kind === 'slash'
    ? menu.items.map(command => slashCommandRow(paletteCommand(command), labels.slash))
    : menu.items.map(path => ({ name: mentionText(path), detail: '' }));
  const width = Math.max(...rows.map(row => displayWidth(row.name)));
  return (
    <Box flexDirection="column">
      {rows.slice(first, first + limit).map((row, index) => {
        const selected = first + index === menu.selected;
        return (
          <Text key={row.name} wrap="truncate">
            <Text {...(selected ? palette.accent : {})}>{`${selected ? '>' : ' '} ${row.name}${' '.repeat(width - displayWidth(row.name))}`}</Text>
            <Text {...palette.muted}>{row.detail ? `  ${row.detail}` : ''}</Text>
          </Text>
        );
      })}
      {rows.length > first + limit ? <Text {...palette.muted}>{`  +${rows.length - first - limit}`}</Text> : null}
    </Box>
  );
}

export function Composer(props: ComposerProps): ReactNode {
  const { prompt, labels } = props;
  const palette = useWorklinePalette();
  const { columns } = useWindowSize();
  // The state lives in a ref as well: several keys in one input chunk must each see the previous key's result.
  const current = useRef(EMPTY_COMPOSER);
  const [state, setState] = useState(EMPTY_COMPOSER);
  const latest = useRef(props);
  latest.current = props;
  const lookup = useRef<AbortController | null>(null);
  const editing = useRef(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clock = () => (latest.current.now ?? Date.now)();

  const dispatch = useCallback((key: ComposerKey): void => {
    const { busy, policy, onSubmit, onCancel, onExit, history, mentions, historyText, onWithdraw, onEditor } = latest.current;
    const result = reduceComposer(current.current, key, { now: clock(), busy, pasteChip: latest.current.labels.pasteChip, ...(policy ? { policy } : {}),
      ...(onEditor ? { editor: true } : {}) });
    // Exit before any state update: a render scheduled beside unmount can keep the TTY referenced.
    if (result.intents.some(intent => intent.type === 'exit')) { onExit(); return; }
    // The remembered form of a submitted line (recall and persistent history) is the owner's; the in-memory entry is replaced in place.
    const remembered = new Map<object, ComposerHistoryEntry>();
    for (const intent of result.intents) {
      if (intent.type !== 'submit' || !historyText) continue;
      const text = historyText(intent.entry.text);
      if (text !== intent.entry.text) remembered.set(intent.entry, { text, pastes: intent.entry.pastes.filter(paste => text.includes(paste.chip)) });
    }
    const next = remembered.size ? { ...result.state, history: result.state.history.map(entry => remembered.get(entry) ?? entry) } : result.state;
    current.current = next;
    setState(next);
    for (const intent of result.intents) {
      if (intent.type === 'cancel') onCancel();
      else if (intent.type === 'withdraw') { const entry = onWithdraw?.(); if (entry) dispatch({ type: 'restore', entry }); }
      else if (intent.type === 'editor' && onEditor && !editing.current) {
        editing.current = true;
        onEditor(intent.text).then(text => {
          // Editors end the file with a newline; the draft does not keep it.
          if (text !== null) { const body = cleanText(text).replace(/\n+$/u, ''); dispatch({ type: 'restore', entry: { text: body, pastes: [] } }); }
        }, ignore).finally(() => { editing.current = false; });
      }
      else if (intent.type === 'submit') {
        const entry = remembered.get(intent.entry) ?? intent.entry;
        void (async () => history?.append(entry))().catch(ignore);
        // The owner gets the draft as typed (T3 gives it back on Alt+Up); only recall and history keep the remembered form.
        onSubmit(intent.text, intent.mentions, intent.entry);
      } else if (intent.type === 'mention' && mentions) {
        lookup.current?.abort();
        if (lookupTimer.current) clearTimeout(lookupTimer.current);
        const controller = new AbortController();
        lookup.current = controller;
        const ask = () => {
          lookupTimer.current = null;
          mentions(intent.query, controller.signal).then(items => {
            if (!controller.signal.aborted) dispatch({ type: 'mentions', start: intent.start, query: intent.query, items });
          }, ignore);
        };
        const delay = latest.current.mentionDelayMs ?? MENTION_DELAY_MS;
        // The bare `@` (empty query) asks at once: the list of the first files needs no quiet time (TERM-UX-1 a).
        if (delay > 0 && intent.query !== '') lookupTimer.current = setTimeout(ask, delay); else ask();
      }
    }
  }, []);

  useEffect(() => () => { lookup.current?.abort(); if (lookupTimer.current) clearTimeout(lookupTimer.current); }, []);
  useEffect(() => {
    let live = true;
    props.history?.load().then(entries => { if (live) dispatch({ type: 'history', entries }); }, ignore);
    return () => { live = false; };
  }, [dispatch, props.history]);
  const rememberSeq = props.remember?.seq ?? 0;
  useEffect(() => { const remember = latest.current.remember; if (!remember) return; dispatch({ type: 'remember', entry: remember.entry }); void (async () => latest.current.history?.append(remember.entry))().catch(ignore); }, [dispatch, rememberSeq]);
  const restoreSeq = props.restore?.seq ?? 0;
  useEffect(() => { const restore = latest.current.restore; if (restore) dispatch({ type: 'restore', entry: restore.entry }); }, [dispatch, restoreSeq]);
  useEffect(() => {
    if (state.armedAt === null) return;
    const timer = setTimeout(() => dispatch({ type: 'tick' }), COMPOSER_LIMITS.exitWindowMs + 1);
    return () => clearTimeout(timer);
  }, [dispatch, state.armedAt]);
  const active = props.active ?? true;
  useInput((input, key) => {
    if (latest.current.acceptsInput?.() === false) return;
    const mapped = composerKey(input, key);
    if (mapped) dispatch(mapped);
  }, { isActive: active });
  usePaste(text => { if (latest.current.acceptsInput?.() !== false) dispatch({ type: 'paste', text }); }, { isActive: active });

  const marker = (props.caret ?? (Object.keys(palette.accent).length === 0 ? 'marker' : 'inverse')) === 'marker';
  const menu = composerMenu(state);
  const indent = ' '.repeat(displayWidth(prompt));
  // Border (2) and padding (2) plus one cell so the caret after a full row never wraps.
  const rows = layoutRows(state.text.replace(/\t/gu, ' '), (columns || 80) - 5 - displayWidth(prompt));
  const caretAt = caretRow(rows, state.cursor);
  const cap = props.maxRows === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, props.maxRows);
  const framed = cap >= 3, borderRows = framed ? 2 : 0;
  const armed = exitArmed(state, clock()), exitRows = armed && cap > borderRows + 1 ? 1 : 0;
  const visible = Math.min(rows.length, Math.max(1, cap - borderRows - exitRows));
  const first = Math.max(0, Math.min(caretAt - visible + 1, rows.length - visible));
  const auxiliary = Math.max(0, cap - borderRows - visible - exitRows);
  // Dim only in a colour tier: the `none` tier (NO_COLOR) renders the hint as plain text without ANSI codes.
  const placeholder = state.text === '' ? labels.placeholder ?? '' : '';
  const dimmable = Object.keys(palette.accent).length > 0;
  const match = state.search ? searchMatches(state)[state.search.skip]?.text ?? '' : '';
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="column" maxHeight={auxiliary} overflow="hidden" flexShrink={0}>
        {state.shortcuts ? labels.shortcuts.split('\n').map((line, index) => <Text key={index} wrap="truncate" {...(index ? palette.muted : palette.accent)}>{line}</Text>) : null}
        {menu && auxiliary > 0 ? <MenuRows menu={menu} labels={labels} limit={Math.min(MENU_ROWS, auxiliary)} /> : null}
        {state.search ? <Text wrap="truncate">{`${labels.search} '${state.search.query}': ${match.split('\n')[0]}`}</Text> : null}
        {state.stash && !state.text && labels.stashed ? <Text {...palette.muted} wrap="truncate">{labels.stashed}</Text> : null}
      </Box>
      <Box {...(framed ? { borderStyle: 'round' as const, paddingX: 1 } : {})} flexDirection="column" flexShrink={0}>
        {rows.slice(first, first + visible).map((row, offset) => { const index = first + offset; return (
          <Text key={index} wrap="truncate">
            {index ? indent : prompt}
            {index === caretAt ? <CaretRow text={row.text} at={state.cursor - row.start} marker={marker} /> : row.text}
            {placeholder && index === 0 ? <Text {...(dimmable ? { dimColor: true } : {})}>{marker ? ` ${placeholder}` : placeholder}</Text> : null}
          </Text>
        ); })}
      </Box>
      {exitRows ? <Text {...palette.muted} wrap="truncate">{labels.exitArmed}</Text> : null}
    </Box>
  );
}
