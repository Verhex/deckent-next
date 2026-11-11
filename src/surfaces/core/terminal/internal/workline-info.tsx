import { currentTiming } from '#platform/index.js';
import { TimingFrameContext, TimingPopulatedFrame } from '#surfaces/core/terminal-kit-ink/index.js';
import { useCallback, useRef, useMemo, useState } from 'react';
import { SLASH_GROUPS, SLASH_HELP_TITLE_KEY, WORKLINE_SLASH_COMMANDS, slashSearchEntries, type SlashCommand } from '#surfaces/core/terminal-kit/index.js';
import { PickerWindow } from '#surfaces/core/terminal-panels/index.js';
import { PICKER_INITIAL, pickerView, projectPickerTree, type PickerLabels, type PickerState } from '#surfaces/core/terminal-picker/index.js';
import { NEUTRAL_PICKER_LABELS } from '#surfaces/core/terminal-session/index.js';
import { projectHumanPickerText, span, fillTemplate, useHumanTextSecrets } from '#surfaces/core/terminal-render-ink/index.js';
import { InfoWindow, type ContextInfoLabels, type InfoSurfaceLabels, type InfoView, type InfoViewCommand, type InfoViewInput, type InfoViewPorts,
  type InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { systemSummaryEntry, type LocalExecution } from '#surfaces/core/terminal-work/index.js';
import type { WindowSlot } from '#surfaces/core/terminal-session/index.js';

/** SW-1: the typed information-window ports and their words (`terminalAdminPorts(...).info`). */
export type WorklineInfo = Readonly<{ ports: InfoViewPorts; labels: InfoSurfaceLabels }>;
/** The bare commands that answer in an information window; `chat-backend` is the hidden alias of `/status`. */
export const INFO_WINDOW_COMMANDS: ReadonlySet<string> = new Set(['help', 'status', 'chat-backend', 'usage', 'doctor', 'scope', 'context']);

/** `/help` as a window: the registry's commands under their group headings, each a row to pick (picking runs it; no typed argument). */
export function helpInfoModel(slash: Readonly<Record<string, string>>, labels: InfoSurfaceLabels, commands: readonly SlashCommand[] = WORKLINE_SLASH_COMMANDS): InfoWindowModel {
  const sections = SLASH_GROUPS.flatMap(group => {
    const members = commands.filter(command => (command.group ?? 'other') === group.id);
    return members.length ? [{ title: slash[group.labelKey] ?? group.id, choices: members.map(command => ({ id: command.name, label: `/${command.name}`,
      ...(slash[command.descriptionKey] ? { detail: slash[command.descriptionKey]! } : {}) })) }] : [];
  });
  return { title: slash[SLASH_HELP_TITLE_KEY] ?? 'Commands', sections: [...sections, { notes: [labels.help.note] }],
    summary: fillTemplate(labels.help.summary, { count: commands.length }) };
}

/** The existing command picker owns filtering/paging; the focused command's group is a heading, never an option. */
function HelpWindow({ slash, labels, picker, query, onClose }: { readonly slash: Readonly<Record<string, string>>; readonly labels: InfoSurfaceLabels;
  readonly picker: PickerLabels; readonly query: string; readonly onClose: (id: string | null) => void }) {
  const known = useHumanTextSecrets();
  const tree = useMemo(() => projectPickerTree({ title: slash[SLASH_HELP_TITLE_KEY] ?? '', items: SLASH_GROUPS.flatMap(group =>
    slashSearchEntries(slash, WORKLINE_SLASH_COMMANDS.filter(command => (command.group ?? 'other') === group.id))) },
  text => projectHumanPickerText(text, known).label), [slash, known]);
  const [state, setState] = useState<PickerState>({ ...PICKER_INITIAL, filter: query });
  const view = pickerView(tree, state);
  const current = WORKLINE_SLASH_COMMANDS.find(command => command.name === view.rows[view.pos]?.id);
  const group = SLASH_GROUPS.find(group => group.id === (current?.group ?? 'other'));
  const heading = current && group ? projectHumanPickerText(slash[group.labelKey] ?? '', known).label : '';
  return <PickerWindow title={[span(tree.title)]} body={[{ spans: [span(heading, { bold: true })] }]} bodyRows={1} tree={tree}
    labels={picker} position={labels.position} initial={{ ...PICKER_INITIAL, filter: query }} onState={setState}
    onResult={result => onClose(result.kind === 'selected' ? result.id : null)} />;
}

/**
 * The information windows of the workline (SW-1), shown in the workline's one window slot. `show` holds the slash command until the window
 * closes (queued lines wait, like a settings window), follows a picked choice into the next view, and leaves exactly one system summary line
 * when it closes. It answers the picked id of a view without a follow-up (`/help`), in which case the command it opens leaves its own summary.
 */
export function useInfoWindow(host: Readonly<{ info: WorklineInfo | undefined; slot: WindowSlot; push: (entries: readonly WorkLedgerEntry[]) => void; errorText: (error: unknown) => string;
  slash: Readonly<Record<string, string>>; picker?: PickerLabels | undefined; ascii: boolean; context: (labels: ContextInfoLabels, ascii: boolean) => InfoWindowModel; input: () => InfoViewInput }>) {
  const { slot, push } = host;
  const show = useCallback(async (first: InfoView, labels: InfoSurfaceLabels, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted) return null;
    const aborted = () => slot.close();
    signal.addEventListener('abort', aborted, { once: true });
    const timing = currentTiming();
    try {
      for (let view = first; ;) {
        const shown = view;
        const choice = await slot.ask(answer => <TimingFrameContext.Provider value={timing}><TimingPopulatedFrame><InfoWindow model={shown.model} labels={labels} onClose={answer} /></TimingPopulatedFrame></TimingFrameContext.Provider>);
        if (signal.aborted) return null;
        if (choice === null || !view.pick) {
          if (choice === null && view.model.summary) push([systemSummaryEntry(view.model.summary)]);
          return choice;
        }
        const next = await view.pick(choice).catch(() => null);
        if (signal.aborted) return null;
        if (!next) { if (view.model.summary) push([systemSummaryEntry(view.model.summary)]); return null; }
        view = next;
      }
    } finally { signal.removeEventListener('abort', aborted); }
  }, [push, slot]);
  const latest = useRef(host);
  latest.current = host;
  /** `handled: false` when no port answers the command here (the text path answers it); `picked` is `/help`'s chosen command. */
  const run = useCallback(async (command: string, execution: LocalExecution, query = ''): Promise<Readonly<{ handled: boolean; picked: string | null }>> => {
    const current = latest.current, labels = current.info!.labels, name = command === 'chat-backend' ? 'status' : command;
    let view: InfoView;
    try {
      if (name === 'help') {
        if (execution.signal.aborted) return { handled: true, picked: null };
        const abort = () => slot.close();
        execution.signal.addEventListener('abort', abort, { once: true });
        try {
          const timing = currentTiming();
          const picked = await slot.ask(answer => <TimingFrameContext.Provider value={timing}><TimingPopulatedFrame><HelpWindow slash={current.slash} labels={labels} picker={current.picker ?? NEUTRAL_PICKER_LABELS} query={query} onClose={answer} /></TimingPopulatedFrame></TimingFrameContext.Provider>);
          if (picked === null && !execution.signal.aborted) push([systemSummaryEntry(fillTemplate(labels.help.summary, { count: WORKLINE_SLASH_COMMANDS.length }))]);
          return { handled: true, picked: execution.signal.aborted ? null : picked };
        } finally { execution.signal.removeEventListener('abort', abort); }
      } else if (name === 'context') view = { model: current.context(labels.context, current.ascii) };
      else {
        const port = current.info!.ports[name as InfoViewCommand];
        if (!port) return { handled: false, picked: null };
        view = await port(current.input());
      }
    } catch (error) { currentTiming()?.fail(); current.push([notice('error', current.errorText(error))]); return { handled: true, picked: null }; }
    if (execution.signal.aborted) return { handled: true, picked: null };
    const picked = await show(view, labels, execution.signal);
    return { handled: true, picked: name === 'help' && !execution.signal.aborted ? picked : null };
  }, [show, slot, push]);
  return { run, show };
}
