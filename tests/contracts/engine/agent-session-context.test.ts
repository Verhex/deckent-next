import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_SURFACES, AGENT_TURN_SYSTEM_PROMPT_VERSION, SESSION_STATE_TOOL_SPEC, agentSessionSnapshot, agentSessionStateText, createInlineReasoningRouter, decideAgentToolCall,
  renderAgentSessionContext, renderAgentTurnSystemPrompt, runAgentTurn, splitInlineReasoning, type AgentRoundOutcome, type AgentSessionCell, type AgentTurnPorts } from '#engine/index.js';
import { firstRunPolicyTemplate, resolvePolicyBindings, type AgentToolSpec, type AgentTurnEvent } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES } from '#engine/core/installation/index.js';
import { WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';
import { resolveProductLayout } from '#platform/index.js';

// NATIVE-BAGLAM (owner 2026-10-14, beta gate 3): the model is told where it is and what it can do — descriptively. The block is computed from
// the policy engine's own decisions on one snapshot and never feeds back into them.
const person = { issuer: 'host', subject: 'owner' };
const principal = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['scope'] };
const spec = (name: string, toolClass: AgentToolSpec['toolClass']): AgentToolSpec => ({ name, version: 1, toolClass, description: name, inputSchema: { type: 'object', properties: {} } });
const TOOLS = [spec('read_file', 'read'), spec('list_dir', 'read'), spec('grep', 'read'), spec('glob', 'read'), spec('edit_file', 'edit'), spec('write_file', 'edit'),
  spec('run_shell', 'shell'), spec('scratch_write', 'edit'), spec('scratch_read', 'read'), spec('scratch_list', 'read'), spec('propose_mcp_server', 'read'), SESSION_STATE_TOOL_SPEC];
const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: person, ...FIRST_RUN_TOOL_NAMES });
const FULL_ACCESS = { id: 'company-full-access', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: [person], resource: { kind: 'permission-mode', ids: ['full-access'] } };
const SESSION_GRANT = { id: 'session-state', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [person], resource: { kind: 'agent-tool', ids: ['session_state'] } };
type Mode = 'standart' | 'full-auto' | 'full-access';
const policyOf = (mode: Mode | null, grants: readonly unknown[] = [SESSION_GRANT, FULL_ACCESS]) => resolvePolicyBindings({ ...template.policy, grants: [...template.policy.grants, ...grants] },
  { schemaVersion: 3, revision: `b-${mode ?? 'none'}`, bindings: [], modes: mode ? [{ id: 'me', principal: person, scopes: ['scope'], mode }] : [] });
// The composition's operation map (the effect each tool's call is): the decision itself is the policy engine's.
const operation = (tool: AgentToolSpec) => tool.name === 'scratch_write' ? 'workspace.scratch.write' : tool.toolClass === 'edit' ? 'workspace.file.write' : tool.toolClass === 'shell' ? 'host.shell.run' : null;
const decide = (policy: unknown, fullAccess: boolean) => async (tool: AgentToolSpec, cell: AgentSessionCell, shell?: { readonly realm: 'sandbox' | 'host'; readonly contained: true }) =>
  decideAgentToolCall(policy, { principal, scopeId: 'scope', tool, operation: operation(tool) ? { id: operation(tool)! } : null, cell, ...(shell ? { shell } : {}), ...(fullAccess ? { fullAccess } : {}) }).decision;
async function snapshot(mode: Mode | null, options: { fullAccess?: boolean; thinking?: 'on' | 'off' | 'model-default'; policy?: unknown; tools?: readonly AgentToolSpec[] } = {}) {
  const policy = options.policy === undefined ? policyOf(mode) : options.policy, fullAccess = options.fullAccess ?? false;
  return agentSessionSnapshot({ policy, principal, scopeId: 'scope', sessionId: 'session-1', fullAccess, thinking: options.thinking ?? 'on', tools: options.tools ?? TOOLS,
    shell: { kind: 'sandbox', realm: 'bubblewrap', open: fullAccess, ...(fullAccess ? { configuration: 'read-only' as const } : {}) } as never,
    model: { nativeId: 'Qwen3.8-27B', providerId: 'local-openai', modelId: 'chat', protocols: [{ family: 'openai-chat-completions',
      capabilities: [{ id: 'tool-calls', state: 'supported' }, { id: 'chat-template-enable-thinking', state: 'supported' }, { id: 'token-count', state: 'unknown' }] }] },
    decide: decide(policy, fullAccess) });
}
const line = (block: string, prefix: string) => block.split('\n').find(row => row.startsWith(prefix)) ?? '';

