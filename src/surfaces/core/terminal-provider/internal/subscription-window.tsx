import { useEffect, useRef, useState } from 'react';
import { fillTemplate, span, useTerminalHandover } from '#surfaces/core/terminal-render/index.js';
import { PICKER_INITIAL } from '#surfaces/core/terminal-picker/index.js';
import { EntryWindow, LinesWindow, PickerWindow, QuestionWindow, type PanelLabels, type PanelLine, type ProviderModelOutcome, type ProviderPanelKind } from '#surfaces/core/terminal-panels/index.js';
import type { ProviderDelegateClass, ProviderSubscriptionOutcome, ProviderSubscriptionPort } from './context.js';

type Step = Readonly<{ kind: 'busy' } | { kind: 'dir'; owned: string; lines: readonly PanelLine[] } | { kind: 'other'; problem: string | null }
  | { kind: 'ended'; title: string; lines: readonly PanelLine[]; retry: boolean }
  | { kind: 'consent'; outcome: ProviderSubscriptionOutcome; configDir: string | null; now: readonly ProviderDelegateClass[]; ticked: readonly ProviderDelegateClass[]; pos: number }
  | { kind: 'confirm'; outcome: ProviderSubscriptionOutcome; configDir: string | null; now: readonly ProviderDelegateClass[]; ticked: readonly ProviderDelegateClass[] }>;
const CLASSES: readonly ProviderDelegateClass[] = ['system', 'ai'];
/** The dir step's explanation and shell twin wrap on a narrow terminal; they keep this many rows (a longer body scrolls). */
const DIR_BODY_ROWS = 4;

/**
 * PV 3 (owner S10; proven UX: Claude Code `/login`, Codex login): a CLI subscription from `/provider`. The login dir (the Brain's own first, its
 * path shown), then the terminal is handed to the CLI's own sign-in as for `$EDITOR` (Ink suspended, the host's mouse and focus reports off,
 * SIGINT left to the CLI in the same foreground group; the registry bound ends it), a line break after the CLI's last output (2e), the governed
 * connect, and the person's delegated-use card: system and ai unticked on a first connect (S10), the consent in force ticked on a reconnect, MCP never
 * grantable; a widening asks once more on an armed card.
 */
