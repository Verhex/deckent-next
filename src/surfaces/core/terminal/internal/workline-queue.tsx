import { useCallback, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { TURN_STEER_LINES, useWorklinePalette, type TurnDelta, type TurnSteer } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { systemSummaryEntry } from '#surfaces/core/terminal-work/index.js';
import type { ComposerHistoryEntry } from '#surfaces/core/terminal-composer/index.js';
import LIMITS from './workline-queue.json' with { type: 'json' };

/** Why the queued lines wait (journey queued-messages): the opening's send gate, a running turn, an open window, or another command. */
export type QueueReason = 'service' | 'turn' | 'window' | 'command';
export type QueueLabels = Readonly<{ service: string; window: string; command: string; withdraw: string; more: string; steered: string;
  /** `{limit}` `{text}` */ steerFull: string; /** `{text}` */ steerReturned: string; /** `{text}` */ steerBack: string }>;
type Line = Readonly<{ text: string; steer: boolean }>;

/**
 * The lines waiting above the composer (Claude Code's queued messages, Codex's steer): the lines added to the running turn first, then the
 * queued ones, at most `visibleRows` (registry `workline-queue.json`) and a `+n` row; the header names why they wait and the withdraw key.
 */
export function QueuedLines({ queued, steered, reason, labels }: { readonly queued: readonly string[]; readonly steered: readonly string[]; readonly reason: string;
  readonly labels: QueueLabels }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const lines: Line[] = [...steered.map(text => ({ text, steer: true })), ...queued.map(text => ({ text, steer: false }))];
  if (!lines.length) return null;
  const shown = lines.slice(0, LIMITS.visibleRows), hidden = lines.length - shown.length;
  const first = (text: string) => { const [line = '', ...rest] = text.split('\n'); return rest.length ? `${line} ${glyphs.ellipsis}` : line; };
  return (
    <Box flexDirection="column" flexShrink={0}>
      {queued.length ? <Text {...palette.muted} wrap="truncate-end">{`${reason} ${glyphs.separator} ${labels.withdraw}`}</Text> : null}
      {shown.map((line, index) => <Text key={index} wrap="truncate-end">{`  ${line.steer ? '+' : glyphs.bullet} ${first(line.text)}`}
        {line.steer ? <Text {...palette.muted}>{` ${glyphs.separator} ${labels.steered}`}</Text> : null}</Text>)}
      {hidden ? <Text {...palette.muted}>{fillTemplate(labels.more, { count: hidden })}</Text> : null}
    </Box>
  );
}

/**
 * Owner S5 (Ctrl+Enter, Alt+Enter): the person's lines added to the running turn. The service takes one only at the turn's next model-call
 * boundary — never into an approval or witness wait — and the turn's result names those that joined and those it returns. Nothing is lost
 * or sent twice: a line the service did not keep (`not-running`, `full`, a failure) or returned at a normal end becomes the next queued
 * message; one returned by a stopped turn goes back into the input (the draft before it stays one Ctrl+_ step back). Tema L6: each MCP
 * notice key is said once per terminal, as a system line.
 */
export function useTurnSteer(options: { readonly labels: QueueLabels | undefined; readonly push: (entries: readonly WorkLedgerEntry[]) => void;
  readonly errorText: (error: unknown) => string; readonly submit: (text: string, mentions: readonly string[], entry: ComposerHistoryEntry) => void;
  readonly restore: (text: string) => void; readonly joined: (text: string) => void }) {
  const latest = useRef(options); latest.current = options;
  const current = useRef<TurnSteer | null>(null), pending = useRef(new Map<string, ComposerHistoryEntry>()), said = useRef(new Set<string>());
  const [steerable, setSteerable] = useState(false), [steered, setSteered] = useState<readonly string[]>([]);
  const take = (id: string): ComposerHistoryEntry | null => {
    const entry = pending.current.get(id) ?? null;
    if (entry) { pending.current.delete(id); setSteered([...pending.current.values()].map(item => item.text)); }
    return entry;
  };
  const say = (template: string | undefined, entry: ComposerHistoryEntry, limit?: number) => {
    if (template) latest.current.push([notice('info', fillTemplate(template, { text: entry.text.trim(), limit: limit ?? '' }))]);
  };
  const giveBack = (entries: readonly ComposerHistoryEntry[], stopped: boolean) => {
    if (!entries.length) return;
    const { labels, submit, restore } = latest.current;
    if (stopped) { for (const entry of entries) say(labels?.steerBack, entry); restore(entries.map(entry => entry.text).join('\n')); return; }
    for (const entry of entries) { say(labels?.steerReturned, entry); submit(entry.text, [], entry); }
  };
  /** The turn was bound: with a steer port its lines may be added from now on; `null` when it ended (what is still pending goes back). */
  const bind = useCallback((steer: TurnSteer | null, stopped = false) => {
    current.current = steer; setSteerable(steer !== null);
    if (steer === null) giveBack([...pending.current.keys()].map(take).filter(entry => entry !== null), stopped);
  }, []);
  /** Ctrl+Enter's line: `@file` mentions are attached only by a message of their own, so such a line is queued as one. */
  const add = useCallback((text: string, mentions: readonly string[], entry: ComposerHistoryEntry) => {
    const steer = current.current;
    if (!steer || mentions.length) { latest.current.submit(text, mentions, entry); return; }
    const id = globalThis.crypto.randomUUID();
    pending.current.set(id, { text, pastes: [] }); setSteered([...pending.current.values()].map(item => item.text));
    const kept = (full: boolean) => { const back = take(id); if (!back) return; if (full) say(latest.current.labels?.steerFull, back, TURN_STEER_LINES); latest.current.submit(back.text, [], back); };
    steer(id, text).then(state => { if (state !== 'queued') kept(state === 'full'); },
      (error: unknown) => { latest.current.push([notice('error', latest.current.errorText(error))]); kept(false); });
  }, []);
  /** One delta of the bound turn: a joined line enters the conversation where it joined; `done` settles the rest and says new notices. */
  const observe = useCallback((delta: TurnDelta) => {
    if (delta.kind === 'message' && delta.steerId) { const entry = take(delta.steerId); if (entry) latest.current.joined(entry.text); }
    if (delta.kind !== 'done') return;
    for (const item of delta.notices ?? []) if (!said.current.has(item.key)) { said.current.add(item.key); latest.current.push([systemSummaryEntry(item.text, 'warning')]); }
    giveBack((delta.steer?.returned ?? []).map(take).filter(entry => entry !== null), delta.finish === 'cancelled' || delta.finish === 'error');
  }, []);
  return { steerable, steered, bind, add, observe };
}
