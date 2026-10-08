import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ListPicker, pickerView, PICKER_INITIAL, type PickerLabels, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { usePickerRoom } from '#surfaces/core/terminal-panels/index.js';
import { fillTemplate, span } from '#surfaces/core/terminal-render/index.js';
import type { ScratchView } from '#domain/index.js';
import type { SlashCommand } from '#surfaces/core/terminal-kit/index.js';

/**
 * SLASH-WINDOWS (owner 2026-10-08): the small windows of the session and palette commands (`/reasoning`, `/scratch`, an unknown command).
 * Their presence in `WorklineLabels.windows` is what turns the typed forms off in the rich terminal; without it the commands keep their
 * text form (TERM=dumb, line mode). Every word is catalog text the composition resolved.
 */
export interface SlashWindowLabels {
  readonly picker: PickerLabels;
  /** `{from}`, `{to}`, `{total}` */
  readonly position: string;
  /** Key hints under a list window and under an information window. */
  readonly hints: string; readonly infoHints: string;
  /** I-1: the one-time window note for a slash command typed with an argument (the typed text is never shown). */
  readonly typedArgument: string;
  readonly reasoning: { readonly title: string; readonly thinkingOn: string; readonly thinkingOff: string; readonly previewOn: string; readonly previewOff: string;
    readonly current: string; readonly thinkingOnDetail: string; readonly thinkingOffDetail: string; readonly previewOnDetail: string; readonly previewOffDetail: string;
    /** Status strip words. */
    readonly statusOn: string; readonly statusOnHidden: string; readonly statusOff: string };
  readonly scratch: { readonly title: string; /** `{count}` `{bytes}` `{limit}` */ readonly status: string; readonly folder: string;
    /** `{count}` more files than are listed */ readonly more: string; readonly empty: string; /** `{bytes}` */ readonly fileDetail: string;
    readonly clear: string; readonly clearDetail: string; readonly clearTitle: string; /** `{count}` `{bytes}` `{path}` */ readonly clearBody: string;
    readonly clearPrompt: string; readonly pathTitle: string };
  readonly unknown: { readonly title: string; /** `{command}` */ readonly body: string; readonly closest: string; readonly none: string;
    /** The last row: every command (opens `/help`). */ readonly all: string; readonly allDetail: string };
}

/** Neutral English tests and a missing catalog fall back to; the composition always passes the catalog's words. */
export const NEUTRAL_PICKER_LABELS: PickerLabels = { hintList: '↑↓ choose · Enter select · Esc close', hintFilter: 'Enter select · Esc clear filter', hintScope: 'Enter select · Esc back',
  filter: 'Filter: {query}', noMatches: 'No match', empty: 'Nothing to choose', blocked: 'locked', position: '{from}-{to}/{total}' };

export type SlashPickSpec = Readonly<{
  title: string; status?: string; tree: PickerTree;
  /** Header rows; the focused row's id is passed so a window can show a detail of it. */
  body?: (focused: string | null) => readonly WindowLine[]; bodyRows?: number; hints: string;
  /** A read-only window: no list, Esc, Enter or `q` close it. */
  info?: true;
}>;

function SlashPickWindow({ spec, labels, onAnswer }: { readonly spec: SlashPickSpec; readonly labels: SlashWindowLabels; readonly onAnswer: (id: string | null) => void }): ReactNode {
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const room = usePickerRoom(spec.bodyRows ?? 2);
  const shown = pickerView(spec.tree, state), focused = shown.rows[shown.pos]?.id ?? null;
  const answered = useRef(false);
  const answer = (id: string | null) => { if (answered.current) return; answered.current = true; onAnswer(id); };
  if (spec.info) return <Window title={[span(spec.title)]} body={[...(spec.body?.(null) ?? [])]} hints={spec.hints} position={labels.position} onClose={() => answer(null)}
    onInput={(input, key) => { if (key.return || input === 'q') { answer(null); return true; } return false; }} />;
  return <Window title={[span(spec.title)]} {...(spec.status ? { status: [span(spec.status)] } : {})} body={[...(spec.body?.(focused) ?? [])]} hints={spec.hints}
    position={labels.position} footerRows={room.footerRows} onClose={() => answer(null)} onInput={() => true}
    footer={focusedWindow => <ListPicker tree={spec.tree} labels={labels.picker} active={focusedWindow} initial={state} onState={setState} maxRows={room.rows}
      onResult={result => answer(result.kind === 'selected' ? result.id : null)} />} />;
}

/**
 * SLASH-WINDOWS (integration): the ONE local window host of the workline. A slash command asks it for one window at a time and awaits the
 * answer (null: Esc / cancelled), so the command keeps the input line (queued lines wait) exactly as a panel-controller picker does. The
 * information windows (SW-1) and the list windows (SW-3) both open here; the job, approval, resume and settings windows stay on the panel
 * controller. Every window is a `Window` in the one `WindowStackProvider`, so the stack is the single focus owner and an approval card
 * (controller, modal) hides this slot until it is answered.
 */
