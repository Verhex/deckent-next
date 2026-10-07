import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planMcpProposal } from '#adapters/index.js';
import { describeMcpProposal, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// L1 MCP-CORE item 5 (owner 2026-10-07): the model may only PROPOSE an MCP server. The proposal opens its own approval window in every mode —
// standart, full-auto and a full-access turn alike — and nothing is written without the person's yes; a yes adds the server to the project's
// local registry untrusted (its trust cards follow). Every string passes the model-ingress check.
// Security (owner, Jev 30efcb91: no secrets in a proposal): no env or header value, no `$DECK:`, `${VAR}` or `$VAR` anywhere; the model names the
// settings it needs and a person binds them in /mcp.
afterEach(async () => { await closeModeRuntimes(); });
const PROPOSE = rule('propose', 'agent-tool', ['propose_mcp_server'], 'allow');
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const proposal = { name: 'docs-search', transport: 'stdio', command: 'npx', args: ['-y', '@example/docs-mcp'], requiredSettings: ['DOCS_TOKEN'], reason: 'Search the library docs' };
const personal = (f: { env: { HOME: string } }) => join(f.env.HOME, '.deckent', 'mcp.json');
const registered = (f: { env: { HOME: string } }) => existsSync(personal(f)) ? readFileSync(personal(f), 'utf8') : null;

describe('a proposal is checked before anything is shown (pure)', () => {
  it('no secret and no reference anywhere; setting names only; a valid name; every string through the ingress check', () => {
    expect(planMcpProposal(proposal)).toEqual({ ok: true, proposal, entry: { command: 'npx', args: ['-y', '@example/docs-mcp'], realm: 'sandbox-net' } });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:GITHUB_TOKEN' }, reason: 'r' }))
      .toEqual({ ok: false, reason: 'secrets-bound-by-person' });
    expect(planMcpProposal({ ...proposal, env: { AWS_SECRET_ACCESS_KEY: '${AWS_SECRET_ACCESS_KEY}' } })).toEqual({ ok: false, reason: 'secrets-bound-by-person' });
    expect(planMcpProposal({ ...proposal, env: { DOCS_TOKEN: 'ghp_literal' } })).toEqual({ ok: false, reason: 'secrets-bound-by-person' });
    for (const url of ['https://mcp.example.com/mcp?key=$DECK:K', 'https://${HOST}/mcp', 'https://mcp.example.com/$TOKEN'])
      expect(planMcpProposal({ name: 'web', transport: 'http', url, reason: 'r' })).toEqual({ ok: false, reason: 'secrets-bound-by-person' });
    expect(planMcpProposal({ ...proposal, args: ['--token', '${GITHUB_TOKEN}'] })).toEqual({ ok: false, reason: 'secrets-bound-by-person' });
    expect(planMcpProposal({ ...proposal, requiredSettings: ['NOT A NAME'] })).toEqual({ ok: false, reason: 'invalid-setting-name' });
    expect(planMcpProposal({ ...proposal, name: 'Docs_Search' })).toEqual({ ok: false, reason: 'invalid-name' });
    expect(planMcpProposal({ ...proposal, reason: 'Search\u202Ethe docs' })).toEqual({ ok: false, reason: 'ingress-refused:reason' });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'https://mcp.example.com/mcp', requiredSettings: ['Authorization'], reason: 'r' }))
      .toMatchObject({ ok: true, entry: { type: 'http', url: 'https://mcp.example.com/mcp' } });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'http://mcp.example.com/mcp', reason: 'r' })).toEqual({ ok: false, reason: 'url-insecure-remote' });
    expect(planMcpProposal({ name: 'web', transport: 'http', url: 'https://x/mcp', command: 'node', reason: 'r' })).toEqual({ ok: false, reason: 'invalid-entry' });
    const text = describeMcpProposal(proposal as never, 'model chat', 'tr');
    expect(text).toContain('Öneren: model chat'); expect(text).toContain("Gereken ayarlar (yalnız adlar; eklendikten sonra /mcp'de siz bağlarsınız): DOCS_TOKEN");
    expect(describeMcpProposal(proposal as never, 'model chat', 'en')).toMatch(/^The model proposes adding an MCP server\. Nothing is written unless you approve\./u);
    expect(describeMcpProposal({ ...proposal, realm: 'host' } as never, 'model chat', 'en')).toContain('Warning: the model asks to run it on the host, outside any sandbox');
    expect(describeMcpProposal(proposal as never, 'model chat', 'en')).not.toContain('Warning:');
  });
});

describe.skipIf(process.platform !== 'linux')('the proposal window in every mode (real runtime service)', () => {
  it('standart: the window opens; a no writes nothing; a yes adds the server untrusted', async () => {
    const f = await modeRuntime({ grants: [PROPOSE], mode: null });
    const declined = await f.call('propose_mcp_server', proposal, 'deny');
    expect(declined).toMatchObject({ card: true, status: 'error' }); expect(declined.text).toContain('the person declined; nothing was written');
    expect(registered(f)).toBeNull();
    const preview = declined.events.flatMap(event => event.kind === 'approval.requested' ? [event.preview] : [])[0]!;
    expect(preview).toContain('Name: docs-search'); expect(preview).toContain('Settings it needs (names only; you bind them in /mcp after adding): DOCS_TOKEN');
    const approved = await f.call('propose_mcp_server', proposal, 'allow');
    expect(approved).toMatchObject({ card: true, status: 'ok' }); expect(approved.text).toContain('untrusted');
    expect(await runConfiguredMcpCommand(f.project, { verb: 'list', health: false }, { env: f.env }, async () => null)).toMatchObject({ servers: [{ name: 'docs-search', scope: 'local',
      status: 'pending-approval', realm: 'sandbox-net', envNames: [] }] });
    // The registry holds no value and no reference: the person binds DOCS_TOKEN in /mcp.
    expect(registered(f)).not.toContain('DOCS_TOKEN'); expect(registered(f)).not.toContain('$');
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

  it('a secret or a reference is refused before any window, also in a full-access turn; without a policy grant the model cannot propose at all', async () => {
    const f = await modeRuntime({ grants: [PROPOSE, FULL_ACCESS], mode: null });
    const header = await f.call('propose_mcp_server', { name: 'web', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:GITHUB_TOKEN' }, reason: 'r' }, 'allow');
    expect(header).toMatchObject({ card: false, status: 'error' }); expect(header.text).toContain('secrets are bound by a person in /mcp');
    const env = await f.call('propose_mcp_server', { ...proposal, env: { AWS_SECRET_ACCESS_KEY: '${AWS_SECRET_ACCESS_KEY}' } }, 'allow', { fullAccess: true });
    expect(env).toMatchObject({ card: false, status: 'error' }); expect(env.text).toContain('secrets-bound-by-person');
    const url = await f.call('propose_mcp_server', { name: 'web', transport: 'http', url: 'https://mcp.example.com/mcp?token=$DECK:GITHUB_TOKEN', reason: 'r' }, 'allow', { fullAccess: true });
    expect(url).toMatchObject({ card: false, status: 'error' }); expect(url.text).toContain('secrets-bound-by-person');
    expect(registered(f)).toBeNull();
    const none = await modeRuntime({ grants: [], mode: null });
    const denied = await none.call('propose_mcp_server', proposal, 'allow');
    expect(denied.card).toBe(false); expect(denied.status).not.toBe('ok'); expect(registered(none)).toBeNull();
  }, 120_000);
});