describe('session context block per mode', () => {
  it('standart: mode and meaning, thinking, declared capabilities, computed effects, surfaces and the hard rules', async () => {
    const block = renderAgentSessionContext(await snapshot('standart'));
    expect(line(block, '- Where:')).toBe(`- Where: Deckent ${(await snapshot('standart')).deckent} operator terminal; scope scope; session session-1.`);
    expect(line(block, '- Permission mode:')).toMatch(/^- Permission mode: standart — reads run at once;.*Only the person changes it \(\/mode or Shift\+Tab\)\.$/u);
    expect(line(block, '- Thinking:')).toBe('- Thinking: on (the person switches it with /reasoning).');
    // Only what the catalog declares supported is named.
    expect(line(block, '- Model capabilities')).toBe('- Model capabilities (catalog declaration): openai-chat-completions: tool-calls, chat-template-enable-thinking.');
    const calls = line(block, '- Calls now');
    expect(calls).toContain('read_file, list_dir, grep, glob, scratch_write, scratch_read, scratch_list, session_state: runs at once');
    // The MCP proposal is allowed by policy but always opens the person's window: it is told as asking.
    // first-run template: edits and the shell are require-approval + modeEligible; standart lowers an ordinary edit only.
    expect(calls).toContain('edit_file, write_file: an ordinary file runs at once; a protected path asks the person');
    expect(calls).toContain('run_shell, propose_mcp_server: asks the person');
    for (const surface of ['/do <goal>', '/runs', '/approvals', '/deliver', '/mode']) expect(block).toContain(surface);
    expect(block).toContain('You never decide approvals or grant authority');
    expect(block).toContain('MCP servers and their tools cannot decide approvals or change policy');
    expect(block).toContain('session_state returns this context fresh as JSON.');
  });

  it('full-auto: contained sandbox commands run, destructive ones still ask; full-access: the launch grant, configuration still asks', async () => {
    const auto = renderAgentSessionContext(await snapshot('full-auto'));
    expect(line(auto, '- Permission mode:')).toContain('- Permission mode: full-auto — ');
    expect(line(auto, '- Calls now')).toContain('run_shell: a read-only command runs at once; a narrow change runs at once; a destructive command asks the person');
    const full = renderAgentSessionContext(await snapshot('standart', { fullAccess: true }));
    expect(line(full, '- Permission mode:')).toContain('full-access — this session holds the company\'s full-access grant');
    // The launch grant lowers the floor raise too (the configuration file and pinned MCP tools stay asking, as the meaning says).
    expect(line(full, '- Calls now')).toContain('edit_file, write_file, run_shell, scratch_write');
    // Bounded (owner target < ~1.5k tokens; ~4 characters per English token): the largest mode stays well under 6000 characters.
    for (const block of [auto, full]) expect(block.length).toBeLessThan(6000);
    // A stored full-access start mode without a launched full-access turn reads as standart (the decision's own reading).
    expect((await snapshot('full-access')).mode?.name).toBe('standart');
  });

  it('thinking off and an unswitchable model are named; an unreadable policy says unknown and every call refused', async () => {
    expect(line(renderAgentSessionContext(await snapshot('standart', { thinking: 'off' })), '- Thinking:')).toBe('- Thinking: off (the person switches it with /reasoning).');
    expect(line(renderAgentSessionContext(await snapshot('standart', { thinking: 'model-default' })), '- Thinking:')).toContain('cannot be switched off');
    const broken = await snapshot('standart', { policy: null });
    expect(broken.mode).toBeNull();
    expect(broken.tools.flatMap(tool => tool.effects.map(entry => entry.effect))).toEqual(broken.tools.flatMap(tool => tool.effects.map(() => 'refused')));
  });

  it('is stable: equal inputs render byte-identical blocks and the JSON tool result carries the same facts', async () => {
    const [a, b] = [await snapshot('standart'), await snapshot('standart')];
    expect(renderAgentSessionContext(a)).toBe(renderAgentSessionContext(b));
    const parsed = JSON.parse(agentSessionStateText(a)) as { mode: { name: string }; tools: { name: string }[]; rules: string[] };
    expect(parsed.mode.name).toBe('standart'); expect(parsed.tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name)); expect(parsed.rules).toEqual(a.rules);
  });

  it('every surface the model may suggest is a real terminal slash command', () => {
    const registry = new Set(WORKLINE_SLASH_COMMANDS.map(command => `/${command.name}`));
    for (const [command] of AGENT_SESSION_SURFACES) expect(registry.has(command.split(' ')[0]!)).toBe(true);
  });

  it('joins the v10 system prompt only when given, after the tools and before the working style', async () => {
    const base = { projectRoot: '/p', layout: resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/data' }), tools: TOOLS, language: 'tr' as const,
      model: { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1, nativeId: 'Qwen3.8-27B' } };
    const without = renderAgentTurnSystemPrompt(base), withSession = renderAgentTurnSystemPrompt({ ...base, session: await snapshot('standart') });
    expect(AGENT_TURN_SYSTEM_PROMPT_VERSION).toBe(10);
    expect(without).not.toContain('Session context v1');
    expect(withSession.indexOf('Session context v1')).toBeGreaterThan(withSession.indexOf('\nTools:\n'));
    expect(withSession.indexOf('Session context v1')).toBeLessThan(withSession.indexOf('\nWorking style:\n'));
    expect(withSession).toContain('- Keep your reasoning out of the answer');
    expect(withSession.split('\n').at(-1)).toBe('- Write every reply to the user in Turkish (Türkçe).');
  });
});

