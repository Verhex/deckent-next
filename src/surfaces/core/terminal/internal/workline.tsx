import { useCallback, useEffect, useRef, useState, createElement } from 'react';
import { render, Box, Static, Text, useApp, useInput } from 'ink';
import type { InferenceServingProfile } from '#domain/index.js';
import { buildInferenceServingPlan, completeInferenceChatTurn, type InferenceChatMessage } from '#engine/index.js';
import type { WorklineInkPalette } from './ink-palette.js';
import { WorklinePaletteProvider, useWorklinePalette } from './ink-palette-context.js';
import { StatusStrip } from './status-strip.js';
import { parseSlashLine, WORKLINE_SLASH_COMMANDS } from './slash-registry.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { WORK_LEDGER_SCHEMA_VERSION } from './work-ledger.js';
import { LedgerEntryRow, type LedgerEntryLabels } from './ledger-entry.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { ledgerEntriesForWorkers, ledgerEntryForRun } from './workline-ledger.js';
import { buildWorklineBridgeSnapshot, type WorklineBridgeSink } from './bridge-snapshot.js';
import { newWorkerTaskIds } from './worker-watch.js';
import { newRunLedgerEntries } from './run-watch.js';
import { loadRunViewsForWatch } from './workline-ledger.js';
import type { Locale } from '#platform/index.js';
import { t } from '#platform/index.js';

const WORKLINE_MAX_LEDGER_ENTRIES = 400;
const WORKLINE_MAX_CHAT_MESSAGES = 80;

export interface WorklineLabels {
  readonly banner: string;
  readonly prompt: string;
  readonly statusReady: string;
  readonly statusBusy: string;
  readonly statusFailed: string;
  readonly hint: string;
  readonly roleUser: string;
  readonly roleAssistant: string;
  readonly header: string;
  readonly errorPrefix: string;
  readonly ledgerUnavailable: string;
  readonly runNotFound: string;
  readonly workersEmpty: string;
  readonly runUsage: string;
  readonly runCard: string;
  readonly workerCard: string;
  readonly watchStarted: string;
  readonly watchRunsStarted: string;
  readonly watchStopped: string;
  readonly chatBackendLine: string;
}

export type WorklineCompleteTurn = (
  messages: readonly InferenceChatMessage[],
  signal?: AbortSignal,
) => Promise<string>;

export interface WorklineProps {
  readonly profile: InferenceServingProfile;
  readonly labels: WorklineLabels;
  readonly completeTurn: WorklineCompleteTurn;
  readonly ledger?: WorklineLedgerPorts;
  readonly bridge?: WorklineBridgeSink;
  readonly tty: { readonly columns: number | null; readonly rows: number | null };
  readonly signal?: AbortSignal;
}

