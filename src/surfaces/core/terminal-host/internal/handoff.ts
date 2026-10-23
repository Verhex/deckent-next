import { useCallback, useRef } from 'react';
import { useApp } from 'ink';
import type { PanelContext, PanelController } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';

/** T4: why the draft stayed as it was (the adapter's own words; never the command, path or text). */
export type ExternalEditorRefusal = 'no-editor' | 'not-started' | 'exit' | 'too-large' | 'unsafe' | 'failed';
export type ExternalEditorOutcome =
  | Readonly<{ kind: 'edited'; text: string }> | Readonly<{ kind: 'unchanged' }> | Readonly<{ kind: 'refused'; reason: ExternalEditorRefusal }>;
/** The person's `$VISUAL`/`$EDITOR` behind an adapter: this surface spawns no process and writes no file. */
export interface ExternalEditorPort { edit(text: string, signal?: AbortSignal): Promise<ExternalEditorOutcome> }
/** What the host switches off while a child process owns the terminal: its mouse and focus reports (`terminal-host`). */
export interface TerminalHandover { release(): void; reclaim(): void }
export interface DraftHandoffLabels {
  /** `{text}`: the message taken back out of the queue. */
  readonly withdrawn: string;
  readonly editor: Readonly<Record<ExternalEditorRefusal, string>>;
}
type Say = (level: 'info' | 'warning' | 'error', text: string) => void;
export interface DraftHandoffOptions<C extends PanelContext> {
  readonly controller: PanelController<C>;
  readonly say: Say;
  readonly labels?: DraftHandoffLabels | undefined;
  readonly editor?: ExternalEditorPort | undefined;
  readonly handover?: TerminalHandover | undefined;
  /** Holds new conversation rows while the editor owns the screen (a row printed then would be lost) and returns the release. */
  readonly hold?: () => () => void;
}

/**
 * T3 and T4: the composer's draft leaves the terminal and comes back.
 * T3 (Codex Alt+Up): the last message still waiting in the queue is taken out of the FIFO (the controller refuses one that already started) and
 * handed back as the person queued it, paste chips included. The controller exports no text, so the remembered entries live here, bounded by the queue.
 * T4 (Claude Code / Codex Ctrl+G): Ink releases raw mode, bracketed paste and the alternate screen, the host switches mouse and focus reports
 * off, the adapter runs the editor synchronously (this process reads no key meanwhile), SIGINT is ignored while a cooked-mode editor may raise it,
 * and everything is restored on every path before the held rows are printed.
 */
export function useDraftHandoffs<C extends PanelContext, E extends { readonly text: string }>(options: DraftHandoffOptions<C>) {
  const latest = useRef(options);
  latest.current = options;
  const queued = useRef(new Map<string, E>());
  const { suspendTerminal } = useApp();
  const remember = useCallback((inputId: string, entry: E) => {
    const waiting = new Set(latest.current.controller.snapshot().queued.map(item => item.inputId));
    for (const id of queued.current.keys()) if (!waiting.has(id)) queued.current.delete(id);
    if (waiting.has(inputId)) queued.current.set(inputId, entry);
  }, []);
  const withdraw = useCallback((): Readonly<{ inputId: string; entry: E }> | null => {
    const { controller, say, labels } = latest.current, snapshot = controller.snapshot();
    const inputId = [...snapshot.queued].reverse().find(item => queued.current.has(item.inputId))?.inputId;
    if (!inputId || !controller.send({ kind: 'withdraw-queued', context: snapshot.context, inputId })) return null;
    const entry = queued.current.get(inputId)!;
    queued.current.delete(inputId);
    if (labels) say('info', fillTemplate(labels.withdrawn, { text: entry.text.trim() }));
    return { inputId, entry };
  }, []);
  const edit = useCallback(async (text: string): Promise<string | null> => {
    const { editor, handover, hold, say, labels } = latest.current;
    if (!editor) return null;
    const release = hold?.(), ignore = () => undefined;
    let outcome: ExternalEditorOutcome = { kind: 'refused', reason: 'failed' };
    process.on('SIGINT', ignore);
    try {
      await suspendTerminal(async () => {
        handover?.release();
        try { outcome = await editor.edit(text); } finally { handover?.reclaim(); }
      });
    } catch { /* the outcome stays `failed`; the draft is kept */ }
    finally { process.off('SIGINT', ignore); release?.(); }
    const result = outcome as ExternalEditorOutcome;
    if (result.kind === 'refused' && labels) say(result.reason === 'no-editor' ? 'warning' : 'error', labels.editor[result.reason]);
    return result.kind === 'edited' ? result.text : null;
  }, [suspendTerminal]);
  return { remember, withdraw, edit: options.editor ? edit : undefined };
}
