import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeMcpTrustCard, type McpTrustCard } from '#adapters/index.js';

const launch: McpTrustCard = {
  phase: 'launch', name: 'local-catalog', scope: 'project', file: '/project/mcp.json', definitionDigest: 'a1b2c3d4e5f6',
  transport: 'stdio', command: 'node', args: ['catalog.mjs', '${TOKEN}'],
  variables: [{ name: 'TOKEN', set: true }, { name: 'OPTIONAL', set: false }], envNames: [], headerNames: [],
  realm: 'sandbox-net', posture: 'read-only /project', note: 'Catalog access',
};
const tools: McpTrustCard = {
  phase: 'tools', name: 'remote-catalog', scope: 'user', file: '/home/mcp.json', definitionDigest: 'f6e5d4c3b2a1',
  transport: 'http', command: 'https://catalog.example/mcp', args: [], variables: [], envNames: [], headerNames: ['X-Token'],
  realm: 'none', note: null, era: 'modern', protocolVersion: '2026-07-28',
  tools: [
    { name: 'lookup', digest: '1234567890abcdef', description: 'Look up a record', annotations: {}, alwaysAsk: true },
    { name: 'list', digest: 'fedcba0987654321', description: null, annotations: {}, alwaysAsk: false },
  ],
};

// Literal pre-change output: do not derive the English oracle from the catalogs or renderer.
const launchEnglish = [
  'MCP server local-catalog (project scope, /project/mcp.json) — start it?',
  'command: node catalog.mjs ${TOKEN}',
  'variables: TOKEN, OPTIONAL (unset)',
  'env: none',
  'realm: sandbox-net — read-only /project',
  'definition: a1b2c3d4e5f6',
  'note: Catalog access',
].join('\n');
const toolsEnglish = [
  'MCP server remote-catalog (user scope, /home/mcp.json) — trust it and pin these tools?',
  'url: https://catalog.example/mcp',
  'variables: none',
  'headers: X-Token',
  'realm: none',
  'definition: f6e5d4c3b2a1',
  'tools (2; modern 2026-07-28):',
  '  lookup 1234567890ab always-ask — Look up a record',
  '  list fedcba098765',
].join('\n');

afterEach(() => vi.unstubAllEnvs());

describe('MCP trust card i18n', () => {
  it.each([{ card: launch, english: launchEnglish }, { card: tools, english: toolsEnglish }])('preserves default and explicit English bytes for $card.phase', ({ card, english }) => {
    vi.stubEnv('DECKENT_LANGUAGE', 'tr');
    expect(describeMcpTrustCard(card)).toBe(english);
    expect(describeMcpTrustCard(card, 'en')).toBe(english);
  });

  it.each([launch, tools])('translates every human label but preserves machine values for $phase', card => {
    const text = describeMcpTrustCard(card, 'tr');
    const values = [card.name, card.scope, card.file, card.command, ...card.args, ...card.variables.map(variable => variable.name),
      ...card.envNames, ...card.headerNames, card.realm, card.definitionDigest, card.posture, card.note, card.era, card.protocolVersion,
      ...(card.tools?.flatMap(tool => [tool.name, tool.digest.slice(0, 12), tool.description]) ?? [])].filter((value): value is string => !!value);
    for (const value of values) expect(text).toContain(value);
    // HTTP's realm value "none" is protocol data, not the translated empty-list label.
    const labels = values.reduce((remaining, value) => remaining.replaceAll(value, ''), text);
    for (const label of ['MCP server', 'scope', 'start it?', 'trust it and pin these tools?', 'url:', 'command:', 'variables:',
      'none', '(unset)', 'headers:', 'env:', 'realm:', 'definition:', 'note:', 'tools (', 'always-ask']) {
      expect(labels).not.toContain(label);
    }
    expect(text).toContain('MCP sunucusu');
    expect(text).toContain('kapsamı');
    expect(text).toContain('yok');
    if (card.phase === 'launch') {
      expect(text).toContain('başlatılsın mı?');
      expect(text).toContain('OPTIONAL (ayarlanmamış)');
      expect(text).toContain('ortam değişkenleri: yok');
    } else {
      expect(text).toContain('güvenilip bu araçlar sabitlensin mi?');
      expect(text).toContain('değişkenler: yok');
      expect(text).toContain('araçlar (2; modern 2026-07-28):');
      expect(text).toContain('her zaman sor');
    }
  });
});
