import { useRef, useState, type Key as ReactKey } from 'react';
import { Box, Text, useAnimation, useWindowSize, type Key } from 'ink';
import { fillTemplate, span, wrapCells, type Span, useRenderGlyphs } from '#surfaces/core/terminal-render-ink/index.js';
import { ListPicker, LIST_PICKER_EMBEDDED_CHROME_ROWS, PICKER_INITIAL, embeddedPickerPageSize, pickerHints, pickerView, type PickerLabels, type PickerOutcome, type PickerResult,
  type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window, layoutWindowLines, useWindowReserve, WINDOW_RESERVED_ROWS, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import TIMING from './panel-timing.json' with { type: 'json' };

/** The window's frame rows (two borders, the title row, one key-hint row) and its border and padding columns (terminal-window's frame). */
const FRAME_ROWS = 4, FRAME_COLUMNS = 4, FALLBACK_ROWS = 24, FALLBACK_COLUMNS = 80;

/**
 * The fixed geometry of a window that embeds a list (TERM-PANEL, owner 2026-10-19): the list's page and the body rows the window keeps.
 * `footerRows` tells the window that everything below the body is taken, so its body room is exactly `bodyRows` (fewer only on a terminal too
 * short for both); `body` is the row count the body keeps (blank rows fill a shorter one), less the key hints' extra rows on a narrow
 * terminal. Pure: the same terminal and body give the same window height at every level, with or without a filter, a reason or a Loading frame.
 */
export function pickerWindowGeometry(input: Readonly<{ terminalRows: number; reserved: number; bodyRows: number; hintRows: number; minimumBody: number }>):
  Readonly<{ pageSize: number; footerRows: number; body: number }> {
  const available = input.terminalRows - input.reserved - FRAME_ROWS;
  const pageSize = embeddedPickerPageSize(available - input.bodyRows - LIST_PICKER_EMBEDDED_CHROME_ROWS);
  const footerRows = Math.max(pageSize + LIST_PICKER_EMBEDDED_CHROME_ROWS, available - input.bodyRows);
  const body = Math.max(input.minimumBody, available - footerRows - (input.hintRows - 1));
  return { pageSize, footerRows, body };
}

/** FIX8a R26: the Loading word; a load that lasts `loadingElapsedAfterMs` or more adds its live elapsed seconds (registry `panel-timing.json`). */
export function useLoadingText(labels: Readonly<{ loading: string; elapsed: string }>, active: boolean): string {
  const { time } = useAnimation({ interval: TIMING.loadingElapsedTickMs, isActive: active });
  return active && time >= TIMING.loadingElapsedAfterMs ? `${labels.loading} · ${fillTemplate(labels.elapsed, { seconds: Math.floor(time / 1000) })}` : labels.loading;
}

/**
 * A window around one embedded `ListPicker`: one title (the window's, followed by the levels entered: `Title › section › key`), one key-hint
 * row (the list's own words for its stage: list, filter or scope; `listHints` replaces the list's words when the panel's are more exact), a
 * body that keeps its rows (blank ones under the list) and a list of one fixed height, so the closing border stays on its row at every level. `tree: null` is the Loading
 * frame: the same height, the body's first line and Esc close. The list owns the keys; the window never applies a choice. A stage whose
 * Enter confirms or applies an effect (the scope step of any list; every stage of a `confirm` list) is a decision window (owner 108): it
 * arms first and its keys reach the list only through the guarded Window, so typed text followed by Enter chooses nothing.
 */
export function PickerWindow(props: {
  readonly title: readonly Span[];
  readonly status?: readonly Span[];
  readonly body?: readonly WindowLine[];
  /** The body rows the window keeps at every level (a longer body scrolls its window's position row in). */
  readonly bodyRows: number;
  readonly tree: PickerTree | null;
  readonly labels: PickerLabels;
  readonly position: string;
  /** The hints of the list stage without a filter (and of the Loading frame); default the list's own. */
  readonly listHints?: string;
  /** A new key starts the list over at `initial` (a panel that reloads or changes step). */
  readonly pickerKey?: ReactKey;
  readonly initial?: PickerState;
  readonly onState?: (state: PickerState) => void;
  readonly onResult: (result: PickerResult) => void;
  readonly onOutcome?: (outcome: PickerOutcome) => void;
  /** False while the panel is busy: the list takes no keys. Default true. */
  readonly active?: boolean;
  /** The Loading frame's Esc. */
  readonly onClose?: () => void;
  /** PgUp/PgDn scroll the body instead of paging the list (a choice card with a long explanation). Default false. */
  readonly bodyPages?: boolean;
  /** Opt-in filter+Enter navigation for the model/provider lists; never enabled by decision cards. */
  readonly submitFilter?: boolean;
  /** A confirm list (apply / cancel rows): a decision window at every stage, with no filter. Default false. */
  readonly confirm?: boolean;
}) {
  const glyphs = useRenderGlyphs(), size = useWindowSize(), reserve = useWindowReserve();
  const columns = size.columns || FALLBACK_COLUMNS, terminalRows = size.rows || FALLBACK_ROWS;
  const key = props.pickerKey ?? 0, initial = props.initial ?? PICKER_INITIAL;
  const [tracked, setTracked] = useState<Readonly<{ key: ReactKey; state: PickerState }>>({ key, state: initial });
  const state = tracked.key === key ? tracked.state : initial;
  const keys = useRef<((input: string, pressed: Key) => boolean) | null>(null);
  // Another list in the same window (a scope step followed by a confirm list) is a new question: it arms anew, so the Enter that answered
  // the previous step, held or pressed twice, never answers the next one. The same rows under the same title (a tick list redrawn after a
  // tick) are the same question.
  const question = props.tree ? [props.tree.title, ...props.tree.items.map(item => item.id)].join('\n') : null;
  const lists = useRef({ question, count: 0 });
  if (question !== null && lists.current.question !== question) lists.current = { question, count: lists.current.count + (lists.current.question === null ? 0 : 1) };
  const guarded = (at: PickerState) => props.confirm === true || at.stage === 'scope';
  const hints = props.tree ? pickerHints(props.labels, state, props.confirm ? props.labels.hintConfirm ?? props.listHints : props.listHints) : props.listHints ?? props.labels.hintList;
  const width = Math.max(1, columns - FRAME_COLUMNS);
  const geometry = pickerWindowGeometry({ terminalRows, reserved: reserve ?? WINDOW_RESERVED_ROWS, bodyRows: props.bodyRows,
    hintRows: wrapCells(hints, width).length, minimumBody: reserve === undefined ? 3 : 1 });
  // A shorter body leaves its rows blank under the list (the list keeps its place under the body; the closing border keeps its row).
  const body = props.body ?? [];
  const padding = Math.max(0, Math.min(geometry.body, props.bodyRows) - layoutWindowLines(body, width).length);
  const blank = (rows: number) => Array.from({ length: rows }, (_, index) => <Text key={`blank:${index}`}> </Text>);
  const crumbs = props.tree ? pickerView(props.tree, state).crumbs.slice(1) : [];
  const title = crumbs.length ? [...props.title, span(` ${glyphs.ascii ? '>' : '›'} ${crumbs.join(` ${glyphs.ascii ? '>' : '›'} `)}`)] : props.title;
  const footerHeight = geometry.pageSize + LIST_PICKER_EMBEDDED_CHROME_ROWS;
  if (!props.tree) {
    return <Window title={title} {...(props.status ? { status: props.status } : {})} body={body} hints={hints} position={props.position} footerRows={geometry.footerRows}
      {...(props.onClose ? { onClose: props.onClose } : {})}
      footer={() => <Box flexDirection="column">{blank(footerHeight + padding)}</Box>} />;
  }
  const tree = props.tree;
  return <Window decision={guarded(state)} inputRevision={lists.current.count} title={title} {...(props.status ? { status: props.status } : {})} body={body} hints={hints} position={props.position} footerRows={geometry.footerRows}
    onInput={(input, pressed) => {
      if (props.bodyPages && (pressed.pageUp || pressed.pageDown)) return false;
      // A guarded stage: only a key the list acted on is handled, so the Window sees every other letter as typed text.
      return guarded(state) ? (props.active ?? true) && keys.current?.(input, pressed) === true : true;
    }}
    footer={focused => <Box flexDirection="column">
      <ListPicker key={key} guarded={guarded} keys={keys} embedded submitFilter={props.submitFilter ?? false} pageKeys={!props.bodyPages} tree={tree} labels={props.labels} active={focused && (props.active ?? true)} initial={initial}
        maxRows={geometry.pageSize} onState={next => { setTracked({ key, state: next }); props.onState?.(next); }} onResult={props.onResult}
        {...(props.onOutcome ? { onOutcome: props.onOutcome } : {})} />
      {blank(padding)}
    </Box>} />;
}
