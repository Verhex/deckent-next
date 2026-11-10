import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planMcpProposal } from '#adapters/index.js';
import { describeMcpProposal, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { closeModeRuntimes, me, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { aiSettingResourceIds, firstRunProposalRules, proposalCoverageGrants, mcpPrincipalRef, type AgentTurnStreamEvent } from '#domain/index.js';
import { openSqliteApprovalStore, withMcpPrincipal } from '#adapters/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { planServiceRun } from '#composition/core/run-planner/index.js';
import { proposeConfiguredRun } from '#composition/core/runs/index.js';
import { proposalFixture } from '../support/run-proposal.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import type { PlanServiceRun } from '#composition/core/agent-turn/index.js';

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
// alpha.64 B + C (owner S4/S5/S6): the AI actor's v20 rules (require-approval, never `modeEligible`) beside the person's own config `allow`, which the
// proposals must never use (the API loop's turn principal is the person: every proposal call runs as the AI actor).
const AI = mcpPrincipalRef(me[0]!), PERSON_CONFIG = { id: 'person-config', effect: 'allow', actions: ['write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } };
const AI_SETTING = { id: 'ai-setting', effect: 'require-approval', actions: ['write'], scopes: 'all', principals: [AI], resource: { kind: 'config', ids: [...aiSettingResourceIds()] } };
// The MCP actor's scope membership comes from its scoped rules (a first-run policy's v9 observation does it; here one scope read).
const AI_SCOPE = { id: 'ai-scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [AI], resource: { kind: 'scope', ids: ['scope'] } };
// The first-run v9 observation the MCP actor holds (run admission reads its budget account; the plan inspects its Run).
const AI_OBSERVE = ['run', 'approval', 'model-activation', 'model-invocation', 'provider-spend-account'].map(kind => ({ id: `ai-observe-${kind}`, effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [AI], resource: { kind, ids: 'all' } }));
// The template's v20 delta itself (Run create and settings at require-approval; pool and work-target use at allow, lead 2026-11-09 option 2).
const V20 = firstRunProposalRules([], me[0]!, ['scope']).wanted as unknown as Record<string, unknown>[];
// The v19 model call the MCP actor holds (its plan's Brain call runs as it).
const AI_INVOKE = { id: 'ai-invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [AI], resource: { kind: 'model-invocation', ids: 'all' } };
const config = (f: { project: string }) => JSON.parse(readFileSync(join(f.project, '.deckent', 'config.json'), 'utf8')) as Record<string, unknown>;
const cardOf = (events: readonly AgentTurnStreamEvent[]) => events.find((event): event is Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }> => event.kind === 'approval.requested');
/** The service's plan port for `propose_work` as the real Run proposal application and run admission (a fixed human-source plan instead of a Brain
 * call): the principal is whoever calls it, i.e. the AI actor `propose_work` runs it as. */
const realPlan: PlanServiceRun = async (root, command, options, _invoke, _signal, observe) => {
  // v31: a Brain quota wait, as the planning application reports it, then planning again; the turn carries both as `work` events.
  observe?.({ kind: 'quota-wait', attempt: 2, maxAttempts: 3, resetsAtMs: 1_000, untilMs: 2_000, after: { commandId: command.commandId, invocationId: 'refused' } }); observe?.({ kind: 'planning', attempt: 2 });
  const { principal } = await loadConfiguredScopeContext(root, command.scopeId, options, 'write');
  const draft = proposalFixture('business', { id: principal.id, issuer: principal.issuer, subject: principal.subject });
  return proposeConfiguredRun(root, { ...draft, scopeId: command.scopeId, commandId: command.commandId, proposalId: command.commandId, runId: `run-${command.commandId.slice(-16)}` }, options);
};
type Snapshot = { readonly identity: { readonly runId: string }; readonly progress: readonly { readonly phase: string }[];
  readonly authority?: { readonly approval?: { readonly approvalId: string } } };
const runsOf = (f: { rows: (sql: string) => unknown[] }) => f.rows('SELECT snapshot FROM runs').map(row => JSON.parse(String((row as { snapshot: string }).snapshot)) as Snapshot);
/** The requester each Run's create receipt recorded. */
const requesters = (f: { rows: (sql: string) => unknown[] }) => f.rows("SELECT command FROM run_receipts").flatMap(row => { const command = JSON.parse(String((row as { command: string }).command)) as { action?: string; actor: { issuer: string; subject: string } };
  return command.action === 'create-run' ? [{ issuer: command.actor.issuer, subject: command.actor.subject }] : []; });

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
    // alpha.64 C: a listed setting opens the /config before/after card as the AI actor even though the person's own rule allows config writes
    // (a person-identity call would have written at once); a no writes nothing, a yes writes once, audited as the AI's write with the person's approval.
    const s = await modeRuntime({ grants: [AI_SCOPE, AI_SETTING, PERSON_CONFIG], mode: null });
    const listed = await s.call('list_setting_choices', { keyPath: 'language' });
    expect(listed, s.evidence(listed)).toMatchObject({ card: false, status: 'ok' }); expect(JSON.parse(listed.text)).toMatchObject({ keyPath: 'language', choices: expect.arrayContaining(['en', 'tr']) });
    const no = await s.call('propose_setting', { keyPath: 'language', choice: 'tr' }, 'deny');
    expect(no, s.evidence(no)).toMatchObject({ card: true, status: 'error' }); expect(no.text).toContain('the person declined'); expect(config(s)['language']).toBeUndefined();
    expect(cardOf(no.events)).toMatchObject({ summary: expect.stringContaining('language'), preview: 'Proposed by the AI in this conversation; you decide.' });
    const yes = await s.call('propose_setting', { keyPath: 'language', choice: 'tr' }, 'allow');
    expect(yes, s.evidence(yes)).toMatchObject({ card: true, status: 'ok' }); expect(config(s)['language']).toBe('tr');
    expect(s.audit().filter(entry => entry.event.subject['kind'] === 'config-change').map(entry => [entry.event.principal, typeof entry.event.subject['approvalId']])).toEqual([[AI, 'string']]);
    // A fourth key, a model key and an unlisted value never open a card or write; the model is pointed at the person's window.
    for (const [args, words] of [[{ keyPath: 'terminal.theme', choice: 'dark' }, 'in /config'], [{ keyPath: 'brain_planner.reference', choice: 'x' }, 'in /model'],
      [{ keyPath: 'output_mode', choice: 'loud' }, 'choice-not-listed']] as const) {
      const refused = await s.call('propose_setting', args, 'allow');
      expect(refused).toMatchObject({ card: false, status: 'error' }); expect(refused.text).toContain(words);
    }
    expect(config(s)['output_mode']).toBeUndefined();
    // alpha.64 (S5 D1): the turn's `policy-turn` record names each proposal call the v20 rules allowed and that ran.
    expect([...new Set(s.policyTurns().flatMap(turn => turn.allowed.calls.map(call => (call['tool'] as { name: string }).name)))]).toEqual(['list_setting_choices', 'propose_setting']);
    // alpha.64 B: propose_work runs the service's real plan (a Brain call: the fixture model answers the plan) and run admission as the AI actor
    // (never the person): with the v20 rules the one card is the /do Run card; a no admits nothing, a yes admits a pending Run requested by the AI
    // actor and approved by the person. The Brain-source check reads the retained answer as the system (lead option b), never as the AI.
    const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business');
    const w = await modeRuntime({ grants: [AI_SCOPE, ...AI_OBSERVE, AI_INVOKE, ...V20], mode: null, planWork: planServiceRun, brain: JSON.stringify({ graph, budgetCeiling, requiredPermissions }) });
    const declinedWork = await w.call('propose_work', { request: 'add a third line to notes.txt' }, 'deny');
    expect(declinedWork, w.evidence(declinedWork)).toMatchObject({ card: true, status: 'error' }); expect(declinedWork.text).toContain('the person declined');
    expect(declinedWork.events.filter(event => event.kind === 'approval.requested')).toHaveLength(1);
    expect(cardOf(declinedWork.events)).toMatchObject({ summary: expect.stringContaining('Plan · tasks: 1'), preview: expect.stringContaining('Proposed by the AI in this conversation; you decide.') });
    expect(runsOf(w)).toEqual([]);
    const admitted = await w.call('propose_work', { request: 'add a third line to notes.txt' }, 'allow');
    expect(admitted, w.evidence(admitted)).toMatchObject({ card: true, status: 'ok' }); expect(admitted.events.filter(event => event.kind === 'approval.requested')).toHaveLength(1);
    const [run] = runsOf(w); expect(admitted.text).toContain(`Run ${run!.identity.runId} was admitted`);
    // v31 (/do parity): the turn carries the plan's progress and the admitted Run for the person's /tasks handoff.
    const callId = (cardOf(admitted.events)!).callId;
    expect(admitted.events.filter(event => event.kind === 'work')).toEqual([{ kind: 'work', callId, phase: 'planning', attempt: 1 }, { kind: 'work', callId, phase: 'admitted', runId: run!.identity.runId }]);
    expect(run).toMatchObject({ progress: [{ phase: 'pending' }] }); expect(requesters(w)).toEqual([AI]);
    const journal = openSqliteApprovalStore(w.ledger, { busyTimeoutMs: 1_000, journalMode: 'delete', durability: 'full' });
    try { expect(journal.store.load('scope', run!.authority!.approval!.approvalId)).toMatchObject({ status: 'decided', request: { requester: { issuer: AI.issuer, subject: AI.subject } },
      decision: { decision: 'allow', actor: { issuer: me[0]!.issuer, subject: me[0]!.subject } } }); } finally { journal.close(); }
    // Negative: the AI actor holds no inspect-content, so it cannot read the Brain answer itself (the same application MCP's inspect_model_invocation
    // reaches); its tool results carry only the verdict.
    const source = (JSON.parse(String((w.rows('SELECT record FROM run_proposals')[0] as { record: string }).record)) as { proposal: { source: { kind: string; receipt: { invocationId: string; reference: unknown }; contribution?: unknown } } }).proposal.source;
    expect(source).toMatchObject({ kind: 'model', contribution: { schemaVersion: 2 } });
    const read = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: source.receipt.invocationId, reference: source.receipt.reference as never };
    await expect(withMcpPrincipal(() => inspectConfiguredModelInvocation(w.project, { ...read, includeResponseContent: true }, { env: w.env }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect((await withMcpPrincipal(() => inspectConfiguredModelInvocation(w.project, read, { env: w.env }))).responseContent).toBeUndefined();
    for (const turn of [declinedWork, admitted]) expect(turn.text).not.toMatch(/graph|readback|budgetCeiling/u);
  }, 180_000);

  it('full-auto and a full-access turn still open the window; a no writes nothing in either', async () => {
    // Policy allows the call itself (no generic card): what opens is the proposal's own window, which no mode lowers.
    const auto = await modeRuntime({ grants: [PROPOSE], mode: 'full-auto' });
    const lowered = await auto.call('propose_mcp_server', proposal, 'deny');
    expect(lowered.events.filter(event => event.kind === 'approval.requested').map(event => event.summary)).toEqual([expect.stringMatching(/^propose_mcp_server · mcp:docs-search · proposal/u)]);
    expect(lowered.text).toContain('nothing was written'); expect(registered(auto)).toBeNull();
    const full = await modeRuntime({ grants: [PROPOSE, FULL_ACCESS], mode: null });
    const open = await full.call('propose_mcp_server', proposal, 'deny', { fullAccess: true });
    expect(open.card).toBe(true); expect(open.text).toContain('nothing was written'); expect(registered(full)).toBeNull();
    // alpha.64 (owner S4/S5): full-auto and a full-access turn still open the setting and plan cards; a no changes nothing.
    const every = await modeRuntime({ grants: [AI_SCOPE, ...AI_OBSERVE, ...V20, PERSON_CONFIG, FULL_ACCESS], mode: 'full-auto', planWork: realPlan });
    for (const options of [{}, { fullAccess: true }]) {
      const setting = await every.call('propose_setting', { keyPath: 'output_mode', choice: 'json' }, 'deny', options);
      expect(setting, every.evidence(setting)).toMatchObject({ card: true, status: 'error' });
      const work = await every.call('propose_work', { request: 'update the tests' }, 'deny', options);
      expect(work, every.evidence(work)).toMatchObject({ card: true, status: 'error' });
      // v31: the plan's quota wait reaches the turn as a `work` event (/do's wait in the terminal); a declined card admits nothing.
      expect(work.events.filter(event => event.kind === 'work').map(event => event.kind === 'work' && [event.phase, event.attempt, event.maxAttempts, event.untilMs]))
        .toEqual([['planning', 1, undefined, undefined], ['quota-wait', 2, 3, 2_000], ['planning', 2, undefined, undefined]]);
    }
    expect(config(every)['output_mode']).toBeUndefined(); expect(runsOf(every)).toEqual([]);
  }, 180_000);

  it('PROPFIX: upgraded broad AI grants, direct or by role, never replace the person card in any mode', async () => {
    for (const byRole of [false, true]) for (const mode of [null, 'full-auto', { mode: 'full-access' }] as const) {
      const f = await modeRuntime({ grants: [AI_SCOPE, ...AI_OBSERVE, PERSON_CONFIG, FULL_ACCESS], mode, planWork: realPlan });
      const policyPath = join(f.data, 'policy.json'), bindingsPath = join(f.data, 'bindings.json');
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')), bindings = JSON.parse(readFileSync(bindingsPath, 'utf8'));
      const broad = ['config', 'run'].map(kind => ({ id: `old-ai-${kind}`, effect: 'allow', actions: [kind === 'config' ? 'write' : 'create'], resource: { kind, ids: 'all' } }));
      if (byRole) {
        policy.roles.push({ id: 'old-ai', permissions: broad });
        bindings.bindings.push({ id: 'old-ai', principals: [AI], roles: ['old-ai'], scopes: 'all' });
      } else policy.grants.push(...broad.map(grant => ({ ...grant, principals: [AI], scopes: 'all' })));
      // The alpha.63.3 customization survives the same add-only v20 coverage calculation as the installation upgrade.
      const upgrade = firstRunProposalRules(proposalCoverageGrants(policy, bindings, me[0]!), me[0]!, ['scope']);
      expect(upgrade.skipped).toHaveLength(2);
      policy.grants.push(...upgrade.wanted);
      writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 }); writeFileSync(bindingsPath, JSON.stringify(bindings), { mode: 0o600 });
      const turn = typeof mode === 'object' && mode !== null ? { fullAccess: true } : {};
      const before = readFileSync(join(f.project, '.deckent', 'config.json'), 'utf8');
      const setting = await f.call('propose_setting', { keyPath: 'language', choice: 'tr' }, 'deny', turn);
      expect(setting, f.evidence(setting)).toMatchObject({ card: true, status: 'error' });
      expect(setting.text).toContain('the person declined'); expect(setting.text).not.toContain('the person approved');
      expect(readFileSync(join(f.project, '.deckent', 'config.json'), 'utf8')).toBe(before);
      expect(f.audit().filter(row => row.event.subject['kind'] === 'config-change')).toEqual([]);
      const work = await f.call('propose_work', { request: 'update the tests' }, 'deny', turn);
      expect(work, f.evidence(work)).toMatchObject({ card: true, status: 'error' });
      expect(work.text).toContain('the person declined'); expect(work.text).not.toContain('the person approved'); expect(runsOf(f)).toEqual([]);
      const applied = await f.call('propose_setting', { keyPath: 'language', choice: 'tr' }, 'allow', turn);
      expect(applied, f.evidence(applied)).toMatchObject({ card: true, status: 'ok' }); expect(config(f)['language']).toBe('tr');
      expect(f.audit().filter(row => row.event.subject['kind'] === 'config-change').map(row => row.event.subject['approvalId'])).toEqual([expect.any(String)]);
      const admitted = await f.call('propose_work', { request: 'update the tests' }, 'allow', turn);
      expect(admitted, f.evidence(admitted)).toMatchObject({ card: true, status: 'ok' });
      expect(runsOf(f)).toMatchObject([{ authority: { approval: { approvalId: expect.any(String) } } }]);
      expect(admitted.text).toContain('was admitted');
      await closeModeRuntimes();
    }
  }, 180_000);

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
    // alpha.64 (owner S6): without the AI actor's v20 rule (revoked, or never granted) or with the company's explicit tool deny, the proposal tools
    // are not offered at all: no card, no write, even though the person's own rule would allow the write.
    for (const grants of [[AI_SCOPE, PERSON_CONFIG], [AI_SCOPE, ...AI_OBSERVE, ...V20, PERSON_CONFIG, { id: 'company-closes', effect: 'deny', actions: ['invoke'], scopes: ['scope'], principals: [AI],
      resource: { kind: 'agent-tool', ids: ['propose_setting', 'propose_work'] } }]]) {
      const closed = await modeRuntime({ grants, mode: null, planWork: realPlan });
      for (const [name, args] of [['propose_setting', { keyPath: 'language', choice: 'tr' }], ['propose_work', { request: 'update the tests' }]] as const) {
        const refused = await closed.call(name, args, 'allow');
        expect(refused, closed.evidence(refused)).toMatchObject({ card: false }); expect(refused.status).not.toBe('ok');
      }
      expect(config(closed)['language']).toBeUndefined(); expect(runsOf(closed)).toEqual([]);
      // Revoked or closed by the company: the tools are not offered, so no proposal call ran on an allow in the turn's record.
      expect(closed.policyTurns().flatMap(turn => turn.allowed.calls.map(call => (call['tool'] as { name: string }).name)).filter(name => name.startsWith('propose_'))).toEqual([]);
    }
  }, 180_000);
});
