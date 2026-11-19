import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import * as execution from '#composition/core/execution/index.js';
import * as runs from '#composition/core/runs/index.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { planMcpProposal, DockerSupervisor, identifyDockerRequest, readLocalOsIdentity, type DockerCommandRunner } from '#adapters/index.js';
import { describeMcpProposal, runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { closeModeRuntimes, me, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, firstRunPolicyTemplate, aiSettingResourceIds, firstRunProposalRules, proposalCoverageGrants, mcpPrincipalRef, type AgentTurnStreamEvent } from '#domain/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore, withMcpPrincipal, withLocalPrincipalChannel } from '#adapters/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { clearConfigCache, loadConfig, ErrorRegistry } from '#platform/index.js';
import { planServiceRun } from '#composition/core/run-planner/index.js';
import { proposeConfiguredRun } from '#composition/core/runs/index.js';
import { proposalFixture } from '../support/run-proposal.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import type { PlanServiceRun } from '#composition/core/agent-turn/index.js';
import { terminalApplication, terminalRequest } from '../support/approval-terminal.js';
import { FIRST_RUN_TOOL_NAMES, aiProposalRequester, sealApproval, RunSessionRegistry, RuntimeServiceLifecycle, type RunSessionIdentity, type RunSessionPin } from '#engine/index.js';

// L1 MCP-CORE item 5 (owner 2026-10-07): the model may only PROPOSE an MCP server. The proposal opens its own approval window in every mode —
// standart, full-auto and a full-access turn alike — and nothing is written without the person's yes; a yes adds the server to the project's
// local registry untrusted (its trust cards follow). Every string passes the model-ingress check.
// Security (owner, Jev 30efcb91: no secrets in a proposal): no env or header value, no `$DECK:`, `${VAR}` or `$VAR` anywhere; the model names the
// settings it needs and a person binds them in /mcp.
const restartedServices: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => { for (const service of restartedServices.splice(0)) { await service.stop(); await service.done; } await closeModeRuntimes(); vi.restoreAllMocks(); });
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

it.skipIf(process.platform !== 'linux')('PROPFIX2/3: an AI with inspect and decide cannot answer proposal cards, including old Runs and approval-gated MCP calls', async () => {
  const grants = [PROPOSE, AI_SCOPE, ...AI_OBSERVE, ...V20, PERSON_CONFIG,
    { id: 'ai-decide', effect: 'allow', actions: ['decide'], scopes: ['scope'], principals: [AI], resource: { kind: 'approval', ids: 'all' } }];
  let f = await modeRuntime({ grants, mode: null, planWork: realPlan });
  const { principal: ai } = await withMcpPrincipal(() => loadConfiguredScopeContext(f.project, 'scope', { env: f.env }, 'read'));
  expect(aiProposalRequester(ai)).toEqual({ id: ai.id, issuer: ai.issuer, subject: ai.subject });
  for (const [tool, args, gated] of [['propose_setting', { keyPath: 'language', choice: 'tr' }, false], ['propose_work', { request: 'update the tests' }, false],
    ['propose_mcp_server', proposal, false], ['propose_mcp_server', { ...proposal, name: 'gated-docs' }, true]] as const) {
    // A fresh registry keeps the previously proposed server's separate trust card out of this tool-call scenario.
    if (gated) f = await modeRuntime({ grants: grants.map(grant => grant === PROPOSE ? { ...PROPOSE, effect: 'require-approval' } : grant), mode: null });
    const before = readFileSync(join(f.project, '.deckent/config.json'), 'utf8'), beforeMcp = registered(f), beforeRuns = runsOf(f);
    const turnId = `self-${tool}${gated ? '-gated' : ''}`;
    f.script(tool, args);
    const checks: Promise<void>[] = []; let failure: unknown;
    await f.client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId, messages: [{ role: 'user', content: 'go' }] }, event => {
      if (event.kind !== 'approval.requested') return;
      checks.push((async () => {
        const query = { schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId };
        const command = { ...query, commandId: turnId, expectedRevision: event.revision, decision: 'allow', reason: 'AI self approval' };
        try {
          expect(await withMcpPrincipal(() => f.client.inspectApproval(query))).toMatchObject({ status: 'pending' });
          expect((await f.client.inspectApproval(query))!.request.requester).toEqual({ id: ai.id, issuer: ai.issuer, subject: ai.subject });
          if (tool === 'propose_work') {
            // Recreate an alpha.63.3 pending Run card without the new risk marker, in its existing seal format.
            const card = (await f.client.inspectApproval(query))!;
            if (card.request.schemaVersion !== 3) throw Error('EXPECTED_FACTS');
            const context = await loadConfiguredScopeContext(f.project, 'scope', { env: f.env }, 'read');
            const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile);
            const legacy = sealApproval({ ...card, request: { ...card.request, facts: { ...card.request.facts, risk: null } } }, integrity);
            const db = new DatabaseSync(f.ledger);
            try { db.prepare('UPDATE approvals SET snapshot=? WHERE scope_id=? AND approval_id=?').run(JSON.stringify(legacy), 'scope', event.approvalId); } finally { db.close(); }
          }
          const pending = await f.client.inspectApproval(query);
          for (const decision of ['allow', 'deny']) {
            const result = await withMcpPrincipal(() => f.client.decideApproval({ ...command, decision })).then(() => 'accepted', (error: { code: string }) => error.code);
            expect(result, `${tool}:${decision}:${(await f.client.inspectApproval(query))?.status}`).toBe('AI_AUTHORITY_NON_DELEGABLE');
          }
          expect(await withMcpPrincipal(() => f.client.inspectApproval(query))).toEqual(pending);
          expect(readFileSync(join(f.project, '.deckent/config.json'), 'utf8')).toBe(before); expect(registered(f)).toBe(beforeMcp); expect(runsOf(f)).toEqual(beforeRuns);
        } finally {
          if ((await f.client.inspectApproval(query))?.status === 'pending') {
            const person = { ...command, commandId: `person-${turnId}`, decision: 'deny', reason: 'Person declined' };
            const denied = await terminalRequest(f, 'decideApproval', person);
            expect(denied.response).toMatchObject({ ok: true, result: { decision: { deciderClass: 'human-tty', decision: 'deny' } } });
            expect((await terminalRequest(f, 'decideApproval', person)).response).toEqual(denied.response);
          }
        }
      })().catch(async error => { failure ??= error; await f.client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId }); }));
    });
    await Promise.all(checks); if (failure) throw failure; expect(checks).toHaveLength(1);
    expect(readFileSync(join(f.project, '.deckent/config.json'), 'utf8')).toBe(before); expect(registered(f)).toBe(beforeMcp); expect(runsOf(f)).toEqual(beforeRuns);
    const accepted = await f.call(tool, args, 'allow');
    expect(accepted, f.evidence(accepted)).toMatchObject({ status: 'ok', card: true });
    if (tool === 'propose_setting') {
      expect(config(f)['language']).toBe('tr');
      expect(f.audit().filter(row => row.event.subject['kind'] === 'config-change')).toHaveLength(1);
    } else if (tool === 'propose_work') expect(runsOf(f)).toHaveLength(1);
    else expect(registered(f)).toContain(args.name);
    if (gated) expect(accepted.events.filter(event => event.kind === 'approval.requested')).toHaveLength(2);
  }
}, 60_000);

