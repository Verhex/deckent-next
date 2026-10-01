import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { t, type Locale } from '#platform/index.js';
import type { WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import type { MonitorSnapshot } from '#engine/index.js';
import { clipLine, flattenBlocks, lineText, span, type MonitorFlatLine, type MonitorLine } from './layout.js';
import { clockText, durationText, MONITOR_TABS, tabLabel } from './labels.js';
import { wrapDetail } from './text.js';
import { buildMonitorView, filterSnapshot, type MonitorFilters } from './view.js';

export interface MonitorAppProps {
  /** One observe-only read of the whole snapshot (the CLI's `inspectMonitor`); never called while a previous call is still running. */
  readonly load: () => Promise<MonitorSnapshot>;
  /** `inspection.workers.heartbeatMs`: the next read starts this long after the previous one settled. */
  readonly intervalMs: number;
  readonly locale: Locale; readonly ascii: boolean; readonly palette: WorklineInkPalette;
  readonly filters?: MonitorFilters;
  /** Typed failure → catalog sentence; an unknown failure never echoes transport text. */
  readonly errorText: (error: unknown) => string;
  /** A snapshot to show at once (frame dumps and tests); without it the view opens on a loading line and reads immediately. */
  readonly initial?: MonitorSnapshot;
  readonly now?: () => number;
  /** A fixed screen size (frame dumps); the live view follows the terminal (`useWindowSize`, re-rendered on resize). */
  readonly size?: { readonly columns: number; readonly rows: number };
}
interface Failure { readonly text: string; readonly at: number }

/**
 * The fullscreen monitor (MONITOR-SURFACE, htop/k9s class): a fixed header (installs and builds), a tab bar, one scrollable body and a
 * key hint, refreshed in place every heartbeat. A failed refresh keeps the last good snapshot on screen with a visible warning.
 * Keys: Tab/←→ (or 1–6) tabs, ↑↓/PgUp/PgDn select, Enter details, Esc back, r refresh now, p pause, ? help, q quit.
 */
export function MonitorApp(props: MonitorAppProps) {
  const { load, intervalMs, locale, ascii, palette, filters, errorText } = props;
  const now = props.now ?? Date.now;
  const { exit } = useApp();
  const window = useWindowSize(), { columns, rows } = props.size ?? window;
  const width = Math.max(20, columns || 80), height = Math.max(10, rows || 24), ellipsis = ascii ? '...' : '…';
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(props.initial ?? null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [generation, setGeneration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState(0);
  const [selection, setSelection] = useState<readonly number[]>(MONITOR_TABS.map(() => 0));
  const [detail, setDetail] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const alive = useRef(true), inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { const next = await load(); if (alive.current) { setSnapshot(next); setFailure(null); } }
    catch (error) { if (alive.current) setFailure({ text: errorText(error), at: now() }); }
    finally { inFlight.current = false; if (alive.current) setGeneration(value => value + 1); }
  }, [errorText, load, now]);
  useEffect(() => { alive.current = true; if (!props.initial) void refresh(); return () => { alive.current = false; }; }, []);
  // One timer at a time: it is re-armed only after a read settled (generation) and never while paused.
  useEffect(() => {
    if (paused) return undefined;
    const handle = setTimeout(() => { void refresh(); }, intervalMs);
    return () => clearTimeout(handle);
  }, [generation, intervalMs, paused, refresh]);

  const view = useMemo(() => snapshot ? buildMonitorView(filterSnapshot(snapshot, filters ?? {}), locale, ascii) : null, [ascii, filters, locale, snapshot]);
  const current = MONITOR_TABS[tab]!;
  const flat: MonitorFlatLine[] = useMemo(() => view ? flattenBlocks(view.tabs[current], width, ellipsis) : [], [current, ellipsis, view, width]);
  const items = flat.filter(line => line.item !== undefined);
  const selected = Math.min(selection[tab] ?? 0, Math.max(0, items.length - 1));
  const detailRow = detail === null ? null : flat.find(line => line.row?.key === detail)?.row ?? null;

  const header: MonitorLine[] = view ? view.header.map(line => clipLine(line, width, ellipsis)) : [[span(t('monitor.title', {}, locale), 'strong')]];
  const shownHeader = header.length > 4 ? [...header.slice(0, 3), [span(t('monitor.live.moreInstalls', { count: header.length - 3 }, locale), 'muted')]] : header;
  const status: MonitorLine = failure
    ? [span(`${ascii ? '!' : '⚠'} ${t('monitor.live.refreshFailed', { error: failure.text, age: snapshot ? durationText(failure.at - snapshot.observedAt, locale) : '—' }, locale)}`, 'error')]
    : paused ? [span(t('monitor.live.paused', {}, locale), 'warning')]
      : [span(t('monitor.live.every', { every: durationText(intervalMs, locale), time: snapshot ? clockText(snapshot.observedAt) : '—' }, locale), 'muted')];
  const bodyHeight = Math.max(1, height - shownHeader.length - 4);
  const move = (delta: number) => setSelection(values => values.map((value, index) => index === tab ? Math.max(0, Math.min(items.length - 1, selected + delta)) : value));
  const switchTab = (next: number) => { setTab((next + MONITOR_TABS.length) % MONITOR_TABS.length); setDetail(null); };

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (input === '?') { setHelp(value => !value); return; }
    if (key.escape) { if (help) setHelp(false); else setDetail(null); return; }
    if (help) return;
    if (input === 'r') { void refresh(); return; }
    if (input === 'p') { setPaused(value => !value); return; }
    if ((key.tab && key.shift) || key.leftArrow) { switchTab(tab - 1); return; }
    if (key.tab || key.rightArrow) { switchTab(tab + 1); return; }
    if (/^[1-6]$/.test(input)) { switchTab(Number(input) - 1); return; }
    if (detail !== null) return;
    if (key.upArrow) move(-1); else if (key.downArrow) move(1);
    else if (key.pageUp) move(-bodyHeight); else if (key.pageDown) move(bodyHeight);
    else if (key.home) move(-items.length); else if (key.end) move(items.length);
    else if (key.return) { const row = items[selected]?.row; if (row) setDetail(row.key); }
  });

  let body: MonitorLine[];
  if (help) body = t('monitor.live.help', {}, locale).split('\n').map(text => [span(text)]);
  else if (!view) body = [[span(failure ? '' : t('monitor.live.loading', {}, locale), 'muted')]];
  else if (detail !== null) {
    body = [[span(t('monitor.live.detailBack', {}, locale), 'muted')], ...(detailRow ? wrapDetail(detailRow.detail(), width) : [[span(t('monitor.live.detailGone', {}, locale), 'warning')]])];
  } else {
    const at = Math.max(0, flat.findIndex(line => line.item === selected));
    const max = Math.max(0, flat.length - bodyHeight);
    const offset = Math.min(max, at < bodyHeight - 1 ? 0 : at - bodyHeight + 2);
    const windowed = flat.slice(offset, offset + bodyHeight);
    const below = flat.length - offset - windowed.length;
    const marker = ascii ? '> ' : '› ';
    body = windowed.map(line => line.item === selected && items.length ? [span(marker, 'accent'), ...line.line.map((part, index) => index === 0 ? span(part.text.slice(2), part.role) : part)] : line.line);
    if (below > 0) body[body.length - 1] = [span(t('monitor.live.more', { count: below + 1 }, locale), 'muted')];
  }
  const shown = body.slice(0, bodyHeight).map(line => clipLine(line, width, ellipsis));
  while (shown.length < bodyHeight) shown.push([span('')]);

  const colored = Object.keys(palette.accent).length > 0;
  const tabParts = MONITOR_TABS.map((name, index) => `${index + 1} ${tabLabel(name, locale)}`);
  const full = tabParts.join('  ').length + 2 <= width;
  const tabLine: MonitorLine = MONITOR_TABS.flatMap((_, index) => {
    const active = index === tab, text = full || active ? tabParts[index]! : String(index + 1);
    return [span(index ? ' ' : ''), span(active ? `[${text}]` : ` ${text} `, active ? 'accent' : 'muted')];
  });
  const lines: { line: MonitorLine; selected?: boolean }[] = [...shownHeader.map(line => ({ line })), { line: clipLine(tabLine, width, ellipsis) },
    ...shown.map(line => ({ line, selected: colored && detail === null && !help && line[0]?.text === (ascii ? '> ' : '› ') })),
    { line: clipLine(status, width, ellipsis) }, { line: clipLine([span(t('monitor.live.hint', {}, locale), 'muted')], width, ellipsis) }];
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((entry, index) => (
        <Text key={index} wrap="truncate-end" {...(entry.selected ? { inverse: true } : {})}>
          {lineText(entry.line) ? entry.line.map((part, at) => <Text key={at} {...(part.role ? palette[part.role] : {})}>{part.text}</Text>) : ' '}
        </Text>
      ))}
    </Box>
  );
}
