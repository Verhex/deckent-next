import { useCallback, useEffect, useRef, useState } from 'react';
import { fillTemplate, span, useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { ListPicker, PICKER_INITIAL, type PickerNode, type PickerResult, type PickerState, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { EntryWindow } from './entry.js';
import { LinesWindow, QuestionWindow, usePickerRoom } from './lines.js';
import type { McpChoice, McpPanelLabels, McpPanelList, McpPanelPort, McpServerDraft, McpTrustQuestion, PanelLabels, PanelLine, PanelNotice } from './contract.js';

const ADD = ':add';
type Action = keyof McpPanelLabels['actions'];
const ACTIONS: readonly Action[] = ['detail', 'approve', 'revoke', 'reconnect', 'remove'];

/** `/mcp` as a list: "add a server" first, then each server (status, tools, realm, scope) with what can be done to it now. */
export function mcpPanelTree(list: McpPanelList, labels: McpPanelLabels): PickerTree {
  const servers: PickerNode[] = list.servers.map(server => ({ id: server.name, label: server.attention ? `! ${server.name}` : server.name,
    detail: [server.status, server.tools, server.realm, server.scope].filter(Boolean).join(' · '), keywords: [server.launch], childTitle: server.name,
    children: ACTIONS.filter(action => server.trusted || (action !== 'revoke' && action !== 'reconnect')).map(action => ({ id: action, label: labels.actions[action] })) }));
  return { title: labels.title, items: [{ id: ADD, label: labels.add, detail: labels.addDetail }, ...servers] };
}

type WizardStep = 'transport' | 'name' | 'command' | 'url' | 'args' | 'env' | 'headers' | 'realm' | 'scope';
/** The wizard's steps for a transport: a local (stdio) server has a command, arguments, environment and realm; an HTTP one a URL and headers. */
export function mcpWizardSteps(transport: McpServerDraft['transport']): readonly WizardStep[] {
  return transport === 'http' ? ['transport', 'name', 'url', 'headers', 'scope'] : ['transport', 'name', 'command', 'args', 'env', 'realm', 'scope'];
}
type Draft = { transport: McpServerDraft['transport']; name: string; target: string; args: string[]; env: Record<string, string>; headers: Record<string, string>; realm: string;
  scope: McpServerDraft['scope'] };
const emptyDraft = (): Draft => ({ transport: 'stdio', name: '', target: '', args: [], env: {}, headers: {}, realm: '', scope: 'local' });
type View = Readonly<{ kind: 'list' } | { kind: 'detail'; name: string; lines: readonly PanelLine[] } | { kind: 'confirm'; name: string }
  | { kind: 'wizard'; step: WizardStep; problem?: string } | { kind: 'busy' } | { kind: 'question'; question: McpTrustQuestion }>;
/** Registry refusals of a name, checked before any trust card: the wizard goes back to its name step with the reason. */
const NAME_REFUSALS: ReadonlySet<string> = new Set(['MCP_SERVER_NAME_INVALID', 'MCP_SERVER_EXISTS']);

/** `NAME=value` (env) or `Name: value` (header); null when the pair has no name. */
export function mcpPair(text: string, separator: '=' | ':'): readonly [string, string] | null {
  const at = text.indexOf(separator);
  if (at < 1) return null;
  const name = text.slice(0, at).trim();
  return name && !/\s/u.test(name) ? [name, text.slice(at + 1).trim()] : null;
}
/** An argument as it is typed back: a part with spaces in quotes. */
const quoteArg = (arg: string) => /\s/u.test(arg) ? `"${arg}"` : arg;
/** Arguments as typed, split on whitespace; a quoted part keeps its spaces. */
export function mcpArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(match => match[1] ?? match[2] ?? match[3]!);
}

/**
 * `/mcp` as a window: the servers and their state, a server's detail, revoke / re-approve / reconnect / remove, and the add wizard
 * (transport → name → command or URL → env or headers, values masked → realm → scope → the trust windows). Every change goes through the
 * registry command the port binds; the trust windows are the human's decision (y / n; Esc records nothing).
 */
export function McpPanel({ port, labels, push, onError, errorText, onClose }: { readonly port: McpPanelPort; readonly labels: PanelLabels;
  readonly push: (notices: readonly PanelNotice[]) => void; readonly onError: (error: unknown) => void; readonly errorText: (error: unknown) => string; readonly onClose: () => void }) {
  const words = labels.mcp;
  const [list, setList] = useState<McpPanelList | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [state, setState] = useState<PickerState>(PICKER_INITIAL);
  const [generation, setGeneration] = useState(0);
  const draft = useRef<Draft>(emptyDraft());
  const answer = useRef<((value: boolean | null) => void) | null>(null);
  const room = usePickerRoom(1);
  const reload = useCallback(async () => { setList(await port.list()); }, [port]);
  const exits = useRef({ onError, onClose });
  exits.current = { onError, onClose };
  useEffect(() => { reload().catch(error => { exits.current.onError(error); exits.current.onClose(); }); }, [reload]);
  const back = (at: PickerState = PICKER_INITIAL) => { setState(at); setGeneration(value => value + 1); setView({ kind: 'list' }); };
  const ask = (question: McpTrustQuestion) => new Promise<boolean | null>(resolve => { answer.current = resolve; setView({ kind: 'question', question }); });
  const run = async (work: () => Promise<readonly string[]>) => {
    setView({ kind: 'busy' });
    try { push([{ level: 'info', text: (await work()).join('\n') }]); } catch (error) { onError(error); }
    try { await reload(); } catch (error) { onError(error); }
    back();
  };
  if (!list || view.kind === 'busy') return <Window title={[span(words.title)]} body={[{ spans: [span(labels.loading)] }]} hints={words.hints} position={labels.position} />;
  if (view.kind === 'question') return <QuestionWindow title={view.question.title} lines={view.question.lines} hints={view.question.prompt || words.trustKeys} position={labels.position}
    onAnswer={value => { const resolve = answer.current; answer.current = null; setView({ kind: 'busy' }); resolve?.(value); }} />;
  if (view.kind === 'detail') return <LinesWindow title={view.name} lines={view.lines} hints={words.hints} position={labels.position} onClose={() => back(state)} />;
  if (view.kind === 'confirm') return <QuestionWindow title={`${words.actions.remove}: ${view.name}`} lines={[]} hints={words.trustKeys} position={labels.position}
    onAnswer={value => { if (value) void run(() => port.remove(view.name)); else back(state); }} />;
  if (view.kind === 'wizard') return <McpWizard step={view.step} problem={view.problem ?? null} port={port} labels={labels} draft={draft.current}
    onStep={step => setView({ kind: 'wizard', step })} onCancel={() => back()}
    onDone={finished => { setView({ kind: 'busy' }); port.add(finished, ask).then(async lines => { push([{ level: 'info', text: lines.join('\n') }]);
      try { await reload(); } catch (error) { onError(error); } back(); }, error => {
      const code = String((error as { code?: unknown })?.code);
      if (NAME_REFUSALS.has(code)) { setView({ kind: 'wizard', step: 'name', problem: errorText(error) }); return; }
      // The registry refused the entry itself (e.g. plain http to another machine): back to its URL or command step, the other values kept.
      if (code === 'MCP_SERVER_ENTRY_INVALID') { setView({ kind: 'wizard', step: draft.current.transport === 'http' ? 'url' : 'command', problem: errorText(error) }); return; }
      onError(error); back();
    }); }} />;
  const chosen = (result: PickerResult, at: PickerState) => {
    if (result.kind !== 'selected') { onClose(); return; }
    if (result.id === ADD) { draft.current = emptyDraft(); setView({ kind: 'wizard', step: 'transport' }); return; }
    const [name, action] = result.path;
    if (!name || !action) { back(at); return; }
    if (action === 'detail') { setView({ kind: 'busy' }); port.detail(name).then(lines => setView({ kind: 'detail', name, lines }), error => { onError(error); back(at); }); return; }
    if (action === 'remove') { setView({ kind: 'confirm', name }); return; }
    void run(() => action === 'approve' ? port.approve(name, ask) : action === 'revoke' ? port.revoke(name) : port.reconnect(name));
  };
  const body: WindowLine[] = list.servers.length ? [] : [{ spans: [span(words.none, { role: 'muted' })] }];
  return <Window title={[span(words.title)]} body={[...body, ...list.problems.map(problem => ({ spans: [span(problem, { role: 'warning' })] }))]} hints={words.hints}
    position={labels.position} footerRows={room.footerRows} onInput={() => true}
    footer={focused => <ListPicker key={generation} tree={mcpPanelTree(list, words)} labels={labels.picker} active={focused} initial={state} onState={setState} maxRows={room.rows}
      onResult={result => chosen(result, state)} />} />;
}

function choiceTree(title: string, choices: readonly McpChoice[]): PickerTree {
  return { title, items: choices.map(choice => ({ id: choice.id, label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}),
    ...(choice.blocked ? { blocked: { reason: choice.blocked } } : {}) })) };
}

