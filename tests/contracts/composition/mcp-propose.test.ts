import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planMcpProposal } from '#adapters/index.js';
import { describeMcpProposal, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// L1 MCP-CORE item 5 (owner 2026-10-07): the model may only PROPOSE an MCP server. The proposal opens its own approval window in every mode —
// standart, full-auto and a full-access turn alike — and nothing is written without the person's yes; a yes adds the server to the project's
// local registry untrusted (its trust cards follow). Every string passes the model-ingress check; env/header values may only be references.
afterEach(async () => { await closeModeRuntimes(); });
const PROPOSE = rule('propose', 'agent-tool', ['propose_mcp_server'], 'allow');
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const proposal = { name: 'docs-search', transport: 'stdio', command: 'npx', args: ['-y', '@example/docs-mcp'], env: { DOCS_TOKEN: '$DECK:DOCS_TOKEN' }, reason: 'Search the library docs' };
const personal = (f: { env: { HOME: string } }) => join(f.env.HOME, '.deckent', 'mcp.json');
const registered = (f: { env: { HOME: string } }) => existsSync(personal(f)) ? readFileSync(personal(f), 'utf8') : null;

describe('a proposal is checked before anything is shown (pure)', () => {
  it('references only, names only on the window, a valid name, every string through the ingress check', () => {
    expect(planMcpProposal(proposal)).toMatchObject({ ok: true, entry: { command: 'npx', args: ['-y', '@example/docs-mcp'], env: { DOCS_TOKEN: '$DECK:DOCS_TOKEN' }, realm: 'sandbox-net' } });
    expect(planMcpProposal({ ...proposal, env: { DOCS_TOKEN: 'ghp_literalsecret' } })).toEqual({ ok: false, reason: 'literal-value:DOCS_TOKEN' });
    expect(planMcpProposal({ ...proposal, name: 'Docs_Search' })).toEqual({ ok: false, reason: 'invalid-name' });
    expect(planMcpProposal({ ...proposal, reason: 'Search‮the docs' })).toEqual({ ok: false, reason: 'ingress-refused:reason' });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:WEB' }, reason: 'r' })).toMatchObject({ ok: true });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'http://mcp.example.com/mcp', reason: 'r' })).toEqual({ ok: false, reason: 'url-insecure-remote' });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'https://x/mcp', command: 'node', reason: 'r' })).toEqual({ ok: false, reason: 'invalid-entry' });
    const text = describeMcpProposal(planMcpProposal(proposal).ok ? proposal as never : never(), 'model chat', 'tr');
    expect(text).toContain('Öneren: model chat'); expect(text).toContain('Ortam değişkeni adları: DOCS_TOKEN'); expect(text).not.toContain('$DECK:DOCS_TOKEN');
    expect(describeMcpProposal(proposal as never, 'model chat', 'en')).toMatch(/^The model proposes adding an MCP server\. Nothing is written unless you approve\./u);
  });
});
function never(): never { throw new Error('unreachable'); }

describe.skipIf(process.platform !== 'linux')('the proposal window in every mode (real runtime service)', () => {
  it('standart: the window opens; a no writes nothing; a yes adds the server untrusted', async () => {
    const f = await modeRuntime({ grants: [PROPOSE], mode: null });
    const declined = await f.call('propose_mcp_server', proposal, 'deny');
    expect(declined).toMatchObject({ card: true, status: 'error' }); expect(declined.text).toContain('the person declined; nothing was written');
    expect(registered(f)).toBeNull();
    const preview = declined.events.flatMap(event => event.kind === 'approval.requested' ? [event.preview] : [])[0]!;
    expect(preview).toContain('Name: docs-search'); expect(preview).toContain('Environment variable names: DOCS_TOKEN'); expect(preview).not.toContain('$DECK:');
    const approved = await f.call('propose_mcp_server', proposal, 'allow');
    expect(approved).toMatchObject({ card: true, status: 'ok' }); expect(approved.text).toContain('untrusted');
    expect(await runConfiguredMcpCommand(f.project, { verb: 'list', health: false }, { env: f.env }, async () => null)).toMatchObject({ servers: [{ name: 'docs-search', scope: 'local',
      status: 'pending-approval', realm: 'sandbox-net' }] });
  }, 120_000);

  it('full-auto and a full-access turn still open the window; a no writes nothing in either', async () => {
    // Policy allows the call itself (no generic card): what opens is the proposal's own window, which no mode lowers.
    const auto = await modeRuntime({ grants: [PROPOSE], mode: 'full-auto' });
    const lowered = await auto.call('propose_mcp_server', proposal, 'deny');
    expect(lowered.events.filter(event => event.kind === 'approval.requested').map(event => event.summary)).toEqual([expect.stringMatching(/^propose_mcp_server · mcp:docs-search · proposal/u)]);
    expect(lowered.text).toContain('nothing was written'); expect(registered(auto)).toBeNull();
    const full = await modeRuntime({ grants: [PROPOSE, FULL_ACCESS], mode: null });
    const open = await full.call('propose_mcp_server', proposal, 'deny', { fullAccess: true });
    expect(open.card).toBe(true); expect(open.text).toContain('nothing was written'); expect(registered(full)).toBeNull();
  }, 120_000);

  it('a literal secret is refused before any window; without a policy grant the model cannot propose at all', async () => {
    const f = await modeRuntime({ grants: [PROPOSE], mode: null });
    const literal = await f.call('propose_mcp_server', { ...proposal, env: { DOCS_TOKEN: 'ghp_literal' } }, 'allow');
    expect(literal).toMatchObject({ card: false, status: 'error' }); expect(literal.text).toContain('literal-value:DOCS_TOKEN'); expect(registered(f)).toBeNull();
    const none = await modeRuntime({ grants: [], mode: null });
    const denied = await none.call('propose_mcp_server', proposal, 'allow');
    expect(denied.card).toBe(false); expect(denied.status).not.toBe('ok'); expect(registered(none)).toBeNull();
  }, 120_000);
});