describe('no authority widening', () => {
  // The decision matrix a turn uses (every tool, every representative cell, every mode, with and without the full-access launch) is the
  // same whether or not a snapshot was computed over the same policy: the snapshot only reads decisions, it never stores or changes one.
  it('computing the snapshot changes no decision, and session_state has no default grant', async () => {
    const matrix = async () => {
      const rows: string[] = [];
      for (const mode of ['standart', 'full-auto', 'full-access', null] as const) for (const fullAccess of [false, true]) for (const tool of TOOLS)
        for (const cell of ['read', 'edit', 'edit-floor', 'shell-read-none', 'shell-narrow-mutating', 'shell-destructive', 'mcp-call'] as const)
          rows.push(`${mode}/${fullAccess}/${tool.name}/${cell}=${await decide(policyOf(mode), fullAccess)(tool, cell, { realm: 'sandbox', contained: true })}`);
      return rows;
    };
    const before = await matrix();
    for (const mode of ['standart', 'full-auto', 'full-access', null] as const) await snapshot(mode, { fullAccess: mode === 'full-access' });
    expect(await matrix()).toEqual(before);
    // The first-run template is unchanged: session_state is decided like any tool, and without an explicit grant it is denied.
    expect(JSON.stringify(template.policy)).not.toContain('session_state');
    expect(decideAgentToolCall(policyOf('standart', []), { principal, scopeId: 'scope', tool: SESSION_STATE_TOOL_SPEC, operation: null, cell: 'read' }).decision).toBe('deny');
  });
});

describe('inline reasoning never becomes the answer', () => {
  const texts = ['<think>plan the edit\nin English</think>\n\nCevap: tamam.', '  <think>a</think>b', '<think>never closed', 'plain answer mentioning <think> tags',
    '<thin', '<think></think>', 'x', '', '<think>a</thi', '\n\n<think>r</think>   \n'];
  it('a streamed split in any chunking equals the settled split, and nothing shown is taken back', () => {
    for (const text of texts) for (let size = 1; size <= Math.max(1, text.length); size++) {
      const router = createInlineReasoningRouter(), shown = { text: '', reasoning: '' };
      const take = (parts: readonly { kind: 'text' | 'reasoning'; text: string }[]) => { for (const part of parts) shown[part.kind === 'text' ? 'text' : 'reasoning'] += part.text; };
      for (let at = 0; at < text.length; at += size) take(router.push(text.slice(at, at + size)));
      take(router.finish());
      const settled = splitInlineReasoning(text);
      expect({ text: shown.text, reasoning: shown.reasoning }).toEqual({ text: settled.content, reasoning: settled.reasoning });
    }
    expect(splitInlineReasoning('plain answer mentioning <think> tags')).toEqual({ content: 'plain answer mentioning <think> tags', reasoning: '' });
  });

  it('the turn answer, history and text events carry no inline reasoning; it reaches the reasoning events', async () => {
    const raw = '<think>The user asks which mode. I should check.</think>\n\nŞu an standart moddasınız.';
    const outcome: AgentRoundOutcome = { status: 'responded', content: raw, reasoning: '', toolCalls: [], finish: 'stop', usage: null };
    const ports: AgentTurnPorts = { async invokeRound(_input, onDelta) { for (let at = 0; at < raw.length; at += 5) onDelta({ kind: 'text', text: raw.slice(at, at + 5) }); return outcome; },
      async authorize() { return 'allow'; }, describe() { return null; }, async execute() { return { status: 'ok', text: '' }; }, now: () => 1 };
    const events: AgentTurnEvent[] = [];
    const result = await runAgentTurn({ messages: [{ role: 'user', content: 'hangi moddayız' }], tools: [], signal: new AbortController().signal, emit: event => events.push(event) }, ports);
    const text = events.flatMap(event => event.kind === 'text' ? [event.text] : []).join(''), reasoning = events.flatMap(event => event.kind === 'reasoning' ? [event.text] : []).join('');
    expect(text).toBe('Şu an standart moddasınız.'); expect(reasoning).toBe('The user asks which mode. I should check.');
    expect(result.answer).toBe('Şu an standart moddasınız.');
    expect(JSON.stringify(events.filter(event => event.kind === 'message'))).not.toContain('<think>');
  });
});
