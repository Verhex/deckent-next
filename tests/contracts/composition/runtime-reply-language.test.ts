import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { runtime } from '../support/chat-turn-harness.js';

// LANG-CRASH (live session 1d428e9f, owner: "tamamen Türkçe iletişim istiyorum, ihlal edilemez"): the local model answered several turns in
// English after Turkish questions. The service prompt (v5) names the reply language of the person's locale in every sent round, the compaction
// call writes its summary in it, and the round after a compaction still carries it; the client's history never holds the service segment.
const longHistory = () => [{ role: 'system' as const, content: 'SYS' }, ...Array.from({ length: 16 }, (_, i) => i % 2
  ? { role: 'assistant' as const, content: `answer ${i}`, toolCalls: [] } : { role: 'user' as const, content: `soru ${i}` }),
{ role: 'user' as const, content: 'a.ts şimdi ne dışa aktarıyor?' }];
const summary = '{"objective":"a.ts","findings":[],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}';
type Sent = { messages: { role: string; content: string }[] };

describe.skipIf(process.platform !== 'linux')('reply language through the runtime service (prompt v5)', () => {
  it('the service locale: every round, the compaction call and the round after it state Turkish; nothing the client keeps holds it', async () => {
    const f = await runtime({ tokenize: true, windowTokens: 100_000, count: body => body.messages.length > 12 ? 90_000 : 900, serviceLanguage: 'tr' }); await f.start();
    f.state.script = [{ summary }, { content: 'Hâlâ a.' }];
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-language', messages: longHistory() }, event => events.push(event)))
      .toMatchObject({ finish: 'stop', answer: 'Hâlâ a.' });
    const [summaryCall, round] = f.state.requests as Sent[];
    expect(summaryCall!.messages[0]!.content).toMatch(/Write every string in Turkish \(Türkçe\);/);
    expect(summaryCall!.messages[0]!.content).not.toContain('language of the conversation');
    const system = round!.messages[0]!.content;
    expect(system).toContain('- Reply language: Turkish (Türkçe). Always answer the user in Turkish (Türkçe)');
    expect(system).toMatch(/- Write every reply to the user in Turkish \(Türkçe\)\.\n\nSYS$/);
    expect(events.some(event => (event.kind === 'compacted' && event.messages.some(message => message.content.includes('Reply language')))
      || (event.kind === 'message' && event.message.content.includes('Reply language')))).toBe(false);
  }, 30_000);

  it('a service without a locale in its environment or configuration states English', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ content: 'Hello.' }];
    await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-english', messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    const system = (f.state.requests[0] as Sent).messages[0]!.content;
    expect(system).toContain('- Reply language: English. Always answer the user in English:'); expect(system).not.toMatch(/Türkçe/);
  }, 30_000);
});