describe.skipIf(process.platform !== 'linux')('the proposal window in every mode (real runtime service)', () => {
  it('standart: the window opens; a no writes nothing; a yes adds the server untrusted', async () => {
    const gated = await modeRuntime({ grants: [{ ...PROPOSE, effect: 'require-approval' }], mode: null });
    const stopped = await gated.call('propose_mcp_server', proposal, 'deny');
    expect(stopped, gated.evidence(stopped)).toMatchObject({ card: true, status: 'denied' });
    expect(stopped.text).toContain('denied-by-owner'); expect(registered(gated)).toBeNull();
    expect(stopped.events.filter(event => event.kind === 'approval.requested')).toHaveLength(1);
    const continued = await gated.call('propose_mcp_server', proposal, 'allow');
    expect(continued, gated.evidence(continued)).toMatchObject({ card: true, status: 'ok' });
    const cards = continued.events.filter(event => event.kind === 'approval.requested');
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(await gated.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: card.approvalId }))
      .toMatchObject({ request: { requester: { issuer: AI.issuer, subject: AI.subject } }, decision: { decision: 'allow', deciderClass: 'human-tty' } });
    expect(registered(gated)).toContain(proposal.name);
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
    // C3: this Docker-profile AI proposal also seals the own-person mode before the person's card, without borrowing that person's execution identity.
    const ceiling = { mode: 'standart', askEdits: false };
    expect(run).toMatchObject({ execution: { workerMode: ceiling } });
    expect(cardOf(admitted.events)!.summary).toContain('Recorded worker ceiling: standard');
    expect(cardOf(admitted.events)!.summary).toContain('its own sandbox/profile limits apply; no per-tool mode check.');
    expect(cardOf(admitted.events)!.summary).not.toContain('destructive commands always ask');
    expect(cardOf(admitted.events)!.summary).toContain("Work starts under the AI's own execution permissions; this card grants no missing policy permission.");
    const create = w.rows('SELECT command FROM run_receipts').map(row => JSON.parse(String((row as { command: string }).command))).find(row => row.action === 'create-run');
    expect(create.execution.workerMode).toEqual(ceiling);
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

it.skipIf(process.platform !== 'linux')('119-C1/C2/C4: deny → the person applies v21 → a new proposal advances; chat approval advances from configured discovery as AI through launch and evaluation; person control', async () => {
  // C2 reuses C1's configured-loop proof with the real v20 template and the person's governed v21 apply.
  const cells = (prefix: string, principals: unknown) => [
    { id: `${prefix}-run`, effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['scope'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: `${prefix}-attempt`, effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['scope'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: `${prefix}-pool`, effect: 'allow', actions: ['use'], scopes: ['scope'], principals, resource: { kind: 'pool', ids: ['p'] } },
  ];
  const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business');
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, ...FIRST_RUN_TOOL_NAMES });
  const w = await modeRuntime({ grants: [...template.policy.grants.filter(rule => !FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.includes(rule.id)), ...cells('person', me),
    { id: 'person-create', effect: 'allow', actions: ['create'], scopes: ['scope'], principals: me, resource: { kind: 'run', ids: 'all' } }],
    mode: null, planWork: planServiceRun, brain: JSON.stringify({ graph, budgetCeiling, requiredPermissions }) });
  // The execution permission is applied only from a person's terminal: no AI-agent or CI marker (owner 143; the suite itself may run under one).
  const upgrade = (mode: 'preview' | 'apply', f: { project: string; env: NodeJS.ProcessEnv } = w, person = true) => terminalApplication<{ status: string; rules: { id: string }[] }>(f, 'policy-upgrade', 'scope', { mode, only: 'ai-execution', reason: 'C2 person grants execution' }, person);
  // Real workspace preparation, dispatch, artifact storage and evaluation; only Docker's process boundary is controlled.
  const git = (...args: string[]) => execFileSync('git', ['-C', w.project, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('add', 'src'); git('commit', '-qm', 'fixture');
  const base = config(w), docker = (base['admission'] as { registry: { profiles: { parameters: Record<string, unknown> }[] } }).registry.profiles[0]!.parameters;
  const { argv: _argv, ...settings } = docker; void _argv;
  writeFileSync(join(w.project, '.deckent/config.json'), JSON.stringify({ ...base, execution: { deliveryMode: 'reference',
    docker: { ...settings, executable: '/usr/bin/docker' }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } })); clearConfigCache();
  const configured = await loadConfig(w.project, { env: w.env, heal: false }), os = userInfo();
  const options = { ...configured.execution!.docker!, workspaceRoot: join(w.data, 'workspaces'), uid: os.uid, gid: os.gid };
  const runner: DockerCommandRunner = async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
    if (args[0] === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    if (args[0] === 'info') return { stdout: 'fixture-daemon', stderr: '' };
    throw Error(`UNEXPECTED_DOCKER_${args[0]}`);
  };
  const profile = await new DockerSupervisor(options, runner).captureProfile();
  vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockResolvedValue(profile);
  vi.spyOn(DockerSupervisor.prototype, 'probe').mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  const launched: string[] = [];
  vi.spyOn(DockerSupervisor.prototype, 'execute').mockImplementation(async request => {
    launched.push(request.identity.runId);
    return { handle: identifyDockerRequest(request, options).handle, result: { kind: 'exited', exitCode: 0 }, stdout: 'business-result', stderr: '', interrupted: false, outputCompleteness: 'complete' };
  });
  // C4: real service discovery refuses the admitted AI Run, including cancel; the authorized person's controls stay separate.
  const refused = await w.call('propose_work', { request: 'blocked before the person grants execution' }, 'allow');
  expect(refused, w.evidence(refused)).toMatchObject({ card: true, status: 'ok' });
  const deniedRun = runsOf(w)[0]!.identity.runId;
  const query = { schemaVersion: 1 as const, scopeId: 'scope', runId: deniedRun };
  await expect.poll(async () => (await w.client.inspectRun(query)).progression, { timeout: 8000 }).toMatchObject({ state: 'blocked', parkUnavailable: true,
    missing: expect.arrayContaining([{ kind: 'run', id: deniedRun, action: 'reserve', scope: 'scope', reason: 'NO_GRANT', code: 'POLICY_DENIED' },
      { kind: 'run', id: deniedRun, action: 'cancel', scope: 'scope', reason: 'NO_GRANT', code: 'POLICY_DENIED' }]) });
  expect(launched).toEqual([]);
  const unstarted = (await w.client.inspectRun(query)).run!;
  const held = await runs.applyConfiguredRunLifecycle(w.project, { ...query, commandId: 'person-holds-denied-ai', action: 'hold', holdReason: 'person control', expectedRevision: unstarted.revision }, { env: w.env });
  expect(held.lifecycle.run.state).toMatchObject({ kind: 'parked', reason: 'operator-hold' });
  await w.client.requestRunCancellation({ ...query, commandId: 'person-cancels-denied-ai', action: 'cancel', expectedRevision: held.lifecycle.run.revision });
  expect(await upgrade('preview')).toMatchObject({ status: 'preview', rules: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.map(id => ({ id })) });
  await expect(upgrade('apply', { ...w, env: { ...w.env, AI_AGENT: '1' } }, false)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' }); // an AI-marked terminal never applies it
  expect(await upgrade('preview')).toMatchObject({ status: 'preview' }); // and nothing was written by the refused apply
  expect(await upgrade('apply')).toMatchObject({ status: 'upgraded' });
  expect(await upgrade('apply')).toMatchObject({ status: 'current' });
  const admitted = await w.call('propose_work', { request: 'complete the business operation' }, 'allow');
  expect(admitted, w.evidence(admitted)).toMatchObject({ card: true, status: 'ok' });
  const aiRun = runsOf(w).find(run => run.identity.runId !== deniedRun)!.identity.runId;
  expect(aiRun).not.toBe(deniedRun);
  const receipts = () => w.rows('SELECT command FROM run_receipts').map(row => JSON.parse(String((row as { command: string }).command)) as { action: string; actor: unknown; scopeId?: string; runId?: string; commandId?: string });
  await expect.poll(() => receipts().filter(receipt => receipt.action === 'reserve-run-tasks' && receipt.runId === aiRun), { timeout: 8000 }).toHaveLength(1);
  await expect.poll(() => w.rows('SELECT * FROM task_evaluation_observations'), { timeout: 8000 }).toHaveLength(1);
  expect(launched).toEqual([aiRun]);
  await w.client.createRun({ schemaVersion: 1, scopeId: 'scope', runId: 'person-control', commandId: 'person-control', graph });
  await expect.poll(() => w.rows('SELECT * FROM task_evaluation_observations'), { timeout: 8000 }).toHaveLength(2);
  const person = readLocalOsIdentity(), ai = withMcpPrincipal(readLocalOsIdentity);
  const actor = (value: typeof person) => ({ id: value.id, issuer: value.issuer, subject: value.subject });
  expect(receipts().filter(receipt => receipt.action === 'reserve-run-tasks').map(receipt => [receipt.runId, receipt.actor]))
    .toEqual([[aiRun, actor(ai)], ['person-control', actor(person)]]);
  const grants = w.rows('SELECT record FROM dispatches').map(row => JSON.parse(String((row as { record: string }).record)) as { grant: { principal: unknown } });
  expect(grants.map(value => value.grant.principal)).toEqual([actor(ai), actor(person)]);
  // Owner 134's visible counter-example: after stopping automatic progression, the same AI uses real MCP tools on a person's Run.
  // This is old work from the service's next lifetime; the service does not start it on its own.
  await w.service.stop(); await w.service.done;
  await runs.createConfiguredRun(w.project, { schemaVersion: 1, scopeId: 'scope', runId: 'persons-stuck-run', commandId: 'persons-stuck-run', graph }, { env: w.env });
  const server = createMcpServer(mcpApplications({
    inspectRun: query => runs.inspectConfiguredRun(w.project, query, { env: w.env }), async inspectInventory() { return {}; },
    reserveRunTasks: command => runs.reserveConfiguredRunTasks(w.project, command, { env: w.env }),
    executeTask: identity => execution.executeConfiguredTask(w.project, identity, { env: w.env }),
    evaluateTask: command => runs.evaluateConfiguredTask(w.project, command, { env: w.env }),
    requestRunCancellation: command => runs.requestConfiguredRunCancellation(w.project, command, { env: w.env }),
  } as McpApplications), { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'c2-accepted-breadth', version: '1' }); await client.connect(clientTransport);
  try {
    const old = await runs.inspectConfiguredRun(w.project, { schemaVersion: 1, scopeId: 'scope', runId: 'persons-stuck-run' }, { env: w.env });
    const reserved = await client.callTool({ name: 'reserve_run_tasks', arguments: { schemaVersion: 1, scopeId: 'scope', runId: 'persons-stuck-run', commandId: 'ai-reserves-persons-run', expectedRevision: old.run!.revision } });
    expect(reserved.isError, JSON.stringify(reserved)).not.toBe(true);
    const identity = (reserved.structuredContent as unknown as { reservation: { identities: unknown[] } }).reservation.identities[0]!;
    const executed = await client.callTool({ name: 'execute_task', arguments: identity }); expect(executed.isError, JSON.stringify(executed)).not.toBe(true);
    const exited = await runs.inspectConfiguredRun(w.project, { schemaVersion: 1, scopeId: 'scope', runId: 'persons-stuck-run' }, { env: w.env });
    const evaluated = await client.callTool({ name: 'evaluate_task', arguments: { schemaVersion: 1, commandId: 'ai-evaluates-persons-run', identity, expectedRevision: exited.run!.revision } }); expect(evaluated.isError, JSON.stringify(evaluated)).not.toBe(true);
    expect(receipts().find(receipt => receipt.commandId === 'ai-reserves-persons-run')).toMatchObject({ actor: actor(ai) });
    expect(launched).toContain('persons-stuck-run');
    await runs.createConfiguredRun(w.project, { schemaVersion: 1, scopeId: 'scope', runId: 'persons-cancel-run', commandId: 'persons-cancel-run', graph }, { env: w.env });
    const pending = await runs.inspectConfiguredRun(w.project, { schemaVersion: 1, scopeId: 'scope', runId: 'persons-cancel-run' }, { env: w.env });
    const cancelled = await client.callTool({ name: 'request_run_cancellation', arguments: { schemaVersion: 1, scopeId: 'scope', runId: 'persons-cancel-run', commandId: 'ai-cancels-persons-run', action: 'cancel', expectedRevision: pending.run!.revision } });
    expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
    expect(receipts().find(receipt => receipt.commandId === 'ai-cancels-persons-run')).toMatchObject({ actor: actor(ai) });
  } finally { await client.close(); await server.close(); }

}, 30000);

async function sessionRuntime(progress = true) {
  const grants = [AI_SCOPE, ...AI_OBSERVE, ...V20,
    { id: 'person-progress-run', effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['scope'], principals: me, resource: { kind: 'run', ids: 'all' } },
    { id: 'person-progress-attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['scope'], principals: me, resource: { kind: 'attempt', ids: 'all' } }, ...(progress ? [
    { id: 'ai-progress-run', effect: 'allow', actions: ['reserve', 'cancel'], scopes: ['scope'], principals: [AI], resource: { kind: 'run', ids: 'all' } },
    { id: 'ai-progress-attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['scope'], principals: [AI], resource: { kind: 'attempt', ids: 'all' } },
  ] : [])];
  const w = await modeRuntime({ grants, mode: null, planWork: realPlan }), launched: string[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_root, identity, _options, signal) => {
    launched.push(identity.runId);
    if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    return undefined as never;
  });
  const ai = withMcpPrincipal(readLocalOsIdentity);
  const draft = (id: string) => ({ ...proposalFixture('business', { id: ai.id, issuer: ai.issuer, subject: ai.subject }), scopeId: 'scope', commandId: id, proposalId: id, runId: id });
  const propose = (id: string) => withMcpPrincipal(() => w.client.proposeRun(draft(id)));
  const ask = async (id: string) => {
    const pending = await propose(id);
    expect(pending.proposal).toMatchObject({ status: 'pending', reason: 'RUN_APPROVAL_REQUIRED' });
    return { schemaVersion: 1 as const, scopeId: 'scope', approvalId: pending.proposal.approval!.approvalId, commandId: `allow-${id}`, expectedRevision: 0, decision: 'allow' as const, reason: 'person answer' };
  };
  const errors: { id: string | null; code: string }[] = [];
  const restart = async () => {
    await w.service.stop(); await w.service.done;
    const service = await startConfiguredRuntimeService(w.project, { onPage() {}, onError() {},
      onRunProgressionError(query, error) { errors.push({ id: query?.runId ?? null, code: error.code }); } }, { env: w.env });
    restartedServices.push(service); return service;
  };
  const pool = async (action: 'hold' | 'resume') => {
    const { store } = await openConfiguredAttemptStore(w.project, { env: w.env });
    try { await store.applyPoolHold({ command: { scopeId: 'scope', commandId: `pool-${action}`, poolId: 'p', action, reason: 'controlled restart' }, actor: me[0]!, atMs: Date.now() }, () => {}); }
    finally { store.close(); }
  };
  return { ...w, launched, propose, ask, restart, errors, pool };
}
it.skipIf(process.platform !== 'linux')('119-C1 revise2: the same admitted AI Run recovers through the real loop after unknown verification, without launching during a contradiction', async () => {
  const f = await sessionRuntime(), id = 'verification-recovery';
  writeFileSync(join(f.project, '.deckent/config.json'), JSON.stringify({ ...config(f),
    runRuntime: { pollIntervalMs: 10, failureBackoffMs: 80, pageSize: 8, maxConcurrentRuns: 2, maxReservationsPerTurn: 1 } }));
  clearConfigCache(); await f.restart(); await f.pool('hold');
  const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
  const prototype = Object.getPrototypeOf(opened.store) as typeof opened.store, read = prototype.readRunSession;
  opened.store.close();
  let fault: 'read' | 'contradiction' | null = null, reads = 0;
  const registries: RunSessionRegistry[] = [];
  vi.spyOn(prototype, 'readRunSession').mockImplementation(function (this: typeof prototype, key) {
    const state = read.call(this, key);
    if (key.runId !== id || fault === null) return state;
    reads++;
    if (fault === 'read') throw Error('CONTROLLED_SESSION_READ_FAILURE');
    return { ...state, intent: state.intent ? { ...state.intent, commandId: 'contradictory-command' } : null };
  });
  const admit = RunSessionRegistry.prototype.admission;
  const admission = vi.spyOn(RunSessionRegistry.prototype, 'admission').mockImplementation(function (this: RunSessionRegistry, pin, run, actor, commandId) {
    admit.call(this, pin, run, actor, commandId);
    if (commandId === id) registries.push(this);
  });
  const reserve = vi.spyOn(RunSessionRegistry.prototype, 'reserve');
  const launchActors: ReturnType<typeof readLocalOsIdentity>[] = [];
  vi.mocked(execution.executeConfiguredTask).mockImplementation(async (_root, query, _options, signal) => {
    f.launched.push(query.runId); launchActors.push(readLocalOsIdentity());
    if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    return undefined as never;
  });
  const answer = await f.ask(id);
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true });
  await f.propose(id);
  // Capture the real producer identity, rather than synthesizing a new admission on recovery.
  const registry = registries[0]!, identity = reserve.mock.calls.find(([key]) => key.runId === id)![0];
  const run = (await openedRun(f, id))!;
  expect(registry.eligible(identity, run)).toBe(true); expect(admission).toHaveBeenCalledTimes(1);
  fault = 'read';
  await expect.poll(() => f.errors.some(error => error.id === id), { timeout: 6000 }).toBe(true);
  expect(registry.eligible(identity, run)).toBe(false);
  expect(f.launched).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]);
  fault = 'contradiction'; const before = reads;
  await expect.poll(() => reads, { timeout: 6000 }).toBeGreaterThan(before + 12);
  expect(f.errors).toContainEqual({ id: null, code: 'RUN_STORE_CORRUPT' });
  expect(registry.eligible(identity, run)).toBe(false); expect(registry.count).toBe(1);
  expect(f.launched).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]);
  fault = null;
  await expect.poll(() => registry.eligible(identity, run), { timeout: 6000 }).toBe(true);
  await f.pool('resume');
  await expect.poll(() => f.launched, { timeout: 6000 }).toEqual([id]);
  expect(f.errors).toContainEqual({ id, code: 'RUN_PROGRESSION_SESSION_UNVERIFIED' });
  expect(f.errors.some(error => error.id === id && error.code === 'RUN_PROGRESSION_REPROPOSE_REQUIRED')).toBe(false);
  expect(admission).toHaveBeenCalledTimes(1); expect(registry.count).toBe(1);
  const ai = withMcpPrincipal(readLocalOsIdentity), actor = { id: ai.id, issuer: ai.issuer, subject: ai.subject };
  expect(launchActors).toEqual([expect.objectContaining(actor)]);
  const receipts = f.rows('SELECT command FROM run_receipts').map(row => JSON.parse(String((row as { command: string }).command)));
  expect(receipts.filter(command => command.action === 'reserve-run-tasks')).toEqual([expect.objectContaining({ runId: id, actor })]);
}, 30000);
async function openedRun(f: { project: string; env: { HOME: string } }, id: string) {
  const { store } = await openConfiguredAttemptStore(f.project, { env: f.env });
  try { return await store.loadRun('scope', id); } finally { store.close(); }
}
it.skipIf(process.platform !== 'linux')('119-C1 F2: old pending replay stays pending without membership; a fresh socket answer then opens iii', async () => {
  const f = await sessionRuntime(), answer = await f.ask('pending-card'); await f.restart();
  const request = vi.spyOn(RunSessionRegistry.prototype, 'request'), decision = vi.spyOn(RunSessionRegistry.prototype, 'decision'), admission = vi.spyOn(RunSessionRegistry.prototype, 'admission');
  await expect(f.propose('pending-card')).resolves.toMatchObject({ proposal: { status: 'pending', reason: 'RUN_APPROVAL_REQUIRED', approval: { approvalId: answer.approvalId } } });
  expect(request).not.toHaveBeenCalled(); expect(decision).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled();
  expect(f.launched).toEqual([]); expect(runsOf(f)).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]); expect(f.errors).toEqual([]);
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true });
  await f.propose('pending-card');
  expect(decision).toHaveBeenCalledTimes(1); expect(admission).toHaveBeenCalledTimes(1);
  await expect.poll(() => f.launched, { timeout: 6000 }).toEqual(['pending-card']);
  expect(f.errors).toEqual([]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 ii: approval before restart and fresh Run after restart stays closed; replayed allow is not a fresh decision', async () => {
  const f = await sessionRuntime(), answer = await f.ask('approved-before');
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.restart();
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true });
  expect((await terminalRequest(f, 'decideApproval', { ...answer, commandId: 'another-allow' })).response).toMatchObject({ ok: false, error: { code: 'APPROVAL_CONFLICT' } });
  await f.propose('approved-before');
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'approved-before', code: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
  expect(f.launched).toEqual([]); expect(runsOf(f)[0]!.progress).toMatchObject([{ phase: 'pending' }]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 i: an approved committed but unstarted Run never starts after restart or same-command replay', async () => {
  const f = await sessionRuntime(); await f.pool('hold'); const answer = await f.ask('committed-before');
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.propose('committed-before');
  await f.restart(); await f.pool('resume'); await f.propose('committed-before');
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'committed-before', code: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
  expect((await f.client.inspectRun({ schemaVersion: 1, scopeId: 'scope', runId: 'committed-before' })).progression).toMatchObject({ state: 'blocked', session: 'ineligible', reason: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
  expect(f.launched).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 external decision: answering the old card outside the service does not create D', async () => {
  const f = await sessionRuntime(), answer = await f.ask('external-answer'); await f.restart();
  expect(await terminalApplication(f, 'decide', 'scope', answer)).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
  await f.propose('external-answer');
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'external-answer', code: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
  expect(f.launched).toEqual([]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 shipped v20 only: a newly discovered AI Run refuses permission before any worker', async () => {
  const f = await sessionRuntime(false); await f.restart(); const answer = await f.ask('v20-only');
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.propose('v20-only');
  await expect.poll(() => f.errors.some(error => error.id === 'v20-only' && error.code === 'POLICY_DENIED'), { timeout: 6000 }).toBe(true);
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'v20-only', code: 'RUN_PROGRESSION_PARK_UNAVAILABLE' });
  expect(f.errors.filter(error => error.id === 'v20-only' && error.code === 'POLICY_DENIED')).toHaveLength(1);
  expect(f.errors.some(error => error.code === 'RUN_PROGRESSION_REPROPOSE_REQUIRED')).toBe(false); expect(f.launched).toEqual([]);
  expect(f.rows('SELECT * FROM attempts')).toEqual([]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 external admission and its socket replay never produce A', async () => {
  const f = await sessionRuntime(); await f.restart(); const ai = withMcpPrincipal(readLocalOsIdentity);
  const command = { ...proposalFixture('business', { id: ai.id, issuer: ai.issuer, subject: ai.subject }), scopeId: 'scope', commandId: 'outside-service', proposalId: 'outside-service', runId: 'outside-service' };
  const external = () => withMcpPrincipal(() => proposeConfiguredRun(f.project, command, { env: f.env }));
  const pending = await external(); expect(pending.proposal.status).toBe('pending');
  const answer = { schemaVersion: 1, scopeId: 'scope', approvalId: pending.proposal.approval!.approvalId, commandId: 'allow-external', expectedRevision: 0, decision: 'allow', reason: 'person answer' };
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await external();
  await withMcpPrincipal(() => f.client.proposeRun(command));
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'outside-service', code: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
  expect(f.launched).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]);
}, 30000);
it.skipIf(process.platform !== 'linux')('119-C1 future-dated old intent does not block a new service request and commit', async () => {
  const f = await sessionRuntime(); await f.pool('hold'); const old = await f.ask('future-old');
  expect((await terminalRequest(f, 'decideApproval', old)).response).toMatchObject({ ok: true }); await f.propose('future-old');
  f.exec("UPDATE run_execution_intents SET admitted_at=9007199254740990 WHERE run_id='future-old'");
  await f.restart(); await f.pool('resume'); const fresh = await f.ask('new-work');
  expect((await terminalRequest(f, 'decideApproval', fresh)).response).toMatchObject({ ok: true }); await f.propose('new-work');
  await expect.poll(() => f.launched, { timeout: 6000 }).toEqual(['new-work']);
  expect(f.errors).toContainEqual({ id: 'future-old', code: 'RUN_PROGRESSION_REPROPOSE_REQUIRED' });
}, 30000);