export function SubscriptionWindow({ port, kind, labels, onDone, onBack }: { readonly port: ProviderSubscriptionPort; readonly kind: ProviderPanelKind;
  readonly labels: PanelLabels; readonly onDone: (outcome: ProviderModelOutcome) => void; readonly onBack: () => void }) {
  const words = port.words, handOver = useTerminalHandover();
  const [step, setStep] = useState<Step>({ kind: 'busy' });
  const live = useRef(true);
  const show = (next: Step) => { if (live.current) setStep(next); };
  const ended = (title: string, lines: readonly PanelLine[], retry: boolean) => show({ kind: 'ended', title, lines, retry });
  // A refusal before anything starts (an AI or CI environment, no person terminal, a kind without a sign-in) ends here with its typed reason.
  const prepare = () => { show({ kind: 'busy' }); void port.prepare(kind.id).then(ready => ready.owned === null ? ended(ready.title, ready.lines, false) : show({ kind: 'dir', owned: ready.owned, lines: ready.lines })); };
  const opened = useRef(prepare);
  useEffect(() => { opened.current(); return () => { live.current = false; }; }, []);
  const connect = (configDir: string | null, delegate?: readonly ProviderDelegateClass[]) => port.connect(kind.id, configDir, delegate);
  const signIn = (configDir: string | null) => {
    show({ kind: 'busy' });
    void (async () => {
      const done = await handOver(fillTemplate(words.banner, { kind: kind.label }), () => port.login(kind.id, configDir));
      if (!done || !done.signedIn) { ended(done?.title ?? kind.label, done?.lines ?? [], !done?.refused); return; }
      const outcome = await connect(configDir);
      const shown = { ...outcome, lines: [...done.lines, ...outcome.lines] };
      if (outcome.state !== 'applied') { onDone(shown); return; }
      // Lead 2026-10-31: the card opens with the consent in force ticked (none on a first connect, S10), so an unchanged Enter keeps it; revoking is an untick.
      show({ kind: 'consent', outcome: shown, configDir, now: outcome.delegate, ticked: outcome.delegate, pos: 0 });
    })();
  };
  const who = (classes: readonly ProviderDelegateClass[]) => classes.length ? fillTemplate(words.youAnd, { classes: classes.join(', ') }) : words.onlyYou;
  const title = (text: string) => [span(text, { bold: true })];
  if (step.kind === 'busy') return <PickerWindow title={title(kind.label)} body={[{ spans: [span(labels.loading)] }]} bodyRows={1} tree={null} labels={labels.picker}
    position={labels.position} onResult={() => undefined} />;
  if (step.kind === 'ended') return step.retry
    ? <QuestionWindow title={step.title} lines={step.lines} hints={words.retryKeys} position={labels.position} onAnswer={answer => { if (answer) prepare(); else onBack(); }} />
    : <LinesWindow title={step.title} lines={step.lines} hints={labels.provider.resultHints} position={labels.position} onClose={onBack} />;
  if (step.kind === 'other') return <EntryWindow key="login-dir" title={`${kind.label} · ${words.otherTitle}`} hints={words.otherHint} position={labels.position} problem={step.problem}
    onCancel={prepare} onSubmit={text => { if (!text.trim().startsWith('/')) return words.otherAbsolute; signIn(text.trim()); return null; }} />;
  if (step.kind === 'dir') return <PickerWindow title={title(`${kind.label} · ${words.dirTitle}`)} body={step.lines.map(line => ({ spans: [...(line.label ? [span(`${line.label}: `, { bold: true })] : []),
    span(line.text, line.tone === 'muted' ? { role: 'muted' } : {})] }))} bodyRows={DIR_BODY_ROWS} labels={labels.picker} position={labels.position} pickerKey="login-dir"
    tree={{ title: words.dirTitle, items: [{ id: 'owned', label: words.dirOwned, detail: step.owned }, { id: 'other', label: words.dirOther }] }}
    onResult={result => { if (result.kind !== 'selected') { onBack(); return; } if (result.id === 'other') show({ kind: 'other', problem: null }); else signIn(null); }} />;
  if (step.kind === 'confirm') {
    const { outcome, configDir, now, ticked } = step;
    return <QuestionWindow title={fillTemplate(words.question, { classes: ticked.join(', '), kind: kind.label })} lines={[]} hints={words.questionKeys} position={labels.position}
      onAnswer={answer => {
        if (!answer) { show({ kind: 'consent', outcome, configDir, now, ticked, pos: 0 }); return; }
        show({ kind: 'busy' }); void connect(configDir, ticked).then(onDone);
      }} />;
  }
  const { outcome, configDir, now, ticked } = step, box = (id: ProviderDelegateClass) => `[${ticked.includes(id) ? 'x' : ' '}] `;
  return <PickerWindow title={title(fillTemplate(words.consentTitle, { kind: kind.label }))} body={[fillTemplate(words.consentNow, { who: who(now) }), words.configPolicy,
    ...(outcome.delegationBlocked ? [outcome.delegationBlocked] : [])].map(text => ({ spans: [span(text)] }))} bodyRows={4} bodyPages
    labels={labels.picker} position={labels.position} pickerKey={`consent:${ticked.join(',')}`} initial={{ ...PICKER_INITIAL, pos: step.pos }}
    tree={{ title: words.consentTitle, items: [{ id: 'confirm', label: fillTemplate(words.consentConfirm, { who: who(ticked) }) },
      ...CLASSES.map(id => ({ id, label: `${box(id)}${words[id]}`, ...(outcome.delegationBlocked ? { blocked: { reason: outcome.delegationBlocked } } : {}) })),
      { id: 'mcp', label: `[ ] ${words.mcp}`, blocked: { reason: words.mcpBlocked } }] }}
    onResult={result => {
      // Esc keeps the consent as it is now; Enter on a class ticks or unticks it; the first row confirms what is ticked (nothing: only you).
      if (result.kind !== 'selected') { onDone(outcome); return; }
      const id = result.id as ProviderDelegateClass | 'confirm';
      if (id !== 'confirm') { show({ ...step, ticked: ticked.includes(id) ? ticked.filter(item => item !== id) : CLASSES.filter(item => item === id || ticked.includes(item)), pos: CLASSES.indexOf(id) + 1 }); return; }
      if (ticked.length === now.length && ticked.every(item => now.includes(item))) { onDone(outcome); return; }
      // Widening asks once more on an armed card; narrowing (fewer classes, or only you) is sent at once.
      if (ticked.some(item => !now.includes(item))) { show({ kind: 'confirm', outcome, configDir, now, ticked }); return; }
      show({ kind: 'busy' }); void connect(configDir, ticked).then(onDone);
    }} />;
}
