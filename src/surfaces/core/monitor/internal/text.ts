import { t, type Locale } from '#platform/index.js';
import { cells, wrapCells } from '#surfaces/core/terminal-render/index.js';
import type { MonitorSnapshot } from '#engine/index.js';
import { clipLine, flattenBlocks, lineText, span, type MonitorBlock, type MonitorLine } from './layout.js';
import { MONITOR_TABS, tabLabel } from './labels.js';
import { buildMonitorView, filterSnapshot, type MonitorFilters } from './view.js';

export interface MonitorTextOptions { readonly locale: Locale; readonly width: number; readonly ascii: boolean; readonly filters?: MonitorFilters }

/** Detail lines wrap (a summary or a model line must stay readable whole); table lines are clipped by the layout instead. */
export function wrapDetail(lines: readonly MonitorLine[], width: number): MonitorLine[] {
  return lines.flatMap(line => {
    const text = lineText(line);
    if (!text.length || wrapCells(text, width).length === 1) return [line];
    const role = line.find(part => part.role)?.role;
    return wrapCells(text, width).map(part => [span(part, role)]);
  });
}

/**
 * `deckent monitor --once` and `/monitor`: every section of the fullscreen view as plain lines, deterministic for one snapshot (no
 * colour codes, no cursor control: safe for pipes, CI logs and the terminal ledger). Meaning is carried by text markers.
 */
export function renderMonitorText(snapshot: MonitorSnapshot, options: MonitorTextOptions): string {
  const width = Math.max(20, options.width), ellipsis = options.ascii ? '...' : '…';
  const view = buildMonitorView(filterSnapshot(snapshot, options.filters ?? {}), options.locale, options.ascii);
  const rule = (title: string) => clipLine([span(`${options.ascii ? '==' : '──'} ${title} ${(options.ascii ? '=' : '─').repeat(Math.max(0, width - cells(title) - 4))}`)], width, '');
  const lines: MonitorLine[] = [...view.header.map(line => clipLine(line, width, ellipsis))];
  for (const tab of MONITOR_TABS) {
    lines.push([span('')], rule(tabLabel(tab, options.locale)));
    // Installs answer "which install runs which build": the text snapshot prints each install's full details instead of a cut table row.
    const blocks = tab === 'installs' ? view.tabs[tab].flatMap((block): MonitorBlock[] => block.kind === 'table' && block.rows.length
      ? block.rows.flatMap((row, index) => [...(index ? [{ kind: 'line' as const, line: [span('')] }] : []), ...wrapDetail(row.detail(), width).map((line): MonitorBlock => ({ kind: 'line', line }))])
      : [block]) : tab === 'workers' ? view.tabs[tab].flatMap((block): MonitorBlock[] => block.kind === 'table' && block.rows.length
      ? [block, ...block.rows.filter(row => row.detailInText)
        .flatMap(row => [{ kind: 'line' as const, line: [span('')] }, ...wrapDetail(row.detail(), width).map((line): MonitorBlock => ({ kind: 'line', line }))])] : [block]) : view.tabs[tab];
    lines.push(...flattenBlocks(blocks, width, ellipsis).map(entry => entry.line));
  }
  lines.push([span('')], [span(t('monitor.notice', {}, options.locale))]);
  return wrapDetail(lines, width).map(line => lineText(line).trimEnd()).join('\n');
}