it.skipIf(process.platform !== 'linux')('119-C1 real socket capacity: zero proposal/card/Run writes; existing command continues and the refused command is accepted after release', async () => {
  const original = RunSessionRegistry.prototype.reserve;
  let captured!: { registry: RunSessionRegistry; identity: RunSessionIdentity };
  vi.spyOn(RunSessionRegistry.prototype, 'reserve').mockImplementation(function (this: RunSessionRegistry, key, baseline, operation) {
    captured = { registry: this, identity: key }; return original.call(this, key, baseline, operation);
  });
  const f = await sessionRuntime(); await f.pool('hold'); const old = await f.ask('old-card'); await f.restart();
  const answer = await f.ask('existing');
  const { registry, identity } = captured;
  const pins: RunSessionPin[] = [];
  for (let i = registry.count; i < registry.limit; i++) pins.push(await original.call(registry, { ...identity, commandId: `in-flight-${i}`, runId: `in-flight-${i}` }));
  const tables = ['run_proposals', 'approvals', 'runs', 'run_receipts', 'audit_events', 'approval_receipts', 'approval_outbox', 'run_execution_intents'];
  const before = tables.map(table => f.rows(`SELECT * FROM ${table}`));
  await expect(f.propose('new-at-capacity')).rejects.toMatchObject({ code: 'AI_RUN_SESSION_CAPACITY', params: { count: registry.limit, limit: registry.limit, operation: 'proposal' } });
  expect((await terminalRequest(f, 'decideApproval', old)).response).toMatchObject({ ok: false, error: { code: 'AI_RUN_SESSION_CAPACITY', params: { operation: 'approval' } } });
  expect(tables.map(table => f.rows(`SELECT * FROM ${table}`))).toEqual(before);
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true });
  expect((await f.propose('existing')).proposal.status).toBe('accepted'); expect(registry.count).toBe(registry.limit);
  await registry.finish(pins.pop()!);
  const retry = await f.ask('new-at-capacity');
  expect((await terminalRequest(f, 'decideApproval', retry)).response).toMatchObject({ ok: true });
  expect((await f.propose('new-at-capacity')).proposal.status).toBe('accepted');
  expect(registry.count).toBe(registry.limit);
  await registry.finish(pins.pop()!);
  expect((await terminalRequest(f, 'decideApproval', old)).response).toMatchObject({ ok: true });
  expect((await f.propose('old-card')).proposal.status).toBe('accepted'); expect(registry.count).toBe(registry.limit);
}, 30000);

