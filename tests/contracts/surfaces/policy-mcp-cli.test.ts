import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';
import { mcpCapabilityRegistry } from '#engine/index.js';
import type { McpCapabilityPreview, McpCapabilityRequest } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-mcp-cli-')); roots.push(root);
  await mkdir(join(root, '.deckent')); await mkdir(join(root, 'home'));
  await writeFile(join(root, '.deckent/config.json'), '{}');
  const seen: McpCapabilityRequest[] = [], principal = { issuer: 'host/mcp', subject: 'owner' };
  const preview: McpCapabilityPreview = { schemaVersion: 1, status: 'preview', scopeId: 'scope', groupId: 'spend', action: 'grant',
    revision: 'r1', principal, digest: 'digest', missing: [], change: null, rules: [] };
  const mcpCapabilities = {
    listMcpCapabilityScopes: async () => ['scope'],
    inspectMcpCapabilities: async () => ({ schemaVersion: 1 as const, scopeId: 'scope', revision: 'r1', principal,
      groups: mcpCapabilityRegistry.list().map(group => ({ group, managed: 'none' as const, effective: 'denied' as const })) }),
    changeMcpCapabilities: async (_root: string, input: McpCapabilityRequest) => { seen.push(input); return { ...preview, status: input.mode === 'apply' ? 'applied' as const : 'preview' as const }; },
  };
  const text = { out: '', err: '' };
  const context = { root, env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'home') }, mcpCapabilities,
    stdout: { write(value: string) { text.out += value; } }, stderr: { write(value: string) { text.err += value; } } };
  return { context, seen, text };
}

it('CLI registry/scope choice lists bilingual states, previews by default and forwards the selected digest for grant and revoke', async () => {
  for (const locale of ['en', 'tr']) {
    const { context, seen, text } = await fixture();
    expect(await main(['policy', 'mcp', 'list', '--lang', locale], context)).toBe(0);
    expect(text.out).toContain('dogfood-worker'); expect(text.out).toContain(locale === 'tr' ? 'Harcama' : 'Spending'); expect(seen).toEqual([]);
    text.out = '';
    expect(await main(['policy', 'mcp', 'grant', '--group', 'spend', '--scope', 'scope', '--json'], context)).toBe(0);
    expect(JSON.parse(text.out).digest).toBe('digest'); expect(seen[0]).toMatchObject({ mode: 'preview' });
    for (const action of ['grant', 'revoke']) {
      expect(await main(['policy', 'mcp', action, '--group', 'spend', '--scope', 'scope', '--apply', '--expect', 'digest'], context)).toBe(0);
      expect(seen.at(-1)).toMatchObject({ action, mode: 'apply', expect: 'digest' });
    }
  }
});

it('unknown values, arbitrary rule input and noncanonical flags never reach the change handler', async () => {
  const { context, seen } = await fixture();
  const prefix = ['policy', 'mcp', 'grant'];
  for (const suffix of [
    ['--group', 'unknown', '--scope', 'scope'], ['--group', 'spend', '--scope', 'unknown'],
    ['--group', 'spend', '--scope', 'scope', '--apply'], ['--group', 'spend', '--scope', 'scope', '--expect', 'digest'],
    ['--group', 'spend', '--scope', 'scope', '--yes'], ['--group', 'spend', '--scope', 'scope', '--rules', '{}'],
    ['--group', 'spend', '--scope', 'scope', '--scope', 'scope'], ['--group', 'spend', '--scope', 'scope', '--preview', '--apply'],
  ]) expect(await main([...prefix, ...suffix], context)).not.toBe(0);
  expect(seen).toEqual([]);
});
