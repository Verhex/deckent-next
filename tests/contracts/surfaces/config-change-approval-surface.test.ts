import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalRequestSchema } from '#domain/index.js';
import { configChangeApprovalFacts, sealApproval, type ConfigChangeOutcome } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { approvalCardLines } from '#surfaces/core/terminal-work/index.js';
import { createWorklineLedgerPorts, workSurfaceLabels } from '#surfaces/core/cli/index.js';
import { configCommand, configSlash, type ConfigCommandContext } from '#surfaces/core/config/index.js';
import { composeCore } from '#composition/core/root/index.js';

// T3 L2 CONFIG-APPROVAL surfaces: a sealed config-change record reaches the existing approval window and /approvals page through the same
// workline port as every approval ("What: setting will change: …"), and the CLI / terminal write routes say that nothing was written.
const NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const integrity = createHmacIntegrity('key', randomBytes(32));
function record(summary: string) {
  return sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 3, approvalId: '7a48a7f0-164d-4a2f-9353-3c3079009bec', scopeId: 'scope',
    subject: { kind: 'config-change', commandId: 'cmd-1', action: 'set', layer: 'project', keyPath: 'terminal.theme', before: '"auto"', after: '"dark"',
      expectDigest: digest('layer'), valueDigest: digest('dark'), ruleId: 'company-config-approval' },
    requester: { id: 'owner', issuer: 'host', subject: '1000' }, actionDigest: digest('action'), policyRevision: 'p1', summary, createdAt: NOW - 10_000, expiresAt: NOW + 590_000,
    facts: configChangeApprovalFacts(null, 'scope') }), revision: 0, status: 'pending', decision: null }, integrity);
}

describe('config-change approval in the existing approval window and /approvals page', () => {
  for (const [locale, summary, what, risk] of [
    ['en', 'Setting will change: terminal.theme auto → dark (project)', 'What', 'Writes'],
    ['tr', 'ayar değişecek: terminal.theme auto → dark (proje)', 'Ne', 'Veri yazar'],
  ] as const) {
    it(`${locale}: the page lists it; the window's first field is the sentence, never a run or a tool`, async () => {
      const ports = createWorklineLedgerPorts({ root: '/p', scopeId: 'scope', options: {}, locale, inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never,
        listApprovals: async () => [record(summary)], decideApproval: async () => ({}) })!;
      const page = await ports.listApprovalPage!(null);
      expect(page.items).toHaveLength(1);
      const [item] = page.items;
      expect(item).toMatchObject({ summary, runId: '-', taskId: '-', risk: 'write', undo: null, requiredAssurance: 'peer-session' });
      const text = approvalCardLines(item!, workSurfaceLabels(locale), '', null, { project: '/home/u/acme', mode: 'standart' }, NOW).join('\n');
      expect(text).toContain(summary);
      expect(text.split('\n').find(line => line.includes(summary))).toMatch(new RegExp(`^\\s*${what}\\b`));
      expect(text).toContain(risk);
      expect(text).not.toMatch(/run_shell|edit_file/);
    });
  }
});

describe('config write routes: pending writes nothing and says how it applies', () => {
  const pending: ConfigChangeOutcome = { status: 'approval-pending', commandId: 'cmd-1', expect: digest('layer'), keyPath: 'max_workers', layer: 'project',
    approval: { approvalId: 'appr-1', revision: 0, expiresAt: NOW, summary: 'ayar değişecek: max_workers auto → 2 (proje)' } };
  function context(outcome: ConfigChangeOutcome, seen: unknown[], output: string[] = []): ConfigCommandContext {
    const app = { submit: async (action: string, input: unknown) => { seen.push({ action, input }); return outcome; },
      explain: async () => ({ apply: 'live' }), inspect: async () => ({ schemaVersion: 1, digest: null, layer: 'project', fields: [] }) };
    return { root: '/nonexistent-deckent-root', env: { DECKENT_LANGUAGE: 'tr' }, configApplication: () => app as never,
      resolveConfigPrincipal: async () => ({ id: 'owner', issuer: 'host', subject: '1000', scopeIds: ['scope'] }) as never,
      stdout: { write: (value: string) => { output.push(value); } } } as ConfigCommandContext;
  }
  it('CLI: set prints the pending approval, the sentence and the exact resubmission (command id + previewed digest); nothing claims "saved"', async () => {
    const seen: unknown[] = [], output: string[] = [];
    await configCommand(['config', 'set', 'max_workers', '2', '--scope', 'scope', '--command-id', 'cmd-1', '--lang', 'tr'], context(pending, seen, output));
    const text = output.join('');
    expect(text).toContain('Hiçbir şey yazılmadı; appr-1 onayı bekliyor. Ne: ayar değişecek: max_workers auto → 2 (proje)');
    expect(text).toContain(`--command-id cmd-1 --expect ${digest('layer')}`);
    expect(text).not.toContain('kaydedildi');
    expect(seen).toEqual([{ action: 'set', input: expect.objectContaining({ keyPath: 'max_workers', value: 2, scopeId: 'scope', commandId: 'cmd-1', layer: 'project' }) }]);
  });
  it('terminal /config set: the principal\'d write port; typing the same change again resubmits the pending command (same id and digest)', async () => {
    composeCore(); // the terminal config section (`terminal.scopeId`) is registered by composition, as in the running terminal
    const root = await mkdtemp(join(tmpdir(), 'config-slash-')); roots.push(root);
    await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }));
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const ctx = context(pending, seen), options = { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global'), DECKENT_LANGUAGE: 'tr' }, heal: false };
    const first = await configSlash(root, 'set max_workers 2', ctx, options, 'tr', 80);
    expect(first.join('\n')).toContain('Hiçbir şey yazılmadı; appr-1 onayı bekliyor.'); expect(first.join('\n')).toContain('/approvals');
    await configSlash(root, 'set max_workers 2', ctx, options, 'tr', 80);
    expect(seen.map(item => item.action)).toEqual(['set', 'set']);
    expect(seen[0]!.input).toMatchObject({ keyPath: 'max_workers', value: 2, scopeId: 'scope', layer: 'project' }); expect(seen[0]!.input['expect']).toBeUndefined();
    expect(seen[1]!.input).toMatchObject({ commandId: pending.commandId, expect: digest('layer') }); // the pending command, as the engine reported it
    // A different value is a different change: a new command, no previewed digest carried over.
    await configSlash(root, 'set max_workers 3', ctx, options, 'tr', 80);
    expect(seen[2]!.input['commandId']).not.toBe(pending.commandId); expect(seen[2]!.input['expect']).toBeUndefined();
  });
  it('terminal /config: usage names the write routes in both languages', async () => {
    const ctx = context(pending, []);
    for (const locale of ['en', 'tr'] as const) {
      const [usage] = await configSlash('/x', 'set', ctx, {}, locale, 80);
      expect(usage).toMatch(/\/config set <[^>]+> <json>/);
    }
  });
});

