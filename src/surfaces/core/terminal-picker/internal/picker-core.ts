/**
 * Pure selection core of the terminal pickers (no React, no I/O, no side effects): a filterable, paged, multi-level list
 * (section -> key -> value) with an optional scope step (project / user) and rows that are blocked with a reason (shown, never selectable).
 * The Ink view (`ListPicker`) and the numbered text fallback both drive the same reducer, so what a user can choose never depends
 * on the surface. A result is a typed value; applying it (config write, model switch) stays with the caller's own authority path.
 */

/** A row. `children` makes it a section that opens a lower level; `blocked.reason` is the already localized why (the row shows it). */
export type PickerNode = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Extra words the filter also matches (aliases, ids). */
  keywords?: readonly string[];
  blocked?: Readonly<{ reason: string }>;
  /** An action row of a scoped tree (stage 1: the budget row of `/model`): chosen directly, without the scope step. */
  unscoped?: boolean;
  /** Title of the level below, when this row is a section. */
  childTitle?: string;
  children?: readonly PickerNode[];
}>;

export type PickerScope = Readonly<{ id: string; label: string; blocked?: Readonly<{ reason: string }> }>;

export type PickerTree = Readonly<{
  title: string;
  items: readonly PickerNode[];
  /** When present, choosing a leaf opens the scope step before the result is returned. */
  scopes?: readonly PickerScope[];
}>;

/**
 * Every visible word of a tree through `project` (the host's known-secret / human-text projection), whole, before the picker filters, cuts
 * or wraps it (Astra 2456 P1-2). Ids, scopes' ids and the tree shape stay as they are, so what a pick answers never changes.
 */
export function projectPickerTree(tree: PickerTree, project: (text: string) => string): PickerTree {
  const node = (item: PickerNode): PickerNode => ({ ...item, label: project(item.label), ...(item.detail === undefined ? {} : { detail: project(item.detail) }),
    ...(item.keywords ? { keywords: item.keywords.map(project) } : {}), ...(item.blocked ? { blocked: { reason: project(item.blocked.reason) } } : {}),
    ...(item.childTitle === undefined ? {} : { childTitle: project(item.childTitle) }), ...(item.children ? { children: item.children.map(node) } : {}) });
  return { ...tree, title: project(tree.title), items: tree.items.map(node),
    ...(tree.scopes ? { scopes: tree.scopes.map(scope => ({ ...scope, label: project(scope.label), ...(scope.blocked ? { blocked: { reason: project(scope.blocked.reason) } } : {}) })) } : {}) };
}

export type PickerResult =
  | Readonly<{ kind: 'selected'; /** Ids from the first level down to the chosen leaf. */ path: readonly string[]; id: string; scope?: string }>
  | Readonly<{ kind: 'cancelled' }>;

export type PickerState = Readonly<{
  stage: 'list' | 'scope';
  /** Sections entered so far, with the pos each was left at (Esc restores it). */
  trail: readonly Readonly<{ id: string; pos: number }>[];
  filter: string;
  /** Index into the filtered rows of the current level. */
  pos: number;
  /** Leaf chosen while the scope step is open. */
  pending: string | null;
  scopePos: number;
}>;

export type PickerAction =
  | Readonly<{ type: 'move'; direction: 'up' | 'down' }>
  | Readonly<{ type: 'page'; direction: 'up' | 'down' }>
  | Readonly<{ type: 'edge'; edge: 'first' | 'last' }>
  | Readonly<{ type: 'type'; text: string }>
  | Readonly<{ type: 'backspace' }>
  | Readonly<{ type: 'clearFilter' }>
  | Readonly<{ type: 'scope'; direction: 'previous' | 'next' }>
  | Readonly<{ type: 'enter' }>
  /** Numbered fallback: 0-based index into the rows now shown (list rows, or scopes in the scope step), then Enter. */
  | Readonly<{ type: 'choose'; index: number }>
  | Readonly<{ type: 'escape' }>
  | Readonly<{ type: 'cancel' }>;

/** What a step produced besides the next state. `blocked` carries the reason so the caller can show it; the state does not change. */
export type PickerOutcome =
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ kind: 'blocked'; reason: string }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'done'; result: PickerResult }>;

export type PickerStep = Readonly<{ state: PickerState; outcome: PickerOutcome }>;
export type PickerOptions = Readonly<{ pageSize: number }>;

export const PICKER_INITIAL: PickerState = Object.freeze({ stage: 'list', trail: [], filter: '', pos: 0, pending: null, scopePos: 0 });

const CONTINUE: PickerOutcome = Object.freeze({ kind: 'continue' });

/** Index Enter commits. `count <= 0` has no row; a negative modulo wraps to the end. */
export function pickerChoice(selected: number, count: number): number {
  if (count <= 0) return 0;
  const index = selected % count;
  return index < 0 ? index + count : index;
}