it.skipIf(process.platform !== 'linux')('119-C1 configured FIFO execution and error park re-enter the AI actor when the queued work runs outside its context', async () => {
  const f = await sessionRuntime(); await f.restart();
  let queued!: () => Promise<void>, release!: () => void;
  vi.spyOn(RuntimeServiceLifecycle.prototype, 'admitExecution').mockImplementation(async work => {
    await new Promise<void>((resolve, reject) => { queued = () => work().then(resolve, reject); release = resolve; });
  });
  const observed: ReturnType<typeof readLocalOsIdentity>[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async () => { observed.push(readLocalOsIdentity()); throw ErrorRegistry.createError('POLICY_DENIED'); });
  const answer = await f.ask('fifo-ai'); expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true });
  await f.propose('fifo-ai');
  try {
    await expect.poll(() => typeof queued, { timeout: 6000 }).toBe('function'); expect(observed).toEqual([]);
    await withLocalPrincipalChannel(undefined, () => queued()).catch(() => undefined); release();
    await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'fifo-ai', code: 'RUN_PROGRESSION_PARKED' });
    const ai = withMcpPrincipal(readLocalOsIdentity), actor = { id: ai.id, issuer: ai.issuer, subject: ai.subject };
    expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject(actor);
    const receipts = f.rows('SELECT command FROM run_receipts').map(row => JSON.parse(String((row as { command: string }).command)));
    expect(receipts.filter(value => value.action === 'reserve-run-tasks' || value.action === 'park-progression').map(value => value.actor)).toEqual([actor, expect.objectContaining(actor)]);
    expect(runsOf(f)[0]).toMatchObject({ progress: [{ phase: 'active' }] });
  } finally { release?.(); }
}, 30000);

