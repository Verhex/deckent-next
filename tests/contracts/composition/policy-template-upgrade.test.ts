import { terminalApplication, terminalRequest } from '../support/approval-terminal.js';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, type AgentTurnStreamEvent } from '#domain/index.js';
import { FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_MCP_CALL_OPERATION_ID, FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID, FIRST_RUN_PROPOSE_MCP_TOOL_NAME, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES,
  FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID } from '#engine/index.js';
import { configuredPolicyTemplateUpgrade } from '#composition/core/approvals/index.js';
import { upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { closeModeRuntimes, me, modeRuntime } from '../support/agent-turn-modes.js';

// Owner request 2026-10-07 (lead): the existing-installation migration as one governed product command, `deckent policy upgrade --template v5`
// (preview, then apply through `policy.administer@1`: I2, `expect` revision, `authority-change` audit, authority archive as backup, rollback by id;
// hand-added rules kept, a second run changes nothing). Two policy shapes: (a) a first-run v4 policy whose person also holds the installation-owner
// role (authority to run the chain and to delegate) — the whole path to a real model call; (b) a pure first-run v4 policy — the preview names what
// the person lacks and apply writes nothing (the K1 decision point of the integration review).
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { await closeModeRuntimes(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const echo = { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };

/** The first-run v4 grants of this test's scope and person: the v5 template without its MCP rules and without the proposal tool. */
function v4Grants() {
  const v5 = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: FIRST_RUN_READ_TOOL_NAMES, scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES,
    scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES, writeOperationId: FIRST_RUN_WRITE_OPERATION_ID,
    shellOperationId: FIRST_RUN_SHELL_OPERATION_ID, proposeMcpToolName: FIRST_RUN_PROPOSE_MCP_TOOL_NAME, mcpCallOperationId: FIRST_RUN_MCP_CALL_OPERATION_ID, policyAdministerOperationId: FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID }).policy as
    unknown as { grants: { id: string; resource: { kind: string; ids: unknown } }[] };
  return v5.grants.filter(grant => !grant.id.startsWith('first-run-mcp-observe-') && !['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-backup'].includes(grant.id))
    .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: FIRST_RUN_READ_TOOL_NAMES } } : grant);
}
const HAND_ADDED = { id: 'hand-added-fetch', effect: 'require-approval', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['fetch_url'] } };