export function movePicker(selected: number, count: number, direction: 'up' | 'down'): number {
  if (count <= 0) return 0;
  return pickerChoice(selected + (direction === 'up' ? -1 : 1), count);
}

/** First visible row so that `index` is inside a window of `size` rows. */
export function pickerFirstRow(index: number, count: number, size: number): number {
  return Math.max(0, Math.min(index - size + 1, count - size));
}

/** The level the trail points at (the root when empty). A trail id that no longer exists falls back to the last level that does. */
export function pickerLevel(tree: PickerTree, trail: PickerState['trail']): Readonly<{ title: string; nodes: readonly PickerNode[]; titles: readonly string[] }> {
  let nodes = tree.items, title = tree.title;
  const titles = [tree.title];
  for (const step of trail) {
    const node = nodes.find(item => item.id === step.id);
    if (!node?.children) break;
    nodes = node.children; title = node.childTitle ?? node.label; titles.push(title);
  }
  return { title, nodes, titles };
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
}

/** Typing filters: every whitespace-separated word must appear in the label, id, detail or a keyword (case and accents folded). */
export function filterPickerNodes(nodes: readonly PickerNode[], query: string): readonly PickerNode[] {
  const words = fold(query.trim()).split(/\s+/u).filter(Boolean);
  if (!words.length) return nodes;
  return nodes.filter(node => {
    const haystack = fold([node.label, node.id, node.detail ?? '', ...(node.keywords ?? [])].join(' '));
    return words.every(word => haystack.includes(word));
  });
}

export type PickerView = Readonly<{
  stage: PickerState['stage'];
  title: string;
  /** Titles from the root to the current level (the breadcrumb). */
  crumbs: readonly string[];
  filter: string;
  /** Rows now shown: the filtered level, or the scopes in the scope step. */
  rows: readonly Readonly<{ id: string; label: string; detail?: string; section: boolean; blocked: string | null }>[];
  pos: number;
  /** Total rows before filtering (to tell "no match" from "nothing"). */
  unfiltered: number;
}>;

export function pickerView(tree: PickerTree, state: PickerState): PickerView {
  const level = pickerLevel(tree, state.trail);
  if (state.stage === 'scope') {
    const scopes = tree.scopes ?? [];
    return { stage: 'scope', title: level.title, crumbs: level.titles, filter: '', unfiltered: scopes.length,
      rows: scopes.map(scope => ({ id: scope.id, label: scope.label, section: false, blocked: scope.blocked?.reason ?? null })),
      pos: pickerChoice(state.scopePos, scopes.length) };
  }
  const nodes = filterPickerNodes(level.nodes, state.filter);
  return { stage: 'list', title: level.title, crumbs: level.titles, filter: state.filter, unfiltered: level.nodes.length,
    rows: nodes.map(node => ({ id: node.id, label: node.label, ...(node.detail !== undefined ? { detail: node.detail } : {}),
      section: Boolean(node.children), blocked: node.blocked?.reason ?? null })),
    pos: pickerChoice(state.pos, nodes.length) };
}

function step(state: PickerState, outcome: PickerOutcome = CONTINUE): PickerStep { return { state, outcome }; }

