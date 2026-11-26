import { expect, it, vi } from 'vitest';
import type { ModelConnectResult } from '#domain/index.js';

// BeUser M-27: the person's connect cards start with the cursor on a row (so the first Down moves to row 2) and never say "Connect Connect".
let confirmation = 'cancel';
const asked: { title: string; initial?: string | null; options: readonly { id: string }[] }[] = [];
vi.mock('../../../src/surfaces/core/cli-models/internal/io.js', async original => ({ ...(await original() as object), modelsInteractive: () => true,
  askModelsCard: async (_context: unknown, _locale: unknown, request: { title: string; initial?: string | null; options: readonly { id: string }[] }) => {
    asked.push(request); return request.options.some(option => option.id === 'apply') ? confirmation : request.options[1]?.id ?? null; } }));

it('the connection and model lists preselect their first row; the pull card reads "Connect all available priced models?"', async () => {
  const { modelsCommand } = await import('#surfaces/core/cli-models/index.js');
  const kinds = [{ id: 'claude-cli-subscription', labelKey: 'tui.provider.kind.claudeCli', available: true, seeded: true, pull: 'available' as const, connectFamily: 'f' },
    { id: 'codex-cli-subscription', labelKey: 'tui.provider.kind.codexCli', available: true, seeded: true, pull: 'available' as const, connectFamily: 'f' }];
  const context = { root: '/project', env: {}, stdout: { write: () => true }, stderr: { write: () => true },
    providerConnect: { kinds, seedModels: async () => [{ nativeId: 'm', displayName: 'm' }] } };
  const argv = ['models', 'connect', '--scope', 's'];
  expect(await modelsCommand(argv, { ...context, connectModel: async () => { throw new Error('must not connect'); } } as never)).toBe(1);
  expect(asked[0]).toMatchObject({ initial: 'claude-cli-subscription' });
  expect(asked[1]!.title).toBe('Connect all available priced models?');
  confirmation = 'apply';
  const pending: ModelConnectResult = { schemaVersion: 1, operation: 'models.connect', commandId: 'c-1', status: 'approval-pending', scopeId: 's', connection: kinds[1]!.id,
    reference: { providerId: 'fixture', providerVersion: 1, modelId: 'm', modelVersion: 1 },
    credentialRef: null, keyStored: null, tariff: 'unmetered', service: null,
    steps: { catalog: 'written', declaration: 'written', profile: 'skipped', activation: 'skipped', carried: 0 }, notCarried: [], carriedModels: [],
    approval: { approvalId: 'connect-ap-1', keyPath: 'provider_invocation_profiles', layer: 'project' } };
  const output: string[] = [];
  const code = await modelsCommand(argv, { ...context, stdout: { write(text: string) { output.push(text); return true; } },
    connectModel: async () => pending } as never);
  expect(output.join('')).toContain('connect-ap-1');
  expect(code).toBe(1);
});