export function WorklineApp({ profile, labels, completeTurn, ledger, bridge, tty, signal }: WorklineProps) {
  const palette = useWorklinePalette();
  const { exit } = useApp();
  const [entries, setEntries] = useState<WorkLedgerEntry[]>([]);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(labels.statusReady);
  const [messages, setMessages] = useState<InferenceChatMessage[]>(() => [{ role: 'system', content: 'You are Deckent terminal assistant.' }]);
  const [watchWorkers, setWatchWorkers] = useState(false);
  const [watchRuns, setWatchRuns] = useState(false);
  const seenWorkerIds = useRef(new Set<string>());
  const seenRunFingerprints = useRef(new Map<string, string>());
  const plan = buildInferenceServingPlan(profile);
  const ledgerLabels: LedgerEntryLabels = {
    runCard: labels.runCard,
    workerCard: labels.workerCard,
    chatUser: labels.roleUser,
    chatAssistant: labels.roleAssistant,
  };

  const pushEntry = useCallback((entry: WorkLedgerEntry) => {
    setEntries(current => {
      const next = [...current, entry];
      return next.length > WORKLINE_MAX_LEDGER_ENTRIES ? next.slice(-WORKLINE_MAX_LEDGER_ENTRIES) : next;
    });
  }, []);

  const pushChat = useCallback((role: 'user' | 'assistant', text: string) => {
    setEntries(current => [...current, {
      schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
      kind: 'chat',
      id: `chat-${role}-${current.length}`,
      role,
      text,
    }]);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    bridge.onUpdate(buildWorklineBridgeSnapshot({
      profile,
      plan,
      tty,
      ledgerTail: entries,
      ...(bridge.publishedModelIds ? { publishedModelIds: bridge.publishedModelIds } : {}),
      ...(bridge.maxTail === undefined ? {} : { maxTail: bridge.maxTail }),
    }));
  }, [bridge, entries, plan, profile, tty]);

  useEffect(() => {
    if (!watchWorkers || !ledger) return;
    const intervalMs = ledger.workerHeartbeatMs ?? 5000;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || signal?.aborted) return;
      try {
        const cards = await ledgerEntriesForWorkers(ledger, `watch-${Date.now()}`);
        const workers = cards.filter(entry => entry.kind === 'worker');
        const { seen, fresh } = newWorkerTaskIds(seenWorkerIds.current, workers);
        seenWorkerIds.current = seen;
        for (const worker of fresh) pushEntry(worker);
      } catch {
        // observe-only poll; operator sees next manual /workers on failure
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), intervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [ledger, pushEntry, signal, watchWorkers]);

  useEffect(() => {
    if (!watchRuns || !ledger?.listRunIds) return;
    const intervalMs = ledger.workerHeartbeatMs ?? 5000;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || signal?.aborted) return;
      try {
        const runs = await loadRunViewsForWatch(ledger);
        const { seen, fresh } = newRunLedgerEntries(seenRunFingerprints.current, runs, `watch-${Date.now()}`);
        seenRunFingerprints.current = seen;
        for (const card of fresh) pushEntry(card);
      } catch {
        // inventory/inspect errors surface on manual /run
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), intervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [ledger, pushEntry, signal, watchRuns]);

  const submit = useCallback(async () => {
    const trimmed = line.trim();
    if (!trimmed || busy) return;
    const slash = parseSlashLine(trimmed);
    if (slash) {
      if (slash.command === 'exit' || slash.command === 'quit') { exit(); return; }
      if (slash.command === 'status') {
        setStatus(`${labels.header} · ${plan.openaiBaseUrl ?? '—'}`);
        setLine('');
        return;
      }
      if (slash.command === 'chat-backend') {
        pushEntry({
          schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
          kind: 'notice',
          id: `notice-chat-backend-${Date.now()}`,
          level: 'info',
          text: labels.chatBackendLine,
        });
        setLine('');
        return;
      }
      if (slash.command === 'help') {
        const help = WORKLINE_SLASH_COMMANDS
          .filter((cmd, index, all) => all.findIndex(other => other.name === cmd.name) === index)
          .map(cmd => `/${cmd.name}`)
          .join(' · ');
        pushChat('assistant', help);
        setLine('');
        return;
      }
      if (slash.command === 'watch-workers') {
        setLine('');
        if (!ledger) {
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-watch-unavail`,
            level: 'error',
            text: labels.ledgerUnavailable,
          });
          return;
        }
        if (!watchWorkers) {
          setWatchWorkers(true);
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-watch-on-${Date.now()}`,
            level: 'info',
            text: labels.watchStarted,
          });
        }
        return;
      }
      if (slash.command === 'watch-runs') {
        setLine('');
        if (!ledger?.listRunIds) {
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-run-watch-unavail`,
            level: 'error',
            text: labels.ledgerUnavailable,
          });
          return;
        }
        if (!watchRuns) {
          setWatchRuns(true);
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-run-watch-on-${Date.now()}`,
            level: 'info',
            text: labels.watchRunsStarted,
          });
        }
        return;
      }
      if (slash.command === 'watch-stop') {
        setLine('');
        if (watchWorkers || watchRuns) {
          setWatchWorkers(false);
          setWatchRuns(false);
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-watch-off-${Date.now()}`,
            level: 'info',
            text: labels.watchStopped,
          });
        }
        return;
      }
      if (slash.command === 'workers' || slash.command === 'run') {
        setLine('');
        if (!ledger) {
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `notice-ledger-unavail`,
            level: 'error',
            text: labels.ledgerUnavailable,
          });
          return;
        }
        setBusy(true);
        setStatus(labels.statusBusy);
        const prefix = `ledger-${Date.now()}`;
        try {
          if (slash.command === 'workers') {
            const cards = await ledgerEntriesForWorkers(ledger, prefix);
            if (cards.length === 0) {
              pushEntry({
                schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
                kind: 'notice',
                id: `${prefix}-empty`,
                level: 'info',
                text: labels.workersEmpty,
              });
            } else {
              for (const card of cards) pushEntry(card);
            }
          } else {
            const runId = slash.args.trim();
            if (!runId) {
              pushEntry({
                schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
                kind: 'notice',
                id: `${prefix}-usage`,
                level: 'error',
                text: labels.runUsage,
              });
            } else {
              const card = await ledgerEntryForRun(ledger, runId, prefix);
              if (!card) {
                pushEntry({
                  schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
                  kind: 'notice',
                  id: `${prefix}-missing`,
                  level: 'error',
                  text: labels.runNotFound,
                });
              } else pushEntry(card);
            }
          }
          setStatus(labels.statusReady);
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 120) : '';
          pushEntry({
            schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
            kind: 'notice',
            id: `${prefix}-err`,
            level: 'error',
            text: detail || labels.statusFailed,
          });
          setStatus(labels.statusFailed);
        } finally {
          setBusy(false);
        }
        return;
      }
      setStatus(`${labels.errorPrefix}: /${slash.command}`);
      setLine('');
      return;
    }
    setLine('');
    pushChat('user', trimmed);
    setBusy(true);
    setStatus(labels.statusBusy);
    const userMessage: InferenceChatMessage = { role: 'user', content: trimmed };
    const nextHistory: InferenceChatMessage[] = [...messages, userMessage].slice(-WORKLINE_MAX_CHAT_MESSAGES);
    setMessages(nextHistory);
    try {
      const reply = await completeTurn(nextHistory, signal);
      const assistantMessage: InferenceChatMessage = { role: 'assistant', content: reply };
      setMessages([...nextHistory, assistantMessage].slice(-WORKLINE_MAX_CHAT_MESSAGES));
      pushChat('assistant', reply);
      setStatus(labels.statusReady);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 120) : '';
      setStatus(detail ? `${labels.errorPrefix}: ${detail}` : labels.statusFailed);
      pushChat('assistant', detail || labels.statusFailed);
    } finally {
      setBusy(false);
    }
  }, [busy, completeTurn, exit, labels, ledger, line, messages, plan.openaiBaseUrl, pushChat, pushEntry, signal, watchRuns, watchWorkers]);

  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.return) { void submit(); return; }
    if (key.backspace || key.delete) { setLine(current => current.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) setLine(current => current + input);
  });

  return (
    <Box flexDirection="column">
      <Text {...palette.accent}>{labels.banner}</Text>
      <StatusStrip
        profileId={profile.id}
        endpoint={plan.openaiBaseUrl}
        busy={busy}
        readyLabel={labels.statusReady}
        busyLabel={labels.statusBusy}
      />
      <Static items={[...entries]}>
        {item => <LedgerEntryRow key={item.id} entry={item} labels={ledgerLabels} />}
      </Static>
      <Box borderStyle="round" paddingX={1}>
        <Text>{labels.prompt}{line}</Text>
      </Box>
      <Text dimColor>{status}</Text>
      <Text dimColor>{labels.hint}</Text>
    </Box>
  );
}

function labels(locale: Locale, profile: InferenceServingProfile, chatBackendLine: string): WorklineLabels {
  return {
    banner: t('terminal.workline.banner', {}, locale),
    header: t('terminal.workline.header', { profile: profile.id }, locale),
    errorPrefix: t('terminal.workline.errorPrefix', {}, locale),
    prompt: t('terminal.session.prompt', {}, locale),
    statusReady: t('terminal.workline.statusReady', {}, locale),
    statusBusy: t('terminal.workline.statusBusy', {}, locale),
    statusFailed: t('terminal.workline.statusFailed', {}, locale),
    hint: t('terminal.workline.hint', {}, locale),
    roleUser: t('terminal.workline.roleUser', {}, locale),
    roleAssistant: t('terminal.workline.roleAssistant', {}, locale),
    ledgerUnavailable: t('terminal.workline.ledgerUnavailable', {}, locale),
    runNotFound: t('terminal.workline.runNotFound', {}, locale),
    workersEmpty: t('terminal.workline.workersEmpty', {}, locale),
    runUsage: t('terminal.slash.runUsage', {}, locale),
    runCard: t('terminal.ledger.runCard', {}, locale),
    workerCard: t('terminal.ledger.workerCard', {}, locale),
    watchStarted: t('terminal.workline.watchStarted', {}, locale),
    watchRunsStarted: t('terminal.workline.watchRunsStarted', {}, locale),
    watchStopped: t('terminal.workline.watchStopped', {}, locale),
    chatBackendLine,
  };
}

export async function runTerminalWorkline(
  profile: InferenceServingProfile,
  locale: Locale,
  options: {
    signal?: AbortSignal;
    completeTurn?: WorklineCompleteTurn;
    ledger?: WorklineLedgerPorts;
    palette: WorklineInkPalette;
    chatBackendLine?: string;
    bridge?: WorklineBridgeSink;
    tty: { readonly columns: number | null; readonly rows: number | null };
  },
): Promise<void> {
  const completeTurn = options.completeTurn
    ?? ((messages, turnSignal) => completeInferenceChatTurn(profile, [...messages], turnSignal));
  const inkPalette = options.palette;
  const instance = render(createElement(WorklinePaletteProvider, { palette: inkPalette, children: createElement(WorklineApp, {
    profile,
    labels: labels(locale, profile, options.chatBackendLine ?? t('terminal.workline.chatBackendUnknown', {}, locale)),
    completeTurn,
    tty: options.tty,
    ...(options.ledger ? { ledger: options.ledger } : {}),
    ...(options.bridge ? { bridge: options.bridge } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }) }));
  await instance.waitUntilExit();
}