/** A single transition. No I/O: the caller renders the state and, on `done`, hands the result to its own authority path. */
export function pickerReduce(tree: PickerTree, state: PickerState, action: PickerAction, options: PickerOptions): PickerStep {
  const size = Math.max(1, options.pageSize);
  if (action.type === 'cancel') return step(state, { kind: 'done', result: { kind: 'cancelled' } });
  const view = pickerView(tree, state);
  const count = view.rows.length;
  const scoped = state.stage === 'scope';
  const at = (pos: number): PickerState => scoped ? { ...state, scopePos: pos } : { ...state, pos };
  switch (action.type) {
    case 'move': return step(at(movePicker(view.pos, count, action.direction)));
    case 'page': return step(at(count <= 0 ? 0 : Math.min(count - 1, Math.max(0, view.pos + (action.direction === 'up' ? -1 : 1) * Math.max(1, size - 1)))));
    case 'edge': return step(at(action.edge === 'first' ? 0 : Math.max(0, count - 1)));
    case 'scope': {
      if (!scoped) return step(state);
      return step(at(movePicker(view.pos, count, action.direction === 'previous' ? 'up' : 'down')));
    }
    case 'type': {
      if (scoped) return step(state);
      const text = [...action.text].filter(char => (char.codePointAt(0) ?? 0) > 0x1f && char !== '\u007f').join('');
      return text ? step({ ...state, filter: state.filter + text, pos: 0 }) : step(state);
    }
    case 'backspace': {
      if (scoped || !state.filter) return step(state);
      return step({ ...state, filter: [...state.filter].slice(0, -1).join(''), pos: 0 });
    }
    case 'clearFilter': return state.filter && !scoped ? step({ ...state, filter: '', pos: 0 }) : step(state);
    case 'escape': {
      if (scoped) return step({ ...state, stage: 'list', pending: null });
      if (state.filter) return step({ ...state, filter: '', pos: 0 });
      const last = state.trail[state.trail.length - 1];
      if (last) return step({ ...state, trail: state.trail.slice(0, -1), pos: last.pos });
      return step(state, { kind: 'done', result: { kind: 'cancelled' } });
    }
    case 'choose': {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= count) return step(state, { kind: 'invalid' });
      return pickerReduce(tree, at(action.index), { type: 'enter' }, options);
    }
    case 'enter': {
      const row = view.rows[view.pos];
      if (!row) return step(state, { kind: 'invalid' });
      // A blocked row is shown with its reason and never chosen: no state change, no result.
      if (row.blocked !== null) return step(state, { kind: 'blocked', reason: row.blocked });
      if (scoped) {
        const pending = state.pending;
        if (pending === null) return step({ ...state, stage: 'list' });
        return step(state, { kind: 'done', result: { kind: 'selected', path: [...state.trail.map(item => item.id), pending], id: pending, scope: row.id } });
      }
      if (row.section) return step({ ...state, trail: [...state.trail, { id: row.id, pos: view.pos }], filter: '', pos: 0 });
      const path = [...state.trail.map(item => item.id), row.id];
      if (tree.scopes?.length && !pickerLevel(tree, state.trail).nodes.find(node => node.id === row.id)?.unscoped) {
        const first = tree.scopes.findIndex(scope => !scope.blocked);
        return step({ ...state, stage: 'scope', pending: row.id, scopePos: Math.max(0, first) });
      }
      return step(state, { kind: 'done', result: { kind: 'selected', path, id: row.id } });
    }
  }
}

/** The subset of an Ink key event the picker reads. */
export type PickerKeyEvent = Readonly<{ upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean;
  home?: boolean; end?: boolean; return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }>;

/** Maps one key event to an action, or null when the picker ignores it. Printable text filters; there are no letter shortcuts to steal it. */
export function pickerActionOf(input: string, key: PickerKeyEvent, stage: PickerState['stage']): PickerAction | null {
  if (key.ctrl) return input === 'c' && !key.meta ? { type: 'cancel' } : input === 'u' && stage === 'list' ? { type: 'clearFilter' } : null;
  if (key.meta) return null;
  if (key.escape) return { type: 'escape' };
  if (key.return) return { type: 'enter' };
  if (key.upArrow) return { type: 'move', direction: 'up' };
  if (key.downArrow) return { type: 'move', direction: 'down' };
  if (stage === 'scope') {
    if (key.tab) return { type: 'scope', direction: key.shift ? 'previous' : 'next' };
    if (key.leftArrow) return { type: 'scope', direction: 'previous' };
    if (key.rightArrow) return { type: 'scope', direction: 'next' };
    return null;
  }
  if (key.pageUp) return { type: 'page', direction: 'up' };
  if (key.pageDown) return { type: 'page', direction: 'down' };
  if (key.home) return { type: 'edge', edge: 'first' };
  if (key.end) return { type: 'edge', edge: 'last' };
  if (key.backspace || key.delete) return { type: 'backspace' };
  if (key.tab || key.leftArrow || key.rightArrow) return null;
  return input ? { type: 'type', text: input } : null;
}

/** Plain-text mode: no TTY, or TERM=dumb. Number prompts replace the arrow list; the reducer is the same. */
export function pickerNeedsTextFallback(env: Readonly<Record<string, string | undefined>>, interactive: boolean): boolean {
  return !interactive || env['TERM'] === 'dumb';
}

/** Numbered lines for the current level (or scopes). Blocked rows keep their number but show the reason and cannot be chosen. */
export function pickerNumberedLines(view: PickerView, blockedTag: string): readonly string[] {
  return view.rows.map((row, index) => {
    const note = row.blocked !== null ? ` [${blockedTag}: ${row.blocked}]` : row.section ? ' >' : '';
    return `${index + 1}) ${row.label}${row.detail ? ` - ${row.detail}` : ''}${note}`;
  });
}

/** One typed answer in the numbered mode: a 1-based number, a row id, or empty/`q` to go back one level (cancel at the root). */
export function pickerActionOfAnswer(view: PickerView, answer: string): PickerAction {
  const text = answer.trim();
  if (!text || /^(q|quit|cancel)$/iu.test(text)) return { type: 'escape' };
  if (/^\d+$/u.test(text)) return { type: 'choose', index: Number(text) - 1 };
  const index = view.rows.findIndex(row => row.id === text);
  return index >= 0 ? { type: 'choose', index } : { type: 'choose', index: -1 };
}
