import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { landlockShellSandbox, probeShellCapabilities, type ShellSandboxFactory } from '#adapters/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// Astra 2162 (owner F2): the product's own state under an ignored ancestor (`.cache/deckent`) through a real turn and a real sandbox:
// a command naming the ledger is refused in the plan (no card — product management is not opened by any approval), and one that
// reaches it past the classifier (a command substitution asks and is allowed) meets the sandbox's own refusal, in both realms.
const measured = await probeShellCapabilities();
const bwrapReady = measured.bubblewrap === 'available' && measured.userNamespace === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockOnly = (abi: number): ShellSandboxFactory => layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable({ platform: 'linux',
  bubblewrap: 'unavailable', userNamespace: 'available', landlock: { status: 'available', abi } }) }];
const shellGrants = [
  { id: 'shell-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const toolText = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0] ?? '';
const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'show me the ledger' }] });

async function productStateTurn(sandboxes: ShellSandboxFactory | undefined, marker: string) {
  const f = await runtime({ toolGrant: false, extraGrants: shellGrants, shell: { schemaVersion: 1, realm: 'require-sandbox' }, dataRoot: '.cache/deckent', ...(sandboxes ? { sandboxes } : {}) });
  await f.start();
  const client = f.client();
  const turn = async (turnId: string, command: string) => {
    f.state.script = [...f.state.script.slice(0, f.state.requests.length), { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command }) } }, { content: 'Ok.' }];
    const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask(turnId), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: `${turnId}-allow`, expectedRevision: event.revision, decision: 'allow', reason: 'The sandbox must refuse it' }));
    });
    await Promise.all(pending);
    return events;
  };
  const literal = await turn('turn-product-literal', 'cat .cache/deckent/state/ledger.db');
  expect(literal.some(event => event.kind === 'approval.requested')).toBe(false);
  expect(toolText(literal)).toMatch(/^\[deckent\] run_shell: error=PRODUCT_STATE_PROTECTED \(\.cache\/deckent\/state\/ledger\.db\)/u);
  expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([]);
  const reached = await turn('turn-product-reached', 'cat "$(printf %s .cache/deckent/state/ledger.db)" 2>&1; echo "cat=$?"; echo x >> "$(printf %s .cache/deckent/state/ledger.db)" 2>&1; echo "append=$?"');
  expect(reached.some(event => event.kind === 'approval.requested')).toBe(true);
  const text = toolText(reached), lines = text.split('\n');
  expect(text).toMatch(new RegExp(`^\\[deckent\\] run_shell: ${marker}; exit 0`, 'u')); expect(text).not.toContain('SQLite format');
  expect(lines).toContain('cat=1'); expect(lines).toContain('append=1'); expect(text.match(/Permission denied/gu)?.length).toBe(2);
  expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }]);
}

describe.skipIf(process.platform !== 'linux')('product state under an ignored ancestor through a real turn (Astra 2162)', () => {
  it.skipIf(!bwrapReady)('S9: plan refusal without a card, then the bubblewrap floor', async () => { await productStateTurn(undefined, 'sandbox: bubblewrap'); }, 30_000);
  it.skipIf(landlockAbi < 1)('S11: plan refusal without a card, then the Landlock floor', async () => { await productStateTurn(landlockOnly(landlockAbi), 'sandbox: landlock'); }, 30_000);
});
