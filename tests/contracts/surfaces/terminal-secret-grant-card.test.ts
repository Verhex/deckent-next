import { afterEach, describe, expect, it } from 'vitest';
import { ErrorRegistry } from '#platform/index.js';
import { credentialSourceError } from '#engine/index.js';
import { secretGrantTurn, type SecretGrantCardPort, type SecretGrantQuestion, type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// PRE-8 first-use card (owner decisions 2026-10-21 #pre8-secret-model-2026-10-21 and #pre8-v2-decisions-2026-10-21 1): a turn whose provider key
// lives in the main vault without a grant in this project is refused before anything is sent; on a solo human terminal one card asks; yes records
// the grant through the governed path and the same turn starts again; no, Enter, Esc or Ctrl+C record nothing and the turn shows the typed refusal.
const refusal = (name = 'DECKENT_ANTHROPIC_KEY') => credentialSourceError('SECRET_GRANT_REQUIRED', { name, project: '/work/erp', scopeId: 'scope-a' });
const QUESTION: SecretGrantQuestion = { title: 'GRANT-CARD {name}', lines: [{ label: 'WHERE', text: 'PROJECT' }], prompt: 'GRANT-KEYS' };
function card(offer = true, grant: (name: string) => Promise<void> = async () => {}) {
  const calls = { offer: 0, grant: [] as string[], questions: [] as Array<{ name: string; project: string }> };
  const port: SecretGrantCardPort = {
    async offer() { calls.offer++; return offer; },
    question(name, project) { calls.questions.push({ name, project }); return { ...QUESTION, title: `GRANT-CARD ${name} ${project}` }; },
    async grant(name) { calls.grant.push(name); await grant(name); },
  };
  return { port, calls };
}
/** A turn refused at its preflight until `granted()` says otherwise; then one answer and done. */
function turns(granted: () => boolean, code: 'refuse' | 'other' = 'refuse') {
  let starts = 0;
  const start = () => (async function* (): AsyncGenerator<TurnDelta> {
    starts++;
    if (code === 'other') throw ErrorRegistry.createError('TERMINAL_CHAT_NOT_CONFIGURED');
    if (!granted()) throw refusal();
    yield { kind: 'text', text: 'ANSWER-AFTER-GRANT' };
    yield { kind: 'done', finish: 'stop' } as TurnDelta;
  })();
  return { start, starts: () => starts };
}
async function drain(stream: AsyncIterable<TurnDelta>) { const seen: TurnDelta[] = []; for await (const delta of stream) seen.push(delta); return seen; }

describe('PRE-8 first-use card: the turn wrapper', () => {
  it('yes records exactly one grant for the refused name and starts the same turn once more', async () => {
    let granted = false;
    const { port, calls } = card(true, async () => { granted = true; });
    const turn = turns(() => granted), asked: SecretGrantQuestion[] = [];
    const seen = await drain(secretGrantTurn(turn.start, port, async question => { asked.push(question); return true; }, new AbortController().signal));
    expect(calls.grant).toEqual(['DECKENT_ANTHROPIC_KEY']);
    expect(calls.questions).toEqual([{ name: 'DECKENT_ANTHROPIC_KEY', project: '/work/erp' }]);
    expect(asked).toHaveLength(1);
    expect(turn.starts()).toBe(2);
    expect(seen[0]).toEqual({ kind: 'text', text: 'ANSWER-AFTER-GRANT' });
  });
  it('no (or no answer) records nothing and the turn ends with the typed refusal', async () => {
    for (const answer of [false]) {
      const { port, calls } = card();
      const turn = turns(() => false);
      await expect(drain(secretGrantTurn(turn.start, port, async () => answer, new AbortController().signal))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
      expect(calls.grant).toEqual([]);
      expect(turn.starts()).toBe(1);
    }
  });
  it('a terminal that may not answer (team or enterprise, no human terminal) shows no card: the refusal names the admin command', async () => {
    const { port, calls } = card(false);
    const turn = turns(() => false);
    let asked = 0;
    const failure = await drain(secretGrantTurn(turn.start, port, async () => { asked++; return true; }, new AbortController().signal)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect((failure as { suggestion?: string }).suggestion).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope scope-a');
    expect(asked).toBe(0);
    expect(calls.grant).toEqual([]);
  });
  it('asks at most once per turn: a refusal after the grant is shown, never a second card', async () => {
    const { port, calls } = card();
    const turn = turns(() => false);
    let asked = 0;
    await expect(drain(secretGrantTurn(turn.start, port, async () => { asked++; return true; }, new AbortController().signal))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(asked).toBe(1);
    expect(calls.grant).toEqual(['DECKENT_ANTHROPIC_KEY']);
    expect(turn.starts()).toBe(2);
  });
  it('a refusal of a turn already bound to the service (sent) is never answered by the card', async () => {
    const { port, calls } = card();
    const turn = turns(() => false);
    await expect(drain(secretGrantTurn(turn.start, port, async () => true, new AbortController().signal, () => true))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(calls.offer).toBe(0);
    expect(calls.grant).toEqual([]);
    expect(turn.starts()).toBe(1);
  });
  it('another refusal, a cancelled turn or a failed grant never opens the card or retries blindly', async () => {
    const other = card(), otherTurn = turns(() => false, 'other');
    await expect(drain(secretGrantTurn(otherTurn.start, other.port, async () => true, new AbortController().signal))).rejects.toMatchObject({ code: 'TERMINAL_CHAT_NOT_CONFIGURED' });
    expect(other.calls.offer).toBe(0);
    const aborted = new AbortController(); aborted.abort();
    const cancelled = card(), cancelledTurn = turns(() => false);
    await expect(drain(secretGrantTurn(cancelledTurn.start, cancelled.port, async () => true, aborted.signal))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(cancelled.calls.grant).toEqual([]);
    const mid = new AbortController(), midCard = card(), midTurn = turns(() => false);
    await expect(drain(secretGrantTurn(midTurn.start, midCard.port, async () => { mid.abort(); return true; }, mid.signal))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(midCard.calls.grant).toEqual([]);
    const denied = card(true, async () => { throw ErrorRegistry.createError('SECRET_CHANGE_DENIED', { params: { action: 'set', name: 'DECKENT_ANTHROPIC_KEY' } }); });
    const deniedTurn = turns(() => false);
    await expect(drain(secretGrantTurn(deniedTurn.start, denied.port, async () => true, new AbortController().signal))).rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED' });
    expect(deniedTurn.starts()).toBe(1);
  });
});

describe('PRE-8 first-use card: the agent turn preflight', () => {
  const input = { projectRoot: '/work/erp', scopeId: 'scope-a', messages: [{ role: 'user' as const, content: 'hi' }], options: {} };
  it('checks the turn\'s credential after the configuration preflight and before the service is contacted', async () => {
    const order: string[] = [];
    const ports = { preflight: async () => { order.push('preflight'); }, credential: async () => { order.push('credential'); throw refusal(); },
      chatTurn: async () => { order.push('chatTurn'); throw new Error('unreachable'); }, cancelChatTurn: async () => undefined };
    await expect(drain(streamTerminalAgentTurn(input, ports as never))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(order).toEqual(['preflight', 'credential']);
  });
  it('passes the pinned model and scope to the credential check', async () => {
    const seen: unknown[] = [];
    const reference = { providerId: 'anthropic', providerVersion: 1, modelId: 'claude', modelVersion: 1 };
    const ports = { credential: async (...args: unknown[]) => { seen.push(args); throw refusal(); }, chatTurn: async () => { throw new Error('unreachable'); }, cancelChatTurn: async () => undefined };
    await expect(drain(streamTerminalAgentTurn({ ...input, reference }, ports as never))).rejects.toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(seen).toEqual([['/work/erp', {}, reference, 'scope-a']]);
  });
});

describe('PRE-8 first-use card: the workline window', () => {
  let view: ReturnType<typeof mountWorkline> | null = null;
  afterEach(() => { view?.instance.unmount(); view = null; });
  const mount = (granted: { value: boolean }, offer = true) => {
    const calls = { grant: [] as string[] };
    // As in production: the local preflight refuses before the turn is bound to the service; only an admitted turn binds.
    const streamTurn = (_messages: unknown, _signal: unknown, turn?: { sessionId?: string; onTurnBound?: (binding: unknown) => void }) => (async function* (): AsyncGenerator<TurnDelta> {
      if (!granted.value) throw refusal();
      turn?.onTurnBound?.({ scopeId: 'scope-a', sessionId: turn.sessionId ?? null, turnId: `turn-${calls.grant.length}`, phase: 'command-generated' });
      yield { kind: 'text', text: 'ANSWER-AFTER-GRANT' };
      yield { kind: 'done', finish: 'stop' } as TurnDelta;
    })();
    const secretGrant: SecretGrantCardPort = { offer: async () => offer, question: (name, project) => ({ title: `GRANT-CARD ${name} ${project}`, lines: [{ label: 'WHY', text: 'GRANT-DETAIL' }], prompt: 'GRANT-KEYS' }),
      grant: async name => { calls.grant.push(name); granted.value = true; } };
    view = mountWorkline({ context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope-a' }, streamTurn: streamTurn as never, secretGrant, errorText: (error: unknown) => `ERR:${(error as { code?: string }).code}` } as never, 200);
    return calls;
  };
  const send = async (text: string) => { await until(() => view!.stdout.frame.includes('READY'), 'ready'); view!.stdin.write(text); await settle(20); view!.stdin.write('\r'); };
  it('y on the card grants and the same message gets its answer', async () => {
    const granted = { value: false }, calls = mount(granted);
    await send('hello');
    await until(() => view!.stdout.frame.includes('GRANT-CARD DECKENT_ANTHROPIC_KEY /work/erp'), 'grant card');
    expect(view!.stdout.frame).toContain('GRANT-KEYS');
    // The turn waits for the person here, not for the model: no model tail under the card.
    expect(view!.stdout.frame).not.toContain('preparing');
    view!.stdin.write('y');
    await until(() => view!.stdout.text.includes('ANSWER-AFTER-GRANT'), 'answer after grant');
    expect(calls.grant).toEqual(['DECKENT_ANTHROPIC_KEY']);
    expect(view!.stdout.text).not.toContain('ERR:SECRET_GRANT_REQUIRED');
  });
  for (const [label, key] of [['n', 'n'], ['Enter', '\r'], ['Ctrl+C', '\u0003'], ['Esc', '\u001b']] as const) {
    it(`${label} on the card records nothing and the turn reports the typed refusal`, async () => {
      const granted = { value: false }, calls = mount(granted);
      await send('hello');
      await until(() => view!.stdout.frame.includes('GRANT-CARD'), 'grant card');
      view!.stdin.write(key);
      await until(() => view!.stdout.text.includes('ERR:SECRET_GRANT_REQUIRED'), 'typed refusal');
      expect(calls.grant).toEqual([]);
      expect(view!.stdout.text).not.toContain('ANSWER-AFTER-GRANT');
    });
  }
  it('a terminal that may not answer shows the refusal and no card', async () => {
    const granted = { value: false }, calls = mount(granted, false);
    await send('hello');
    await until(() => view!.stdout.text.includes('ERR:SECRET_GRANT_REQUIRED'), 'typed refusal');
    expect(view!.stdout.text).not.toContain('GRANT-CARD');
    expect(calls.grant).toEqual([]);
  });
});