it.skipIf(process.platform !== 'linux')('119-C1 F4: eligible new AI can park its first refusal before any launch or reservation', async () => {
  const f = await sessionRuntime(); await f.restart();
  vi.spyOn(runs, 'reserveConfiguredRunTasks').mockRejectedValue(ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED'));
  const answer = await f.ask('prelaunch-refusal');
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.propose('prelaunch-refusal');
  await expect.poll(() => f.errors, { timeout: 6000 }).toContainEqual({ id: 'prelaunch-refusal', code: 'RUN_PROGRESSION_PARKED' });
  const ai = withMcpPrincipal(readLocalOsIdentity);
  const receipts = f.rows('SELECT command FROM run_receipts').map(row => JSON.parse(String((row as { command: string }).command)));
  expect(receipts.filter(value => value.action === 'park-progression')).toEqual([expect.objectContaining({ runId: 'prelaunch-refusal', actor: expect.objectContaining({ id: ai.id, issuer: ai.issuer, subject: ai.subject }) })]);
  expect(f.launched).toEqual([]); expect(f.rows('SELECT * FROM attempts')).toEqual([]); expect(f.rows('SELECT * FROM dispatches')).toEqual([]);
}, 30000);

it.skipIf(process.platform !== 'linux')('119-C1 configured cancellation while FIFO waits prevents actual dispatch without borrowing the person identity', async () => {
  const execute = execution.executeConfiguredTask, f = await sessionRuntime(); await f.restart();
  let queued!: () => Promise<void>, release!: () => void;
  vi.spyOn(RuntimeServiceLifecycle.prototype, 'admitExecution').mockImplementation(async work => { await new Promise<void>((resolve, reject) => { queued = () => work().then(resolve, reject); release = resolve; }); });
  const seen: ReturnType<typeof readLocalOsIdentity>[] = [], failures: string[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (...args) => {
    seen.push(readLocalOsIdentity()); try { return await execute(...args); } catch (error) { failures.push((error as { code: string }).code); throw error; }
  });
  const answer = await f.ask('cancel-queued'); expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.propose('cancel-queued');
  try {
    await expect.poll(() => typeof queued, { timeout: 6000 }).toBe('function');
    const row = f.rows('SELECT revision FROM runs')[0] as { revision: number };
    await f.client.requestRunCancellation({ schemaVersion: 1, scopeId: 'scope', runId: 'cancel-queued', commandId: 'cancel-race', action: 'cancel', expectedRevision: row.revision });
    await withLocalPrincipalChannel(undefined, () => queued()).catch(() => undefined); release();
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject(withMcpPrincipal(readLocalOsIdentity));
    expect(failures).toEqual(['RUN_STORE_CONFLICT']); expect(f.rows('SELECT * FROM dispatches')).toEqual([]); expect(f.launched).toEqual([]);
  } finally { release?.(); }
}, 30000);

it.skipIf(process.platform !== 'linux')('119-C1 configured company boundary: startup refuses a foreign registered own scope before any AI reservation or execution', async () => {
  const f = await sessionRuntime(); await f.pool('hold'); const answer = await f.ask('foreign-company');
  expect((await terminalRequest(f, 'decideApproval', answer)).response).toMatchObject({ ok: true }); await f.propose('foreign-company');
  f.exec("INSERT INTO companies(company_id) VALUES('foreign'); UPDATE scope_registry SET company_id='foreign' WHERE scope_id='scope'");
  await expect(f.restart()).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_SCOPE_FOREIGN' });
  expect(f.rows('SELECT * FROM attempts')).toEqual([]); expect(f.rows('SELECT * FROM dispatches')).toEqual([]); expect(f.launched).toEqual([]);
}, 30000);
