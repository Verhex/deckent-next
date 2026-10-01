import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { landlockShellSandbox, type ShellSandboxFactory } from '#adapters/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { measureTestShellHost, linuxShellHost } from '../../fixtures/shell-host.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

// Astra 2162 (owner F2): the product's own state under an ignored ancestor (`.cache/deckent`) through a real turn and a real sandbox:
// a command naming the ledger is refused in the plan (no card — product management is not opened by any approval), and one that
// reaches it past the classifier (a command substitution asks and is allowed) meets the sandbox's own refusal, in both realms.
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockOnly = (abi: number): ShellSandboxFactory => layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi } })) }];
const shellGrants = [
  { id: 'shell-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const toolText = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0] ?? '';
const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'show me the ledger' }] });

async function productStateTurn(sandboxes: ShellSandboxFactory | undefined, marker: string, dataRoot = '.cache/deckent') {
  const f = await runtime({ toolGrant: false, extraGrants: shellGrants, shell: { schemaVersion: 1, realm: 'require-sandbox' }, dataRoot, ...(sandboxes ? { sandboxes } : {}) });
  await f.start();
  const client = f.client();
  const turn = async (turnId: string, command: string) => {
    f.state.script = [...f.state.script.slice(0, f.state.requests.length), { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command }) } }, { content: 'Ok.' }];
    const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask(turnId), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: `${turnId}-allow`, expectedRevision: event.revision, decision: 'allow', reason: 'The sandbox must refuse it' }));
    });
    await Promise.all(pending);
    return events;
  };
  const literal = await turn('turn-product-literal', `cat '${dataRoot}/state/ledger.db'`);
  expect(literal.some(event => event.kind === 'approval.requested')).toBe(false);
  expect(toolText(literal).startsWith(`[deckent] run_shell: error=PRODUCT_STATE_PROTECTED (${dataRoot}/state/ledger.db)`), toolText(literal)).toBe(true);
  expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([]);
  const reached = await turn('turn-product-reached', `cat "$(printf %s '${dataRoot}/state/ledger.db')" 2>&1; echo "cat=$?"; echo x >> "$(printf %s '${dataRoot}/state/ledger.db')" 2>&1; echo "append=$?"`);
  expect(reached.some(event => event.kind === 'approval.requested')).toBe(true);
  const text = toolText(reached), lines = text.split('\n');
  expect(text).toMatch(new RegExp(`^\\[deckent\\] run_shell: ${marker}; exit 0`, 'u')); expect(text).not.toContain('SQLite format');
  expect(lines).toContain('cat=1'); expect(lines).toContain('append=1'); expect(text.match(/Permission denied/gu)?.length).toBe(2);
  expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }]);
}

// Astra 2166: a data root the deny language cannot name literally (`?`/`*`) is refused at service start with the typed layout error —
// no turn, no sandbox view is ever built on it; brackets keep working (above).
describe.skipIf(process.platform !== 'linux')('layout admission refuses wildcard product paths (Astra 2166)', () => {
  for (const dataRoot of ['.cache/deckent?1', '.cache/deck*ent']) {
    it(`refuses ${dataRoot} where the layout is resolved and at service start, with LAYOUT_PATH_UNEXPRESSIBLE`, async () => {
      // The fixture's own layout resolution (the same function every entry uses) refuses it before any file is prepared …
      await expect(runtime({ toolGrant: false, extraGrants: shellGrants, dataRoot })).rejects.toMatchObject({ code: 'LAYOUT_PATH_UNEXPRESSIBLE' });
      // … and a service started on a configuration naming such a data root refuses to start (typed configuration error, no ledger, no turn).
      const root = await mkdtemp(join(tmpdir(), 'deckent-wildcard-layout-')); roots.push(root);
      const project = join(root, 'project'), data = join(project, dataRoot);
      await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { recursive: true, mode: 0o700 });
      await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ layout: { root: data } }), { mode: 0o600 });
      await expect(startConfiguredRuntimeService(project, { async onPage() {}, async onError() {} }, { env: { HOME: join(root, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } }))
        .rejects.toMatchObject({ message: expect.stringContaining('LAYOUT_PATH_UNEXPRESSIBLE') });
      expect(existsSync(join(data, 'state'))).toBe(false);
    }, 30_000);
  }
});

describe.skipIf(process.platform !== 'linux')('product state under an ignored ancestor through a real turn (Astra 2162)', () => {
  it.skipIf(!bwrapReady)('S9: plan refusal without a card, then the bubblewrap floor', async () => { await productStateTurn(undefined, 'sandbox: bubblewrap'); }, 30_000);
  it.skipIf(landlockAbi < 1)('S11: plan refusal without a card, then the Landlock floor', async () => { await productStateTurn(landlockOnly(landlockAbi), 'sandbox: landlock'); }, 30_000);
  // Astra 2164: a data root with brackets (`[` is literal to the deny matcher) is protected the same way in both realms.
  it.skipIf(!bwrapReady)('S9: a bracketed data root stays closed (Astra 2164)', async () => { await productStateTurn(undefined, 'sandbox: bubblewrap', '.cache/deckent[1]'); }, 30_000);
  it.skipIf(landlockAbi < 1)('S11: a bracketed data root stays closed (Astra 2164)', async () => { await productStateTurn(landlockOnly(landlockAbi), 'sandbox: landlock', '.cache/deckent[1]'); }, 30_000);
});
