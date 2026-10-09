import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgentTurn, agentTurnTruncatedCallsNote, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
import { MESSAGE_REGISTRY } from '#platform/index.js';
import { footerText, formatContextTokens, cells } from '#surfaces/core/terminal-render/index.js';
import { terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';

describe('terminal turn-outcome catalog guard', () => {
  it('every producer outcome key has EN/TR text and identical placeholders; closures cannot return literal prose', () => {
    const producers = ['loop.ts', 'durable.ts', 'store.ts'].map(file => readFileSync(`src/engine/core/agent-turn/internal/${file}`, 'utf8')).join('\n');
    const used = [...producers.matchAll(/t\('(agent\.turn\.outcome\.[\w]+)'/g)].map(match => match[1]!);
    const en = MESSAGE_REGISTRY.catalogs.en, tr = MESSAGE_REGISTRY.catalogs.tr;
    const keys = Object.keys(en).filter(key => key.startsWith('agent.turn.outcome.'));
    expect([...new Set(used)].sort()).toEqual(keys.sort());
    for (const key of keys) {
      expect(tr[key], key).toBeTruthy(); expect(tr[key], key).not.toBe(en[key]);
      const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      expect(params(tr[key]!), key).toEqual(params(en[key]!));
    }
    expect(producers).not.toMatch(/finish\('[^']+',\s*[`'"][A-Z]/);
    expect(producers).not.toMatch(/note:\s*['"`][A-Z]/);
  });

  for (const locale of ['en', 'tr'] as const) {
    it.each(['content-filter', 'context-window', 'network-error', 'resource-exhausted', 'aborted'] as const)(`${locale}: provider %s keeps usage and closes without a retry or tool effect`, async providerStop => {
      let sends = 0, executions = 0;
      const events: { kind: string; note?: string | null }[] = [];
      const result = await runAgentTurn({ language: locale, messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
        emit: event => events.push(event) }, {
        invokeRound: async () => { sends++; return { status: 'responded', content: '', reasoning: '', toolCalls: [], finish: 'vendor-stop', providerStop,
          usage: { promptTokens: 10, completionTokens: 2 } }; }, authorize: async () => 'allow', describe: () => null,
        execute: async () => { executions++; return { status: 'ok', text: '' }; }, now: () => 1,
      });
      expect(result.finish).toBe('error'); expect(sends).toBe(1); expect(executions).toBe(0);
      expect(events.filter(event => event.kind === 'usage')).toHaveLength(1); expect(events.filter(event => event.kind === 'message')).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ kind: 'done', note: result.note });
      expect(result.note).toContain(locale === 'tr' ? 'Sağlayıcı bu turu durdurdu' : 'The provider stopped this turn');
      expect(result.note).toContain(locale === 'tr' ? 'geçerli son ölçüm' : 'final measurement');
    });
    it.each([
      ['HTTP refusal', { status: 'failed', state: 'rejected: HTTP 400' }, 'error', 'Model turu yanıt alınamadan'],
      ['empty response', { status: 'responded', content: '', reasoning: '', toolCalls: [], finish: 'stop', usage: null }, 'error', 'Model yanıt vermedi'],
      ['output exhausted', { status: 'responded', content: '', reasoning: 'thought', toolCalls: [], finish: 'length', usage: null }, 'length', 'çıktı sınırına ulaştı'],
    ] as const)(`${locale}: %s reaches done.note in its locale without a retry`, async (_name, outcome, finish, expectedTr) => {
      let sends = 0, executions = 0;
      const events: { kind: string; note?: string | null }[] = [];
      const ports: AgentTurnPorts = { invokeRound: async () => { sends++; return outcome as AgentRoundOutcome; }, authorize: async () => 'allow',
        describe: () => null, execute: async () => { executions++; return { status: 'ok', text: '' }; }, now: () => 1 };
      const result = await runAgentTurn({ language: locale, messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
        emit: event => events.push(event) }, ports);
      expect(result.finish).toBe(finish); expect(sends).toBe(1); expect(executions).toBe(0);
      expect(events.at(-1)).toMatchObject({ kind: 'done', note: result.note });
      if (locale === 'tr') { expect(result.note).toContain(expectedTr); expect(result.note).toContain('Hiçbir araç çağrısı çalıştırılmadı'); expect(result.note).not.toMatch(/The model|no tool call|without an answer/); }
      else expect(result.note).toMatch(/The model/);
    });
    it(`${locale}: cancellation and truncated calls also use the catalog`, async () => {
      const controller = new AbortController(); controller.abort();
      const ports: AgentTurnPorts = { invokeRound: async () => { throw new Error('must not send'); }, authorize: async () => 'deny', describe: () => null,
        execute: async () => { throw new Error('must not execute'); }, now: () => 1 };
      const result = await runAgentTurn({ language: locale, messages: [], tools: [], signal: controller.signal, emit: () => undefined }, ports);
      expect(result.note).toContain(locale === 'tr' ? 'İptal edildi' : 'Cancelled');
      expect(agentTurnTruncatedCallsNote(2, 8192, locale)).toContain(locale === 'tr' ? 'çalıştırılmadı' : 'not run');
    });
  }
});

it('context footer formats the current model window with TR/EN digits and keeps the numeric percentage', () => {
  for (const [locale, expected] of [['tr', '1,05 M'], ['en', '1.05 M']] as const) {
    const labels = terminalRenderLabels(locale);
    const text = footerText({ kind: 'footer', elapsedMs: 1000, promptTokens: null, completionTokens: null, reasoningTokens: null, finish: 'stop',
      context: { promptTokens: 30_000, windowTokens: 1_050_000, quality: 'upper-bound' } }, labels, '·');
    expect(text).toContain(expected); expect(text).toContain(locale === 'tr' ? '~%3' : '~3%'); expect(text).not.toContain('1050000'); expect(cells(text)).toBeLessThan(80);
    expect(formatContextTokens(1_000_000, locale)).toBe('1 M'); expect(formatContextTokens(128_000, locale)).toBe('128 k');
  }
});
