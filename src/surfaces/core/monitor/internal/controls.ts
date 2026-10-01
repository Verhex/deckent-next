import type { MonitorBlock, MonitorRow, MonitorSortKey } from './layout.js';

/**
 * The fullscreen view's own controls over the one view model (k9s/agent-view style, observe-only): `/` filter, `s`/`S` sort, `g` grouping and
 * the one-refresh change marks. Pure functions: the same blocks in, narrowed/reordered blocks out; the snapshot is never touched.
 */
export type MonitorGroup = 'install' | 'state';
export interface MonitorControls {
  readonly filter: string;
  readonly sort: { readonly key: MonitorSortKey; readonly reverse: boolean } | null;
  readonly group: MonitorGroup | null;
}
export const NO_CONTROLS: MonitorControls = { filter: '', sort: null, group: null };
export const SORT_CYCLE: readonly (MonitorSortKey | null)[] = [null, 'age', 'state', 'name'];
export const GROUP_CYCLE: readonly (MonitorGroup | null)[] = [null, 'install', 'state'];
const FACET = { s: 'state', i: 'install', t: 'kind', r: 'run' } as const;

/** Space-separated terms, all must hold. `!term` inverts; `s:` `i:` `t:` `r:` match the row's typed facets, anything else its visible text. */
export function rowMatches(row: MonitorRow, filter: string): boolean {
  const text = row.cells.map(cell => cell.text).join(' ').toLowerCase();
  return filter.trim().toLowerCase().split(/\s+/).filter(Boolean).every(term => {
    const invert = term.startsWith('!'), body = invert ? term.slice(1) : term;
    if (!body) return true;
    const prefixed = /^([sitr]):(.*)$/.exec(body);
    const hit = prefixed ? (row.facets?.[FACET[prefixed[1] as keyof typeof FACET]] ?? '').includes(prefixed[2]!) : text.includes(body);
    return invert ? !hit : hit;
  });
}

function compare(a: MonitorRow, b: MonitorRow, key: MonitorSortKey): number {
  if (key === 'name') return (a.sort?.name ?? '').localeCompare(b.sort?.name ?? '');
  // Missing values sort last either way; age is newest first, state worst first.
  const left = key === 'age' ? a.sort?.age : a.sort?.state, right = key === 'age' ? b.sort?.age : b.sort?.state;
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
  if (right === undefined || right === null) return -1;
  return key === 'age' ? right - left : left - right;
}

export interface ControlLabels { readonly noMatch: string; readonly arrows: { readonly down: string; readonly up: string } }
/** Applies the controls to every table of one tab; grouping only where it means something (Runs, Workers). */
export function applyControls(blocks: readonly MonitorBlock[], controls: MonitorControls, groupable: boolean, marks: ReadonlyMap<string, string>,
  labels: ControlLabels): MonitorBlock[] {
  return blocks.map((block): MonitorBlock => {
    if (block.kind !== 'table') return block;
    let rows = controls.filter ? block.rows.filter(row => rowMatches(row, controls.filter)) : [...block.rows];
    const sort = controls.sort;
    if (sort) rows = rows.map((row, index) => ({ row, index })).sort((a, b) => (sort.reverse ? -1 : 1) * compare(a.row, b.row, sort.key) || a.index - b.index).map(entry => entry.row);
    const group = groupable ? controls.group : null;
    const label = (row: MonitorRow) => group === 'install' ? row.facets?.install ?? '—' : row.facets?.stateLabel ?? '—';
    if (group) { const order = [...new Set(rows.map(label))]; rows = order.flatMap(name => rows.filter(row => label(row) === name)); }
    rows = rows.map(row => marks.has(row.key) ? { ...row, mark: marks.get(row.key)! } : row);
    const columns = sort ? block.columns.map(column => column.sortKey === sort.key
      ? { ...column, header: `${column.header} ${sort.reverse ? labels.arrows.up : labels.arrows.down}` } : column) : block.columns;
    return { ...block, columns, rows, ...(controls.filter && block.rows.length && !rows.length ? { empty: labels.noMatch } : {}), ...(group ? { group: label } : {}) };
  });
}

/** Row key → signature over every table of every tab (rows repeated on two tabs carry the same signature). */
export function signatures(tabs: Readonly<Record<string, readonly MonitorBlock[]>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const blocks of Object.values(tabs)) for (const block of blocks) if (block.kind === 'table') for (const row of block.rows) if (row.signature !== undefined) out.set(row.key, row.signature);
  return out;
}
/** `+ ` new, `* ` changed since the previous snapshot; nothing on the first snapshot (no baseline, no noise). */
export function changeMarks(previous: ReadonlyMap<string, string> | null, current: ReadonlyMap<string, string>, glyphs: { readonly added: string; readonly changed: string }): Map<string, string> {
  const out = new Map<string, string>();
  if (!previous) return out;
  for (const [key, signature] of current) {
    if (!previous.has(key)) out.set(key, `${glyphs.added} `); else if (previous.get(key) !== signature) out.set(key, `${glyphs.changed} `);
  }
  return out;
}
