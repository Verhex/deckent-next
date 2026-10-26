import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { hubOperationSchemas, hubOperationWrites, parseHubOperation, type HubOperation, type HubOperationName } from '#engine/index.js';
import { ErrorRegistry, t, type KnownSecretSnapshot, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { hubResultLines, hubCardLines, type HubCommandContext } from '#surfaces/core/cli-hub/index.js';
import { EntryWindow, QuestionWindow, LinesWindow, PickerWindow, type PanelLabels, type PanelNotice } from '#surfaces/core/terminal-panels/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';

/** Shared with the CLI: a file cannot redirect the terminal card to another scope. */
export function hubWindowRequest(operation: HubOperationName, input: unknown, scopeId: string): HubOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw ErrorRegistry.createError('CLI_USAGE');
  const raw = input as Record<string, unknown>;
  if (raw.scopeId !== undefined && raw.scopeId !== scopeId) throw ErrorRegistry.createError('CLI_USAGE');
  return parseHubOperation({ operation, input: { schemaVersion: 1, ...raw, scopeId,
    ...(hubOperationWrites(operation) && raw.commandId === undefined ? { commandId: randomUUID() } : {}) } });
}
interface HubPanelInput { readonly root: string; readonly scopeId: string; readonly options: ConfigLoadOptions; readonly locale: Locale;
  readonly known?: KnownSecretSnapshot; readonly maxBytes: number; readonly timeoutMs: number; readonly execute: NonNullable<HubCommandContext['executeHub']> }
interface WindowActions { readonly labels: PanelLabels; readonly push: (notices: readonly PanelNotice[]) => void;
  readonly onError: (error: unknown) => void; readonly onClose: () => void }
/** One window/input owner, existing quiet-armed decision keys, abort on close, finite wait. No readline competes with Ink. */
function HubPanel(props: HubPanelInput & WindowActions) {
  const { locale, labels } = props, [action, setAction] = useState<HubOperationName | null>(null);
  const [cardsAfter, setCardsAfter] = useState(0);
  const [request, setRequest] = useState<HubOperation | null>(null), [result, setResult] = useState<string[] | null>(null), [busy, setBusy] = useState(false);
  const pending = useRef(false), lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  const title = t('hub.window.title', {}, locale), hints = t('hub.window.hints', {}, locale);
  const execute = async (command: HubOperation) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const value = await props.execute(props.root, command, props.options, AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(props.timeoutMs)]));
      if (!lifetime.current.signal.aborted) {
        if (command.operation === 'hub.cards' && Array.isArray(value)) setCardsAfter(Number(value.at(-1)?.after ?? 0));
        const lines = hubResultLines(value, locale); setResult(lines); setRequest(null);
        props.push([{ level: 'info', text: `${command.operation} · ${props.scopeId}` }]);
      }
    } catch (error) { if (!lifetime.current.signal.aborted) props.onError(error); }
    finally { pending.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  if (busy) return <PickerWindow title={[span(title)]} bodyRows={2} body={[{ spans: [span(labels.loading)] }]} tree={null}
    labels={labels.picker} position={labels.position} onResult={() => undefined} onClose={props.onClose} />;
  if (result) return <LinesWindow title={title} lines={result.map(text => ({ label: '', text }))} hints={hints} position={labels.position}
    onClose={() => { setResult(null); setAction(null); }} />;
  if (request) return <QuestionWindow title={t('hub.card.title', { operation: request.operation }, locale)}
    lines={hubCardLines(request, locale, props.known).map(text => ({ label: '', text }))}
    hints={t('hub.window.confirm', {}, locale)} position={labels.position} onAnswer={answer => { if (answer === true) void execute(request); else { setRequest(null); setAction(null); } }} />;
  if (action) return <EntryWindow title={title} body={[{ spans: [span(t('hub.window.input', {}, locale))] }]} hints={hints} position={labels.position}
    onCancel={() => setAction(null)} onSubmit={async path => {
      try {
        const raw = await readJsonInput(resolve(props.root, path), props.maxBytes, { subject: 'hub.input', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID',
          tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' });
        const command = hubWindowRequest(action, raw, props.scopeId);
        if (hubOperationWrites(action)) setRequest(command); else void execute(command);
        return null;
      } catch (error) { props.onError(error); setAction(null); return null; }
    }} />;
  return <PickerWindow title={[span(title)]} bodyRows={2} body={[{ spans: [span(props.scopeId)] }, { spans: [span(t('hub.output.untrusted', {}, locale))] }]}
    tree={{ title, items: [...(Object.keys(hubOperationSchemas) as HubOperationName[]).map(id => ({ id, label: id })), ...(cardsAfter ? [{ id: 'next-cards', label: t('hub.window.nextCards', {}, locale) }] : [])] }} labels={labels.picker} position={labels.position}
    onResult={selected => {
      if (selected.kind !== 'selected') { props.onClose(); return; }
      if (selected.id === 'next-cards') { void execute(hubWindowRequest('hub.cards', { after: cardsAfter }, props.scopeId)); return; }
      const operation = selected.id as HubOperationName;
      if (operation === 'hub.sources.list' || operation === 'hub.cards') void execute(hubWindowRequest(operation, {}, props.scopeId));
      else setAction(operation);
    }} />;
}
export function hubPanelPort(input: HubPanelInput) { return { render: (actions: WindowActions) => <HubPanel {...input} {...actions} /> }; }
