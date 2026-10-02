import { configMonitorBlocks, type ConfigMonitorInspection } from './config-view.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { t, type Locale } from '#platform/index.js';
import type { WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import type { MonitorSnapshot } from '#engine/index.js';
import { clipLine, flattenBlocks, lineText, span, type MonitorFlatLine, type MonitorLine } from './layout.js';
import { clockText, durationText, MONITOR_TABS, tabLabel } from './labels.js';
import { wrapDetail } from './text.js';
import { buildMonitorView, filterSnapshot, type MonitorFilters } from './view.js';
import { applyControls, changeMarks, GROUP_CYCLE, NO_CONTROLS, signatures, SORT_CYCLE, type MonitorControls } from './controls.js';
import { CHANGE_GLYPHS, legendLines } from './legend.js';

export interface MonitorAppProps {
  /** One observe-only read of the whole snapshot (the CLI's `inspectMonitor`); never called while a previous call is still running. */
  readonly load: () => Promise<MonitorSnapshot>;
  readonly loadConfigView?: () => Promise<ConfigMonitorInspection>;
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
/** The snapshot with the local time it arrived and its change marks against the previous one (shown until the next snapshot). */
interface Received { readonly snapshot: MonitorSnapshot; readonly at: number; readonly marks: ReadonlyMap<string, string>; readonly signatures: ReadonlyMap<string, string> }

/**
 * The fullscreen monitor (MONITOR-SURFACE, htop/k9s class): a fixed header (installs, builds, snapshot age, filter), a tab bar, one scrollable
 * body and a key hint, refreshed in place every heartbeat. A failed refresh keeps the last good snapshot with a visible warning.
 * Keys: Tab/←→ or tab numbers, ↑↓/PgUp/PgDn select, Enter details, Esc back, / filter, s/S sort, g group, r refresh, p pause, ? help, q quit.
 */
export function MonitorApp(props: MonitorAppProps) {
  const { load, intervalMs, locale, ascii, palette, filters, errorText } = props;
  const now = props.now ?? Date.now;
  const tabs = props.loadConfigView ? [...MONITOR_TABS, 'config' as const] : MONITOR_TABS;
  const [configView, setConfigView] = useState<ConfigMonitorInspection | null>(null);
  const { exit } = useApp();
  const window = useWindowSize(), { columns, rows } = props.size ?? window;
  const width = Math.max(20, columns || 80), height = Math.max(10, rows || 24), ellipsis = ascii ? '...' : '…';
  const [received, setReceived] = useState<Received | null>(() => props.initial
    ? { snapshot: props.initial, at: now(), marks: new Map(), signatures: signatures(buildMonitorView(filterSnapshot(props.initial, filters ?? {}), locale, ascii).tabs) } : null);
  const snapshot = received?.snapshot ?? null;
  const [failure, setFailure] = useState<Failure | null>(null);
  const [generation, setGeneration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState(0);
  const [selection, setSelection] = useState<readonly number[]>(tabs.map(() => 0));
  const [detail, setDetail] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [controls, setControls] = useState<MonitorControls>(NO_CONTROLS);
  const [editing, setEditing] = useState(false);
  const [clock, setClock] = useState(() => now());
  const alive = useRef(true), inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [next, inspectedConfig] = await Promise.all([load(), props.loadConfigView?.()]);
      if (alive.current && inspectedConfig) setConfigView(inspectedConfig);
      if (alive.current) {
        const current = signatures(buildMonitorView(filterSnapshot(next, filters ?? {}), locale, ascii).tabs);
        setReceived(previous => ({ snapshot: next, at: now(), signatures: current, marks: changeMarks(previous?.signatures ?? null, current, CHANGE_GLYPHS) }));
        setFailure(null);
      }
    } catch (error) { if (alive.current) setFailure({ text: errorText(error), at: now() }); }
    finally { inFlight.current = false; if (alive.current) { setGeneration(value => value + 1); setClock(now()); } }
  }, [ascii, errorText, filters, load, locale, now, props.loadConfigView]);
  useEffect(() => { alive.current = true; if (!props.initial) void refresh(); return () => { alive.current = false; }; }, []);
  // One read timer at a time: re-armed only after a read settled (generation) and never while paused.
  useEffect(() => {
    if (paused) return undefined;
    const handle = setTimeout(() => { void refresh(); }, intervalMs);
    return () => clearTimeout(handle);
  }, [generation, intervalMs, paused, refresh]);
  // The age indicator ticks once per interval even when reads hang or are paused (no per-second churn).
  useEffect(() => { const handle = setInterval(() => setClock(now()), intervalMs); return () => clearInterval(handle); }, [intervalMs, now]);

  const view = useMemo(() => snapshot ? buildMonitorView(filterSnapshot(snapshot, filters ?? {}), locale, ascii) : null, [ascii, filters, locale, snapshot]);
  const current = tabs[tab]!;
  const blocks = useMemo(() => view ? applyControls(current === 'config' ? configView ? configMonitorBlocks(configView, locale) : [{ kind: 'line' as const, line: [span(t('monitor.live.loading', {}, locale))] }] : view.tabs[current], controls, current === 'runs' || current === 'workers', received?.marks ?? new Map(),
    { noMatch: t('monitor.filter.noMatch', {}, locale), arrows: { down: ascii ? 'v' : '▼', up: ascii ? '^' : '▲' } }) : [], [ascii, configView, controls, current, locale, received, view]);
  const flat: MonitorFlatLine[] = useMemo(() => flattenBlocks(blocks, width, ellipsis), [blocks, ellipsis, width]);
  const items = flat.filter(line => line.item !== undefined);
  const selected = Math.min(selection[tab] ?? 0, Math.max(0, items.length - 1));
  const detailRow = detail === null ? null : flat.find(line => line.row?.key === detail)?.row ?? null;

  // Header: title + snapshot age (neutral when fresh, ⚠ after 2 intervals, ✗ after 5) + the active filter; then one line per install.
  const age = received ? Math.max(0, clock - received.at) : 0, sep = ` ${ascii ? '|' : '·'} `;
  const ageSpans = !received || age <= 2 * intervalMs ? [] : [span(sep),
    span(`${age > 5 * intervalMs ? (ascii ? 'x' : '✗') : (ascii ? '!' : '⚠')} ${t('monitor.live.stale', { age: durationText(age, locale) }, locale)}`, age > 5 * intervalMs ? 'error' : 'warning')];
  const filterSpans = controls.filter ? [span(sep), span(t('monitor.filter.active', { filter: controls.filter }, locale), 'accent')] : [];
  const header: MonitorLine[] = view ? view.header.map((line, index) => clipLine(index ? line : [...line, ...ageSpans, ...filterSpans], width, ellipsis))
    : [[span(t('monitor.title', {}, locale), 'strong')]];
  const shownHeader = header.length > 4 ? [...header.slice(0, 3), [span(t('monitor.live.moreInstalls', { count: header.length - 3 }, locale), 'muted')]] : header;
  const lastRead = received ? clockText(received.at).slice(11) : '—';
  const sortWord = (key: 'age' | 'state' | 'name') => key === 'age' ? t('monitor.sort.age', {}, locale) : key === 'state' ? t('monitor.sort.state', {}, locale) : t('monitor.sort.name', {}, locale);
  const status: MonitorLine = editing ? [span(`/${controls.filter}${ascii ? '_' : '▏'}`, 'accent'), span(`  ${t('monitor.filter.hint', {}, locale)}`, 'muted')]
    : failure ? [span(`${ascii ? '!' : '⚠'} ${t('monitor.live.refreshFailed', { time: lastRead }, locale)}`, 'error')]
      : paused ? [span(t('monitor.live.paused', {}, locale), 'warning')]
        : [span(t('monitor.live.every', { every: durationText(intervalMs, locale), time: snapshot ? clockText(snapshot.observedAt) : '—' }, locale), 'muted'),
          ...(controls.sort ? [span(`  ${t('monitor.sort.active', { key: sortWord(controls.sort.key) }, locale)}`, 'muted')] : []),
          ...(controls.group ? [span(`  ${controls.group === 'install' ? t('monitor.group.install', {}, locale) : t('monitor.group.state', {}, locale)}`, 'muted')] : [])];
  const bodyHeight = Math.max(1, height - shownHeader.length - 4);
  const move = (delta: number) => setSelection(values => values.map((value, index) => index === tab ? Math.max(0, Math.min(items.length - 1, selected + delta)) : value));
  const switchTab = (next: number) => { setTab((next + tabs.length) % tabs.length); setDetail(null); };
  const cycle = <T,>(values: readonly T[], value: T) => values[(values.indexOf(value) + 1) % values.length]!;
  const pointer = ascii ? '>' : '›';

  useInput((input, key) => {
    if (editing) {
      // The filter line owns the keys while it is open: Enter keeps the filter, Esc clears it, Backspace edits; the filter applies as typed.
      if (key.return) setEditing(false);
      else if (key.escape) { setEditing(false); setControls(value => ({ ...value, filter: '' })); }
      else if (key.backspace || key.delete) setControls(value => ({ ...value, filter: value.filter.slice(0, -1) }));
      else if (input && !key.ctrl && !key.meta && !key.tab) setControls(value => ({ ...value, filter: value.filter + input }));
      setSelection(tabs.map(() => 0));
      return;
    }
    if (input === 'q') { exit(); return; }
    if (input === '?') { setHelp(value => !value); return; }
    if (key.escape) { if (help) setHelp(false); else if (detail !== null) setDetail(null); else if (controls.filter) setControls(value => ({ ...value, filter: '' })); return; }
    if (help) return;
    if (input === '/') { setEditing(true); setDetail(null); return; }
    if (input === 'r') { void refresh(); return; }
    if (input === 'p') { setPaused(value => !value); return; }
    if (input === 's') { setControls(value => { const next = cycle(SORT_CYCLE, value.sort?.key ?? null); return { ...value, sort: next ? { key: next, reverse: false } : null }; }); return; }
    if (input === 'S') { setControls(value => ({ ...value, sort: { key: value.sort?.key ?? 'age', reverse: !(value.sort?.reverse ?? false) } })); return; }
    if (input === 'g') { setControls(value => ({ ...value, group: cycle(GROUP_CYCLE, value.group) })); return; }
    if ((key.tab && key.shift) || key.leftArrow) { switchTab(tab - 1); return; }
    if (key.tab || key.rightArrow) { switchTab(tab + 1); return; }
    if (/^[1-9]$/.test(input) && Number(input) <= tabs.length) { switchTab(Number(input) - 1); return; }
    if (detail !== null) return;
    if (key.upArrow) move(-1); else if (key.downArrow) move(1);
    else if (key.pageUp) move(-bodyHeight); else if (key.pageDown) move(bodyHeight);
    else if (key.home) move(-items.length); else if (key.end) move(items.length);
    else if (key.return) { const row = items[selected]?.row; if (row) setDetail(row.key); }
  });

  let body: MonitorLine[];
  if (help) body = legendLines(locale, ascii, Boolean(props.loadConfigView));
  else if (!view) body = [[span(failure ? '' : t('monitor.live.loading', {}, locale), 'muted')]];
  else if (detail !== null) {
    body = [[span(t('monitor.live.detailBack', {}, locale), 'muted')], ...(detailRow ? wrapDetail(detailRow.detail(), width) : [[span(t('monitor.live.detailGone', {}, locale), 'warning')]])];
  } else {
    const at = Math.max(0, flat.findIndex(line => line.item === selected));
    const max = Math.max(0, flat.length - bodyHeight);
    const offset = Math.min(max, at < bodyHeight - 1 ? 0 : at - bodyHeight + 2);
    const windowed = flat.slice(offset, offset + bodyHeight);
    const below = flat.length - offset - windowed.length;
    // The two-cell row prefix becomes pointer + change mark (`›+`, `›*`, `› `): selection never hides a new/changed mark.
    body = windowed.map(line => line.item === selected && items.length
      ? [span(`${pointer}${line.line[0]?.text.trim()[0] ?? ' '}`, 'accent'), ...line.line.slice(1)] : line.line);
    if (below > 0) body[body.length - 1] = [span(t('monitor.live.more', { count: below + 1 }, locale), 'muted')];
  }
  const shown = body.slice(0, bodyHeight).map(line => clipLine(line, width, ellipsis));
  while (shown.length < bodyHeight) shown.push([span('')]);

  const colored = Object.keys(palette.accent).length > 0;
  const tabParts = tabs.map((name, index) => `${index + 1} ${name === 'config' ? t('config.surface.monitorTab', {}, locale) : tabLabel(name, locale)}`);
  const full = tabParts.join('  ').length + 2 <= width;
  const tabLine: MonitorLine = tabs.flatMap((_, index) => {
    const active = index === tab, text = full || active ? tabParts[index]! : String(index + 1);
    return [span(index ? ' ' : ''), span(active ? `[${text}]` : ` ${text} `, active ? 'accent' : 'muted')];
  });
  const lines: { line: MonitorLine; selected?: boolean }[] = [...shownHeader.map(line => ({ line })), { line: clipLine(tabLine, width, ellipsis) },
    ...shown.map(line => ({ line, selected: colored && detail === null && !help && (line[0]?.text.startsWith(pointer) ?? false) })),
    { line: clipLine(status, width, ellipsis) },
    // While reads fail the key hint gives way to the typed reason (one line, the layout height never changes).
    { line: clipLine(failure && !editing ? [span(failure.text, 'error')] : [span(t('monitor.live.hint', {}, locale), 'muted')], width, ellipsis) }];
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
