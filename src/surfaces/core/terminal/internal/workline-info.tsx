import { useCallback, useRef, useState } from 'react';
import { SLASH_GROUPS, SLASH_HELP_TITLE_KEY, WORKLINE_SLASH_COMMANDS, type SlashCommand } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import { InfoWindow, type ContextInfoLabels, type InfoSurfaceLabels, type InfoView, type InfoViewCommand, type InfoViewInput, type InfoViewPorts,
  type InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { systemSummaryEntry, type LocalExecution } from '#surfaces/core/terminal-work/index.js';

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

/**
 * The open information window of the workline (SW-1). `show` holds the slash command until the window closes (queued lines wait, like a settings
 * window), follows a picked choice into the next view, and leaves exactly one system summary line when it closes. It answers the picked id
 * of a view without a follow-up (`/help`), in which case the command it opens leaves its own summary instead.
 */
export function useInfoWindow(host: Readonly<{ info: WorklineInfo | undefined; push: (entries: readonly WorkLedgerEntry[]) => void; errorText: (error: unknown) => string;
  slash: Readonly<Record<string, string>>; ascii: boolean; context: (labels: ContextInfoLabels, ascii: boolean) => InfoWindowModel; input: () => InfoViewInput }>) {
  const { info, push } = host;
  const [open, setOpen] = useState<Readonly<{ view: InfoView; generation: number; done: (choice: string | null) => void }> | null>(null);
  const generation = useRef(0);
  const show = useCallback((first: InfoView, signal: AbortSignal): Promise<string | null> => new Promise(resolve => {
    let view = first, settled = false;
    const finish = (choice: string | null, summary: boolean) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', aborted); setOpen(null);
      if (summary && view.model.summary) push([systemSummaryEntry(view.model.summary)]);
      resolve(choice);
    };
    const aborted = () => finish(null, false);
    const present = () => setOpen({ view, generation: ++generation.current, done: choice => {
      if (choice === null || !view.pick) { finish(choice, choice === null); return; }
      void view.pick(choice).then(next => {
        if (settled) return;
        if (!next) { finish(null, true); return; }
        view = next; present();
      }, () => finish(null, true));
    } });
    if (signal.aborted) { resolve(null); return; }
    signal.addEventListener('abort', aborted, { once: true });
    present();
  }), [push]);
  const latest = useRef(host);
  latest.current = host;
  /** `handled: false` when no port answers the command here (the text path answers it); `picked` is `/help`'s chosen command. */
  const run = useCallback(async (command: string, execution: LocalExecution): Promise<Readonly<{ handled: boolean; picked: string | null }>> => {
    const current = latest.current, labels = current.info!.labels, name = command === 'chat-backend' ? 'status' : command;
    let view: InfoView;
    try {
      if (name === 'help') view = { model: helpInfoModel(current.slash, labels) };
      else if (name === 'context') view = { model: current.context(labels.context, current.ascii) };
      else {
        const port = current.info!.ports[name as InfoViewCommand];
        if (!port) return { handled: false, picked: null };
        view = await port(current.input());
      }
    } catch (error) { current.push([notice('error', current.errorText(error))]); return { handled: true, picked: null }; }
    if (execution.signal.aborted) return { handled: true, picked: null };
    const picked = await show(view, execution.signal);
    return { handled: true, picked: name === 'help' && !execution.signal.aborted ? picked : null };
  }, [show]);
  const element = open && info ? <InfoWindow key={open.generation} model={open.view.model} labels={info.labels} onClose={open.done} /> : null;
  return { run, element, isOpen: open !== null };
}