describe('the model cannot reach a config write', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
  it('only human surfaces (CLI entry, terminal /config and its window, the monitor\'s settings view, toolchain refresh) and the governed models.connect operation compose the config write path; no agent tool and no MCP config tool does', () => {
    // T3 L4: the `/config` window is a new caller — the list grows by exactly its files, and the pattern also catches a non-null-asserted
    // factory call (`configApplication!(`), the terminal write (`terminalConfigWrite(`) and the window port (`configPanelPort(`).
    // T4-B D2 (owner 2026-10-08, ARCHITECTURE `models.connect`): the one `models.connect` operation (CLI, MCP `connect_model`, SDK, terminal
    // `/provider`) writes its catalog/profile/default-model keys only through the governed `/config` writer (policy, approval card, audit), and the
    // terminal `/model` window writes the default model the same way. The terminal agent loop still has no route; MCP has no config tool of its own.
    const writers = files('src').filter(path => /\.(ts|tsx)$/.test(path))
      .filter(path => /createConfiguredConfigApplication|configApplication!?\(|configWrite\(|terminalConfigWrite\(|configPanelPort\(/.test(readFileSync(path, 'utf8')))
      .map(path => path.replaceAll('\\', '/')).sort();
    expect(writers).toEqual(['src/composition/core/cli/internal/entry.ts', 'src/composition/core/config/index.ts', 'src/composition/core/config/internal/configured.ts',
      'src/composition/core/model-connect/internal/connect.ts', 'src/composition/core/toolchains/internal/refresh.ts',
      'src/surfaces/core/cli-terminal/internal/cache-panel.ts', // CACHE-SLICE1 (34270fae): the terminal cache-choice window writes profiles through the same writer
      'src/surfaces/core/cli-terminal/internal/model-panel.ts',
      'src/surfaces/core/cli-terminal/internal/protocol-panel.ts', // OPENAI-RESPONSES: the terminal /model protocol-migration window writes profiles through the same governed writer (as cache-panel)
      'src/surfaces/core/cli-terminal/internal/terminal.ts', 'src/surfaces/core/config/internal/command.ts', 'src/surfaces/core/config/internal/panel.ts',
      'src/surfaces/core/config/internal/records.ts', 'src/surfaces/core/monitor/internal/command.ts']); // records.ts: the /config window's selection-only record editors (8ce20e6f)
    for (const path of writers) expect(path).not.toMatch(/agent-turn|agent-tool|\/mcp\//);
    // The governed models.connect route is not reachable from the agent loop either: no agent unit names it.
    expect(files('src').filter(path => /agent-turn|agent-tool/.test(path) && /\.(ts|tsx)$/.test(path))
      .filter(path => /connectConfiguredModel|connectModel|model-connect/.test(readFileSync(path, 'utf8')))).toEqual([]);
    const mcp = readFileSync('src/surfaces/core/mcp/internal/server.ts', 'utf8');
    expect([...mcp.matchAll(/name: '([a-z_]+)'/g)].map(match => match[1]).filter(name => /config/.test(name!))).toEqual([]);
  });
});
