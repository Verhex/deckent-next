import { expect, it } from 'vitest';
import { chatTurnApprovalPreview } from '#composition/core/agent-turn/index.js';
import type { AgentToolSpec, AgentTurnMessage } from '#domain/index.js';
import { projectModelIngressField, runAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
import { t } from '#platform/index.js';
import { modelIngressNotice } from '#surfaces/core/terminal-render/index.js';

const readFile: AgentToolSpec = { name: 'read_file', version: 1, toolClass: 'read', description: 'Read a file.',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
const call = { id: 'c1', name: 'read_file', argumentsJson: JSON.stringify({ path: 'note.txt' }) };
const answer = (content: string, toolCalls: readonly { id: string; name: string; argumentsJson: string }[] = []): AgentRoundOutcome =>
  ({ status: 'responded', content, reasoning: '', toolCalls, finish: toolCalls.length ? 'tool_calls' : 'stop', usage: { promptTokens: 1, completionTokens: 1 } });

function harness(rounds: AgentRoundOutcome[], options: { fullAccess?: boolean; approval?: 'allow' | 'deny' } = {}) {
  const seen: AgentTurnMessage[][] = [];
  const approvals: string[] = [];
  const ports: AgentTurnPorts = {
    async invokeRound(input) { seen.push(input.messages.map(message => ({ ...message }))); return rounds[input.round - 1] ?? answer('done'); },
    async authorize() { return 'allow'; },
    describe() { return 'note.txt'; },
    async execute() { return { status: 'ok', text: `file ${payload}` }; },
    now: () => 1,
    async requestApproval() { approvals.push('asked'); return options.approval ?? 'deny'; },
  };
  return { ports, seen, approvals, fullAccess: options.fullAccess === true };
}

const lrm = 'hello\u200Eworld';
const tags = Array.from('pwn', char => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('');
let payload = 'plain';

it('leaves ordinary user and tool text unchanged on the way to the model', async () => {
  payload = 'plain file';
  const { ports, seen } = harness([answer('ok')]);
  await runAgentTurn({ messages: [{ role: 'user', content: 'hello' }], tools: [readFile], signal: new AbortController().signal, emit() {} }, ports);
  expect(seen[0]?.[0]).toEqual({ role: 'user', content: 'hello' });
  expect(projectModelIngressField('hello').disposition).toBe('unchanged');
  expect(projectModelIngressField('hello').modelText).toBe('hello');
});

it('marks a bidi mark in the model request and shows the same warning in English and Turkish', async () => {
  const { ports, seen } = harness([answer('ok')]);
  await runAgentTurn({ messages: [{ role: 'user', content: lrm }], tools: [readFile], signal: new AbortController().signal, emit() {} }, ports);
  const sent = seen[0]?.[0]?.content ?? '';
  const prefix = projectModelIngressField(lrm).fieldDigest.slice(0, 12);
  expect(sent).toContain('hello');
  expect(sent).toContain('world');
  expect(sent).not.toContain('\u200E');
  expect(sent).toContain(`[hidden-unicode: 1 cp,`);
  expect(sent).toContain(prefix);
  expect(sent).toBe(projectModelIngressField(lrm).modelText);
  expect(modelIngressNotice(sent, t('terminal.safety.hiddenCount', {}, 'en'))).toBe('1 hidden characters');
  expect(modelIngressNotice(sent, t('terminal.safety.hiddenCount', {}, 'tr'))).toBe('1 gizli karakter');
  const rawCard = `read_file ${JSON.stringify({ path: lrm }, null, 2)}`;
  const card = chatTurnApprovalPreview('read_file', { path: lrm });
  expect(card).toBe(projectModelIngressField(rawCard).modelText);
  expect(card).not.toContain('\u200E');
  expect(modelIngressNotice(card, t('terminal.safety.hiddenCount', {}, 'en'))).toBe('1 hidden characters');
  expect(modelIngressNotice(card, t('terminal.safety.hiddenCount', {}, 'tr'))).toBe('1 gizli karakter');
  const zwnj = projectModelIngressField('a\u200Cb');
  expect(zwnj.disposition).toBe('note');
  expect(zwnj.modelText).toContain('U+200C');
  expect(zwnj.modelText).not.toContain('\u200C');
  expect(zwnj.decoded).toBe('');
});

it('quarantines a tag payload outside the model and does not pause a full-access turn', async () => {
  const typed = harness([answer('ok')]);
  await runAgentTurn({ messages: [{ role: 'user', content: `see ${tags}` }], tools: [readFile], signal: new AbortController().signal, emit() {} }, typed.ports);
  expect(typed.approvals).toEqual([]);
  expect(typed.seen[0]?.[0]?.content ?? '').toContain('result withheld');
  expect(typed.seen[0]?.[0]?.content ?? '').not.toContain('pwn');
  payload = `secret ${tags} tail`;
  const paused = harness([answer('', [call]), answer('done')], { approval: 'allow' });
  const events: string[] = [];
  await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], tools: [readFile], signal: new AbortController().signal,
    emit: event => { if (event.kind === 'message' && event.message.role === 'tool') events.push(event.message.content); } }, paused.ports);
  expect(paused.approvals).toEqual(['asked']);
  expect(events[0]).toContain('secret');
  expect(events[0]).toContain('[hidden-unicode:');
  expect(events[0]).not.toContain('pwn');
  const open = harness([answer('', [call]), answer('done')], { fullAccess: true, approval: 'allow' });
  const shown: string[] = [];
  await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], tools: [readFile], fullAccess: true, signal: new AbortController().signal,
    emit: event => { if (event.kind === 'message' && event.message.role === 'tool') shown.push(event.message.content); } }, open.ports);
  expect(open.approvals).toEqual([]);
  expect(shown[0]).toContain('result withheld');
  expect(shown[0]).not.toContain('pwn');
  expect(projectModelIngressField(payload).decoded).toBe('pwn');
  expect(shown[0]).not.toContain(projectModelIngressField(payload).decoded);
  const round = open.seen[1]?.find(message => message.role === 'tool');
  expect(round && round.role === 'tool' ? round.content : '').toBe(shown[0]);
});

it('records an ingress notice only for a flagged field and settles the text the model saw (rebase check)', async () => {
  const recorded: string[] = [], settled: string[] = [];
  payload = 'plain file';
  const plain = harness([answer('', [call]), answer('done')]);
  await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], tools: [readFile], signal: new AbortController().signal, emit() {} },
    { ...plain.ports, async recordIngress(notice) { recorded.push(notice.disposition); }, async settled(entry) { settled.push(entry.content); } });
  expect(recorded).toEqual([]);
  expect(settled).toEqual(['file plain file']);
  payload = `a${'‎'}b`;
  const marked = harness([answer('', [call]), answer('done')]);
  await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], tools: [readFile], signal: new AbortController().signal, emit() {} },
    { ...marked.ports, async recordIngress(notice) { recorded.push(notice.disposition); }, async settled(entry) { settled.push(entry.content); } });
  expect(recorded).toEqual(['note']);
  expect(settled[1]).toContain('[hidden-unicode:');
  expect(settled[1]).not.toContain('‎');
});

it('withholds the field when the ingress record cannot be written', async () => {
  const run = harness([answer('ok')]);
  await runAgentTurn({ messages: [{ role: 'user', content: 'x‎y' }], tools: [readFile], signal: new AbortController().signal, emit() {} },
    { ...run.ports, async recordIngress() { throw new Error('audit down'); } });
  expect(run.seen[0]?.[0]?.content).toContain('result withheld');
});
