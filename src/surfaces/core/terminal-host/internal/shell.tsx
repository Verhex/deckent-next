import { createElement, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { Composer, type ComposerHistoryEntry, type ComposerLabels } from '#surfaces/core/terminal-composer/index.js';
import { FullscreenWorkline, fullscreenFrameRows, fullscreenInfoRows } from '#surfaces/core/terminal-window/index.js';
import { openTerminalHost, type TerminalHostHandle, type TerminalHostOptions } from './host.js';
import { StartupBanner, type WorklineStartup } from './startup-banner.js';
import SHELL_LIMITS from './shell-limits.json' with { type: 'json' };

/** Catalog words the caller resolved: the status row (`status`: the scope and "preparing"), `queued` (`{count}`), the one overflow note. */
export interface TerminalShellLabels { readonly composer: ComposerLabels; readonly prompt: string; readonly banner: string; readonly hint: string;
  readonly status: string; readonly queued: string; readonly dropped: string }
export interface TerminalShellOptions extends Omit<TerminalHostOptions, 'view' | 'inlineStartup' | 'fullscreen'> {
  readonly startup: WorklineStartup; readonly labels: TerminalShellLabels }
export type ShellLine = Readonly<{ text: string; mentions: readonly string[]; entry: ComposerHistoryEntry }>;
/** What the shell hands to the view that takes its host: the draft as typed and the lines sent meanwhile, in order. */
export interface TerminalShell { readonly host: TerminalHostHandle; take(): Readonly<{ draft: ComposerHistoryEntry | null; queued: readonly ShellLine[]; armedAt: number | null }> }

/**
 * alpha.60 C (P4, owner 2026-10-31): the full window drawn before the host graph loads — the banner (the model is a placeholder until the chat
 * plan is read), the real composer and a "preparing" status row in the Workline's own frame, so the bar row does not move when the Workline
 * takes the same host. Typed keys stay the draft; a sent line waits (at most `queuedLines`, later ones dropped with one note) and is handed over
 * with the draft. Nothing here sends, reads a policy or starts a service. Ctrl+D / Ctrl+C twice closes it, and the launch then opens nothing.
 */
export async function openTerminalShell(options: TerminalShellOptions): Promise<TerminalShell> {
  const kept: { draft: ComposerHistoryEntry | null; queued: ShellLine[]; armedAt: number | null } = { draft: null, queued: [], armedAt: null };
  const host = openTerminalHost({ ...options, fullscreen: true, view: () => createElement(ShellView, { options, kept, exit: () => { void host.close(); } }) });
  await host.flushed();
  return { host, take: () => ({ draft: kept.draft, queued: [...kept.queued], armedAt: kept.armedAt }) };
}

function ShellView({ options, kept, exit }: { readonly options: TerminalShellOptions; readonly kept: { draft: ComposerHistoryEntry | null; queued: ShellLine[]; armedAt: number | null }; readonly exit: () => void }) {
  const palette = useWorklinePalette(), size = useWindowSize(), rows = fullscreenFrameRows(size.rows || 24), { labels } = options;
  const [queued, setQueued] = useState(0), [dropped, setDropped] = useState(false);
  const submit = (text: string, mentions: readonly string[], entry: ComposerHistoryEntry) => {
    if (kept.queued.length >= SHELL_LIMITS.queuedLines) { setDropped(true); return; }
    kept.queued.push({ text, mentions, entry }); kept.draft = null; setQueued(kept.queued.length);
  };
  const status = [labels.status, ...(queued ? [labels.queued.replace('{count}', String(queued))] : [])].join(' · ');
  return <FullscreenWorkline
    viewport={<Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden" justifyContent="flex-end">
      {options.startup.banner === 'off' ? null : <StartupBanner startup={options.startup} columns={size.columns || 80} />}<Text {...palette.accent}>{labels.banner}</Text><Text> </Text></Box>}
    above={null}
    bar={<Composer prompt={labels.prompt} labels={labels.composer} busy={false} maxRows={Math.max(1, Math.floor((size.rows || 24) / 3))}
      onSubmit={submit} onCancel={() => undefined} onExit={exit} onDraft={entry => { kept.draft = entry.text || entry.pastes.length ? entry : null; }} onArm={armedAt => { kept.armedAt = armedAt; }} />}
    info={<>
      <Text {...palette.muted} wrap="truncate-end">{status}</Text>
      {fullscreenInfoRows(rows) >= 3 ? <Text {...palette.warning} wrap="truncate-end">{dropped ? labels.dropped.replace('{count}', String(SHELL_LIMITS.queuedLines)) : ' '}</Text> : null}
      {fullscreenInfoRows(rows) >= 2 ? <Text {...palette.muted} wrap="truncate-end">{labels.hint}</Text> : null}
    </>} />;
}