/** One wizard step: a choice list (transport, realm, scope) or a single-line entry (name, command/URL, arguments, env/header pairs). */
function McpWizard({ step, problem, port, labels, draft, onStep, onCancel, onDone }: { readonly step: WizardStep; readonly problem: string | null; readonly port: McpPanelPort; readonly labels: PanelLabels;
  readonly draft: Draft; readonly onStep: (step: WizardStep) => void; readonly onCancel: () => void; readonly onDone: (draft: McpServerDraft) => void }) {
  const words = labels.mcp, steps = mcpWizardSteps(draft.transport), index = steps.indexOf(step), hidden = useRenderGlyphs().ascii ? '***' : '•••';
  const title = `${words.add} · ${fillTemplate(words.step, { step: index + 1, steps: steps.length })} · ${words.steps[step]}`;
  const next = () => {
    const following = steps[index + 1];
    if (following) { onStep(following); return; }
    onDone({ transport: draft.transport, name: draft.name, target: draft.target, args: draft.args, env: draft.env, headers: draft.headers,
      realm: draft.transport === 'http' ? '' : draft.realm, scope: draft.scope });
  };
  const summary: WindowLine[] = [
    ...(draft.name ? [{ label: [span(words.steps.name, { bold: true })], spans: [span(draft.name)] }] : []),
    ...(draft.target ? [{ label: [span(draft.transport === 'http' ? words.steps.url : words.steps.command, { bold: true })], spans: [span(draft.target)], exact: true }] : []),
    ...(draft.args.length ? [{ label: [span(words.steps.args, { bold: true })], spans: [span(draft.args.map(quoteArg).join(' '))], exact: true }] : []),
    ...Object.keys(draft.env).map(name => ({ label: [span(words.steps.env, { bold: true })], spans: [span(`${name}=${hidden}`)] })),
    ...Object.keys(draft.headers).map(name => ({ label: [span(words.steps.headers, { bold: true })], spans: [span(`${name}: ${hidden}`)] }))];
  if (step === 'transport' || step === 'realm' || step === 'scope') {
    const choices = step === 'transport' ? port.transports : step === 'realm' ? port.realms : port.scopes;
    return <Window title={[span(title)]} body={summary} hints={words.hints} position={labels.position} footerRows={choices.length + 6} onInput={() => true}
      footer={focused => <ListPicker key={step} tree={choiceTree(words.steps[step], choices)} labels={labels.picker} active={focused} onResult={result => {
        if (result.kind !== 'selected') { onCancel(); return; }
        if (step === 'transport') draft.transport = result.id === 'http' ? 'http' : 'stdio';
        else if (step === 'realm') draft.realm = result.id;
        else draft.scope = result.id === 'project' || result.id === 'user' ? result.id : 'local';
        next();
      }} />} />;
  }
  const pair = step === 'env' ? '=' : step === 'headers' ? ':' : null;
  return <EntryWindow key={`${step}:${Object.keys(draft.env).length}:${Object.keys(draft.headers).length}`} title={title} body={summary}
    hints={words.entryHints[step]} position={labels.position} problem={problem} {...(pair ? { masked: { after: pair } } : {})}
    initial={step === 'name' ? draft.name : step === 'command' || step === 'url' ? draft.target : step === 'args' ? draft.args.map(quoteArg).join(' ') : ''}
    onCancel={onCancel} onSubmit={raw => {
      const text = raw.trim();
      if (step === 'name') { if (!text) return words.empty; draft.name = text; next(); return null; }
      if (step === 'command' || step === 'url') { if (!text) return words.empty; draft.target = text; next(); return null; }
      if (step === 'args') { draft.args = mcpArgs(text); next(); return null; }
      // env / headers: one pair per Enter; an empty Enter finishes the step.
      if (!text) { next(); return null; }
      const parsed = mcpPair(text, pair!);
      if (!parsed) return words.pairInvalid;
      (step === 'env' ? draft.env : draft.headers)[parsed[0]] = parsed[1];
      onStep(step);
      return null;
    }} />;
}
