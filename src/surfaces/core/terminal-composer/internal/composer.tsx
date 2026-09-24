/**
 * Composer view: the single input owner of the workline. Keys go through the pure reducer; this component only
 * renders the draft and turns intents into the callbacks the workline owns (submit, cancel, exit).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { pendingArgument, type ComposerMentionPort, type PastePolicy } from './assist.js';
import { composerKey } from './keys.js';
import { COMPOSER_LIMITS, composerMenu, EMPTY_COMPOSER, exitArmed, reduceComposer, searchMatches, type ComposerHistoryPort, type ComposerKey, type ComposerMenu } from './reducer.js';
import { caretRow, displayWidth, graphemes, layoutRows } from './text.js';

export interface ComposerLabels {
  /** Paste chip template with `{lines}`. */
  readonly pasteChip: string;
  readonly search: string;
  readonly exitArmed: string;
  /** Keyboard help: first line is the title, one shortcut per following line. */
  readonly shortcuts: string;
  /** Slash description and argument texts by catalog key (`SlashCommand.descriptionKey` / `argumentKey`). */
  readonly slash: Readonly<Record<string, string>>;
}

export interface ComposerProps {
  readonly prompt: string;
  readonly labels: ComposerLabels;
  readonly busy: boolean;
  /** False while another component owns the keyboard (e.g. an open decision card); keys and pastes are then not consumed. */
  readonly active?: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
  readonly onExit: () => void;
  /** Persistent history; load/append failures never block input (history is a convenience, not a submit precondition). */
  readonly history?: ComposerHistoryPort;
  readonly mentions?: ComposerMentionPort;
  /** 'marker' draws `|` before the caret for terminals where inverse video is suppressed (no colour tier). */
  readonly caret?: 'inverse' | 'marker';
  readonly now?: () => number;
  readonly policy?: PastePolicy;
}

const MENU_ROWS = 6;
const ignore = () => undefined;

function CaretRow({ text, at, marker }: { readonly text: string; readonly at: number; readonly marker: boolean }): ReactNode {
  const cluster = graphemes(text.slice(at))[0] ?? '';
  if (marker) return `${text.slice(0, at)}|${text.slice(at)}`;
  return <>{text.slice(0, at)}<Text inverse>{cluster || ' '}</Text>{text.slice(at + cluster.length)}</>;
}

function MenuRows({ menu, labels }: { readonly menu: ComposerMenu; readonly labels: ComposerLabels }): ReactNode {
  const palette = useWorklinePalette();
  const first = Math.max(0, Math.min(menu.selected - MENU_ROWS + 1, menu.items.length - MENU_ROWS));
  const rows = menu.kind === 'slash'
    ? menu.items.map(command => ({ name: `/${command.name}${command.argumentKey ? ` ${labels.slash[command.argumentKey] ?? ''}` : ''}`, detail: labels.slash[command.descriptionKey] ?? '' }))
    : menu.items.map(path => ({ name: `@${path}`, detail: '' }));
  const width = Math.max(...rows.map(row => displayWidth(row.name)));
  return (
    <Box flexDirection="column">
      {rows.slice(first, first + MENU_ROWS).map((row, index) => {
        const selected = first + index === menu.selected;
        return (
          <Text key={row.name} wrap="truncate">
            <Text {...(selected ? palette.accent : {})}>{`${selected ? '>' : ' '} ${row.name}${' '.repeat(width - displayWidth(row.name))}`}</Text>
            <Text {...palette.muted}>{row.detail ? `  ${row.detail}` : ''}</Text>
          </Text>
        );
      })}
      {rows.length > first + MENU_ROWS ? <Text {...palette.muted}>{`  +${rows.length - first - MENU_ROWS}`}</Text> : null}
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
  const clock = () => (latest.current.now ?? Date.now)();

  const dispatch = useCallback((key: ComposerKey): void => {
    const { busy, policy, onSubmit, onCancel, onExit, history, mentions } = latest.current;
    const result = reduceComposer(current.current, key, { now: clock(), busy, pasteChip: latest.current.labels.pasteChip, ...(policy ? { policy } : {}) });
    // Exit before any state update: a render scheduled beside unmount can keep the TTY referenced.
    if (result.intents.some(intent => intent.type === 'exit')) { onExit(); return; }
    current.current = result.state;
    setState(result.state);
    for (const intent of result.intents) {
      if (intent.type === 'cancel') onCancel();
      else if (intent.type === 'submit') {
        void (async () => history?.append(intent.entry))().catch(ignore);
        onSubmit(intent.text);
      } else if (intent.type === 'mention' && mentions) {
        lookup.current?.abort();
        const controller = new AbortController();
        lookup.current = controller;
        mentions(intent.query, controller.signal).then(items => {
          if (!controller.signal.aborted) dispatch({ type: 'mentions', start: intent.start, query: intent.query, items });
        }, ignore);
      }
    }
  }, []);

  useEffect(() => () => lookup.current?.abort(), []);
  useEffect(() => {
    let live = true;
    props.history?.load().then(entries => { if (live) dispatch({ type: 'history', entries }); }, ignore);
    return () => { live = false; };
  }, [dispatch, props.history]);
  useEffect(() => {
    if (state.armedAt === null) return;
    const timer = setTimeout(() => dispatch({ type: 'tick' }), COMPOSER_LIMITS.exitWindowMs + 1);
    return () => clearTimeout(timer);
  }, [dispatch, state.armedAt]);
  const active = props.active ?? true;
  useInput((input, key) => {
    const mapped = composerKey(input, key);
    if (mapped) dispatch(mapped);
  }, { isActive: active });
  usePaste(text => dispatch({ type: 'paste', text }), { isActive: active });

  const marker = (props.caret ?? (Object.keys(palette.accent).length === 0 ? 'marker' : 'inverse')) === 'marker';
  const menu = composerMenu(state);
  const argument = pendingArgument(state.text);
  const indent = ' '.repeat(displayWidth(prompt));
  // Border (2) and padding (2) plus one cell so the caret after a full row never wraps.
  const rows = layoutRows(state.text.replace(/\t/gu, ' '), (columns || 80) - 5 - displayWidth(prompt));
  const caretAt = caretRow(rows, state.cursor);
  const match = state.search ? searchMatches(state)[state.search.skip]?.text ?? '' : '';
  return (
    <Box flexDirection="column">
      {state.shortcuts ? labels.shortcuts.split('\n').map((line, index) => <Text key={index} {...(index ? palette.muted : palette.accent)}>{line}</Text>) : null}
      {menu ? <MenuRows menu={menu} labels={labels} /> : null}
      {state.search ? <Text wrap="truncate">{`${labels.search} '${state.search.query}': ${match.split('\n')[0]}`}</Text> : null}
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        {rows.map((row, index) => (
          <Text key={index} wrap="truncate">
            {index ? indent : prompt}
            {index === caretAt ? <CaretRow text={row.text} at={state.cursor - row.start} marker={marker} /> : row.text}
            {argument && index === rows.length - 1 ? <Text {...palette.muted}>{labels.slash[argument.argumentKey!] ?? ''}</Text> : null}
          </Text>
        ))}
      </Box>
      {exitArmed(state, clock()) ? <Text {...palette.muted}>{labels.exitArmed}</Text> : null}
    </Box>
  );
}