async function project(shape: 'owner-role' | 'pure') {
  const f = await modeRuntime({ grants: [], mode: 'full-auto' });
  const policy = JSON.parse(readFileSync(join(f.data, 'policy.json'), 'utf8')) as { grants: unknown[] };
  // (a) the harness's model/approval grants + v4 + one hand-added rule + the installation-owner role; (b) v4 alone.
  const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
  writeFileSync(join(f.data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: 'first-run-template-v4', separationOfDuties: [], restrictions: [],
    roles: shape === 'owner-role' ? [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) }] : [],
    grants: shape === 'owner-role' ? [...policy.grants, ...v4Grants(), HAND_ADDED] : v4Grants() }), { mode: 0o600 });
  writeFileSync(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'b-v4', modes: [{ id: 'me-mode', principal: me[0], scopes: ['scope'], mode: 'full-auto' }],
    bindings: shape === 'owner-role' ? [{ id: 'root', principals: me, roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' }] : [] }), { mode: 0o600 });
  const upgrade = (mode: 'preview' | 'apply' | 'rollback', expect?: string) => terminalApplication<Awaited<ReturnType<typeof configuredPolicyTemplateUpgrade>>>(f, 'policy-upgrade', 'scope',
    { mode, reason: 'test upgrade', ...(expect ? { expect } : {}) });
  const grants = () => (JSON.parse(readFileSync(join(f.data, 'policy.json'), 'utf8')) as { grants: { id: string; resource: { kind: string; ids: unknown } }[] }).grants;
  return { f, upgrade, grants, bytes: () => readFileSync(join(f.data, 'policy.json'), 'utf8') };
}
async function turnOf(f: Awaited<ReturnType<typeof modeRuntime>>, name: string, args: Record<string, unknown>, decision: 'allow' | 'deny', turnId: string) {
  f.script(name, args);
  const answer = await terminalRequest(f, 'chatTurn', { schemaVersion: 1, scopeId: 'scope', turnId, messages: [{ role: 'user', content: 'go' }] }, decision);
  const events = answer.events as AgentTurnStreamEvent[];

  const finished = events.find(event => event.kind === 'tool.finished');
  return { cards: events.filter(event => event.kind === 'approval.requested').length, status: finished?.kind === 'tool.finished' ? finished.status : null };
}

describe.skipIf(process.platform !== 'linux')('deckent policy upgrade --template v5 (governed migration, owner request 2026-10-07)', () => {
  it('refuses the subordinate human decision in a noninteractive policy upgrade without changing policy authority', async () => {
    const { f, bytes } = await project('owner-role');
    const before = bytes();
    await expect(configuredPolicyTemplateUpgrade(f.project, 'scope', { env: f.env }, { mode: 'apply', reason: 'headless' }))
      .rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    expect(bytes()).toBe(before);
    expect(f.audit().filter(entry => entry.event.subject['kind'] === 'authority-change')).toHaveLength(0);
  });

  it('(a) preview → apply on the previewed revision → a second run changes nothing; hand-added rules stay; audited and archived; trust then writes the grant and the model calls the tool without a card in full-auto; a rollback while a trust grant is held is refused by I2', async () => {
    const { f, upgrade, grants } = await project('owner-role');
    const before = grants().map(grant => grant.id);
    const preview = await upgrade('preview');
    expect(preview).toMatchObject({ status: 'preview', missing: [] });
    // The harness's own approval grant already covers approval inspect/decide, so that rule is not added again.
    expect(preview.rules.map(rule => rule.id)).toEqual(['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-mcp-propose-tool', 'first-run-policy-administer', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account']);
    expect(preview.summary).toContain('+ grant first-run-mcp-servers');
    // Security: the plan never grants another principal (each added rule names this person alone).
    for (const rule of preview.rules) expect(rule.principals).toEqual(rule.id.startsWith('first-run-mcp-observe-') ? [{ ...me[0]!, issuer: `${me[0]!.issuer}/mcp` }] : me);
    expect(grants().map(grant => grant.id)).toEqual(before); // preview writes nothing
    expect(await upgrade('apply', 'stale-revision')).toMatchObject({ status: 'conflict' });
    expect(await upgrade('apply', preview.revision)).toMatchObject({ status: 'upgraded' });
    expect(grants().map(grant => grant.id)).toEqual([...before, ...['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-mcp-propose-tool', 'first-run-policy-administer', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-model-invocation', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account']]);
    expect(grants().find(grant => grant.id === HAND_ADDED.id)).toEqual(HAND_ADDED);
    expect(await upgrade('apply')).toMatchObject({ status: 'current' });
    expect(f.audit().filter(entry => entry.event.subject['kind'] === 'authority-change')).toHaveLength(1);
    expect(existsSync(join(f.data, 'audit', 'authority-revisions'))).toBe(true);
    // The upgraded installation: the first-use trust windows (yes) write this person's mcp-server grant; full-auto then runs the call without a card.
    const root = mkdtempSync(join(tmpdir(), 'deckent-upgrade-mcp-')); roots.push(root);
    const tools = join(root, 'tools.json'), log = join(root, 'log.jsonl'); writeFileSync(tools, JSON.stringify([echo])); appendFileSync(log, '');
    mkdirSync(join(f.project, '.deckent'), { recursive: true });
    writeFileSync(join(f.project, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log], realm: 'host' } } }));
    expect((await turnOf(f, 'mcp__files__echo', { text: 'trust' }, 'allow', 't1')).status).toBe('ok');
    expect(grants().filter(grant => grant.id.startsWith('mcp-')).map(grant => [grant.resource.kind, grant.resource.ids])).toEqual([['mcp-server', ['files']]]);
    expect(await turnOf(f, 'mcp__files__echo', { text: 'auto' }, 'deny', 't2')).toEqual({ cards: 0, status: 'ok' });
    const calls = readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"call"'));
    expect(calls).toHaveLength(2);
    // I2 also bounds removal: while this person holds a trust grant (require-approval) on a server, removing their own `allow` over every server is
    // outside what they could grant, so the rollback is refused and nothing changes; revoking the server's trust first makes it possible.
    expect(await upgrade('rollback')).toMatchObject({ status: 'refused', missing: ['delegation'] });
    expect(grants().map(grant => grant.id).filter(id => id.startsWith('first-run-mcp') && !id.startsWith('first-run-mcp-observe-'))).toHaveLength(3);
  }, 180_000);

  it('(c) rollback before any server is trusted removes exactly the v5 rules it added (hand-added rules stay); a second rollback has nothing to remove', async () => {
    const { upgrade, grants } = await project('owner-role');
    expect(await upgrade('apply')).toMatchObject({ status: 'upgraded' });
    expect(await upgrade('rollback')).toMatchObject({ status: 'rolled-back', reason: 'first-run-mcp-servers,first-run-mcp-call-operation,first-run-mcp-propose-tool,first-run-policy-administer,first-run-secret-switch,first-run-model-activation,first-run-model-invocation,first-run-provider-spending,first-run-backup,first-run-mcp-observe-run,first-run-mcp-observe-scope,first-run-mcp-observe-approval,first-run-mcp-observe-model-activation,first-run-mcp-observe-model-invocation,first-run-mcp-observe-provider-spend-account' });
    expect(grants().map(grant => grant.id).filter(id => id.startsWith('first-run-mcp') && !id.startsWith('first-run-mcp-observe-'))).toEqual([]);
    expect(grants().some(grant => grant.id === HAND_ADDED.id)).toBe(true);
    expect(await upgrade('rollback')).toMatchObject({ status: 'nothing-to-roll-back' });
    expect(await upgrade('preview')).toMatchObject({ status: 'preview' });
  }, 120_000);

  it('(d) deckent init policy --upgrade (owner step): a first-run v4 policy with a hand-added MCP wire rule previews, applies on the previewed revision, stays current on a second run; then trust writes the grant and the model calls the tool (full-auto, no card); another person\'s first-run policy is not changed', async () => {
    const { f, grants, bytes } = await project('pure');
    const wire = { id: 'hand-mcp-files', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['mcp__files__echo'] } };
    // The harness's model and scope grants (the first-run template does not carry them) plus the hand-added rule, on the v4 revision.
    const harness = { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me,
      resource: { kind: 'model-invocation', ids: 'all' } }, scope = { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } };
    const v4 = JSON.parse(bytes()) as { grants: unknown[] };
    writeFileSync(join(f.data, 'policy.json'), JSON.stringify({ ...v4, grants: [...v4.grants, harness, scope, wire] }), { mode: 0o600 });
    const before = grants().map(grant => grant.id);
    const preview = await upgradePolicyTemplateInstallation(f.project, 'scope', false, undefined, { env: f.env });
    expect(preview).toMatchObject({ status: 'preview', revision: 'first-run-template-v4', wireRules: ['hand-mcp-files'], conflicts: [] });
    // v7: the harness's own model-invocation rule (ids all, this scope) covers the invocation rule; only activation is added.
    expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual(['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-mcp-propose-tool', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account']);
    expect(grants().map(grant => grant.id)).toEqual(before);
    expect(await upgradePolicyTemplateInstallation(f.project, 'scope', true, 'first-run-template-v4', { env: f.env })).toMatchObject({ status: 'upgraded' });
    expect(grants().map(grant => grant.id)).toEqual([...before, ...['first-run-mcp-servers', 'first-run-mcp-call-operation', 'first-run-mcp-propose-tool', 'first-run-policy-administer', 'first-run-approvals', 'first-run-secret-switch', 'first-run-model-activation', 'first-run-backup', 'first-run-mcp-observe-run', 'first-run-mcp-observe-scope', 'first-run-mcp-observe-approval', 'first-run-mcp-observe-model-activation', 'first-run-mcp-observe-model-invocation', 'first-run-mcp-observe-provider-spend-account']]);
    const upgraded = bytes();
    expect(await upgradePolicyTemplateInstallation(f.project, 'scope', true, undefined, { env: f.env })).toMatchObject({ status: 'current' });
    expect(bytes()).toBe(upgraded);
    const root = mkdtempSync(join(tmpdir(), 'deckent-upgrade-init-')); roots.push(root);
    const tools = join(root, 'tools.json'), log = join(root, 'log.jsonl'); writeFileSync(tools, JSON.stringify([echo])); appendFileSync(log, '');
    mkdirSync(join(f.project, '.deckent'), { recursive: true });
    writeFileSync(join(f.project, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log], realm: 'host' } } }));
    expect((await turnOf(f, 'mcp__files__echo', { text: 'trust' }, 'allow', 't1')).status).toBe('ok');
    expect(grants().filter(grant => grant.id.startsWith('mcp-')).map(grant => [grant.resource.kind, grant.resource.ids])).toEqual([['mcp-server', ['files']]]);
    expect(await turnOf(f, 'mcp__files__echo', { text: 'auto' }, 'deny', 't2')).toEqual({ cards: 0, status: 'ok' });
    // Another person's first-run policy (the read rule names someone else): not this person's to upgrade; nothing is written.
    const other = { ...JSON.parse(upgraded) as { grants: { id: string; principals: unknown }[] } };
    const theirs = { ...other, revision: 'a-other', grants: other.grants.map(grant => grant.id === 'first-run-read-tools' ? { ...grant, principals: [{ issuer: 'os', subject: 'someone-else' }] } : grant) };
    writeFileSync(join(f.data, 'policy.json'), JSON.stringify(theirs), { mode: 0o600 });
    const kept = bytes();
    expect(await upgradePolicyTemplateInstallation(f.project, 'scope', true, undefined, { env: f.env })).toMatchObject({ status: 'unavailable', reason: 'not-this-person' });
    expect(bytes()).toBe(kept);
  }, 180_000);

  it('(e) rollback never locks the owner out: on a v5 policy whose only policy.administer and approval rules are the template\'s, it is refused (lockout) and nothing changes', async () => {
    const { f, upgrade, bytes } = await project('pure');
    const v5 = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: FIRST_RUN_READ_TOOL_NAMES, scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES,
      scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES, writeOperationId: FIRST_RUN_WRITE_OPERATION_ID,
      shellOperationId: FIRST_RUN_SHELL_OPERATION_ID, proposeMcpToolName: FIRST_RUN_PROPOSE_MCP_TOOL_NAME, mcpCallOperationId: FIRST_RUN_MCP_CALL_OPERATION_ID,
      policyAdministerOperationId: FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID }).policy;
    writeFileSync(join(f.data, 'policy.json'), JSON.stringify(v5), { mode: 0o600 });
    const before = bytes();
    const refused = await upgrade('rollback');
    expect(refused).toMatchObject({ status: 'refused' });
    expect(refused.missing).toContain('lockout');
    expect(bytes()).toBe(before);
  }, 120_000);

  it('(b) a pure first-run v4 policy: the preview names what the person lacks (policy.administer, deciding the card, the authority itself); apply writes nothing', async () => {
    const { f, upgrade, bytes } = await project('pure');
    const before = bytes();
    expect(await upgrade('preview')).toMatchObject({ status: 'preview', missing: ['policy-administer', 'approval-decide', 'delegation'] });
    expect(await upgrade('apply')).toMatchObject({ status: 'refused', missing: ['policy-administer', 'approval-decide', 'delegation'] });
    expect(bytes()).toBe(before);
    // Security: the governed path writes nothing and records no authority change for a person without policy.administer.
    expect(f.audit().filter(entry => entry.event.subject['kind'] === 'authority-change')).toEqual([]);
  }, 120_000);
});