export function useWindowSlot() {
  type Open = { readonly id: number; readonly render: (answer: (id: string | null) => void) => ReactNode; readonly settle: (id: string | null) => void };
  const [open, setOpen] = useState<Open | null>(null);
  const pending = useRef<((id: string | null) => void) | null>(null), sequence = useRef(0);
  useEffect(() => () => { pending.current?.(null); pending.current = null; }, []);
  /** Shows `render` until it answers; a newer ask or `close` answers the older one with null first. */
  const ask = useCallback((render: Open['render']) => new Promise<string | null>(resolve => {
    pending.current?.(null);
    const settle = (id: string | null) => { if (pending.current !== settle) return; pending.current = null; setOpen(null); resolve(id); };
    pending.current = settle; setOpen({ id: ++sequence.current, render, settle });
  }), []);
  const close = useCallback(() => { pending.current?.(null); }, []);
  const element = open ? <Fragment key={open.id}>{open.render(open.settle)}</Fragment> : null;
  return { ask, close, element, open: open !== null };
}
export type WindowSlot = ReturnType<typeof useWindowSlot>;

/** A list window of the session and palette commands, shown in the workline's window slot (null without window words). */
export function askSlashWindow(slot: WindowSlot, labels: SlashWindowLabels | undefined, spec: SlashPickSpec): Promise<string | null> {
  return labels ? slot.ask(answer => <SlashPickWindow spec={spec} labels={labels} onAnswer={answer} />) : Promise.resolve(null);
}

const mark = (text: string, current: boolean, label: string) => current ? `${text} · ${label}` : text;

/** `/reasoning`: model thinking on / off and the live preview shown / hidden; the row of each state in force is marked. */
export function reasoningSpec(words: SlashWindowLabels, state: Readonly<{ thinking: boolean; preview: boolean }>): SlashPickSpec {
  const r = words.reasoning;
  return { title: r.title, hints: words.hints, bodyRows: 0, tree: { title: r.title, items: [
    { id: 'thinking-on', label: mark(r.thinkingOn, state.thinking, r.current), detail: r.thinkingOnDetail },
    { id: 'thinking-off', label: mark(r.thinkingOff, !state.thinking, r.current), detail: r.thinkingOffDetail },
    { id: 'preview-on', label: mark(r.previewOn, state.preview, r.current), detail: r.previewOnDetail },
    { id: 'preview-off', label: mark(r.previewOff, !state.preview, r.current), detail: r.previewOffDetail },
  ] } };
}
export type ReasoningChoice = 'thinking-on' | 'thinking-off' | 'preview-on' | 'preview-off';
export function isReasoningChoice(id: string | null): id is ReasoningChoice {
  return id === 'thinking-on' || id === 'thinking-off' || id === 'preview-on' || id === 'preview-off';
}
/** The status strip's reasoning words (always shown, droppable on a narrow terminal). */
export function reasoningStatus(words: SlashWindowLabels | undefined, state: Readonly<{ thinking: boolean; preview: boolean }>): string | undefined {
  if (!words) return undefined;
  return !state.thinking ? words.reasoning.statusOff : state.preview ? words.reasoning.statusOn : words.reasoning.statusOnHidden;
}

export const SCRATCH_LISTED = 20;
/** `/scratch`: the area's files (newest first); Enter on a file names its path, the last row clears the area after a confirmation. */
export function scratchSpec(words: SlashWindowLabels, view: ScratchView): SlashPickSpec {
  const s = words.scratch, shown = view.files.slice(0, SCRATCH_LISTED);
  const files = shown.map((file, index) => ({ id: `file:${index}`, label: file.path, detail: fillTemplate(s.fileDetail, { bytes: file.bytes }) }));
  const more = view.files.length > shown.length ? [{ id: 'more', label: fillTemplate(s.more, { count: view.files.length - shown.length }) }] : [];
  const clear = view.files.length > 0 ? [{ id: 'clear', label: s.clear, detail: s.clearDetail }] : [];
  return { title: s.title, status: fillTemplate(s.status, { count: view.files.length, bytes: view.bytes, limit: view.limits.sessionMaxBytes }), hints: words.hints, bodyRows: 2,
    body: () => [{ label: [span(s.folder, { bold: true })], spans: [span(view.path)], exact: true }, ...(view.files.length ? [] : [{ spans: [span(s.empty)] }])],
    tree: { title: s.title, items: [...files, ...more, ...clear] } };
}

/** A read-only window naming one file's full path (`/scratch`, Enter on a file). */
export function pathSpec(words: SlashWindowLabels, path: string): SlashPickSpec {
  return { title: words.scratch.pathTitle, hints: words.infoHints, info: true, tree: { title: words.scratch.pathTitle, items: [] }, body: () => [{ spans: [span(path)], exact: true }] };
}

/**
 * The unknown-command window: the commands closest to what was typed (prefix, then subsequence) to pick one, and always a last row with every
 * command (its id `help` opens the `/help` window).
 */
export function unknownCommandSpec(words: SlashWindowLabels, command: string, matches: readonly SlashCommand[], describe: (command: SlashCommand) => string): SlashPickSpec {
  const u = words.unknown;
  const all = matches.some(match => match.name === 'help') ? [] : [{ id: 'help', label: u.all, detail: u.allDetail }];
  return { title: u.title, hints: words.hints, bodyRows: 2,
    body: () => [{ spans: [span(fillTemplate(u.body, { command: `/${command}` }), { bold: true })] }, { spans: [span(matches.length ? u.closest : u.none)] }],
    tree: { title: u.title, items: [...matches.map(match => ({ id: match.name, label: `/${match.name}`, detail: describe(match) })), ...all] } };
}
