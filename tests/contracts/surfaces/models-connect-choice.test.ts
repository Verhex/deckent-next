import { expect, it, vi } from 'vitest';

// BeUser M-27: the person's connect cards start with the cursor on a row (so the first Down moves to row 2) and never say "Connect Connect".
const asked: { title: string; initial?: string | null; options: readonly { id: string }[] }[] = [];
vi.mock('../../../src/surfaces/core/cli-models/internal/io.js', async original => ({ ...(await original() as object), modelsInteractive: () => true,
  askModelsCard: async (_context: unknown, _locale: unknown, request: { title: string; initial?: string | null; options: readonly { id: string }[] }) => {
    asked.push(request); return request.options.some(option => option.id === 'apply') ? 'cancel' : request.options[1]?.id ?? null; } }));

it('the connection and model lists preselect their first row; the pull card reads "Connect all available priced models?"', async () => {
  const { modelsCommand } = await import('#surfaces/core/cli-models/index.js');
  const kinds = [{ id: 'claude-cli-subscription', labelKey: 'tui.provider.kind.claudeCli', available: true, seeded: true, pull: 'available' as const, connectFamily: 'f' },
    { id: 'codex-cli-subscription', labelKey: 'tui.provider.kind.codexCli', available: true, seeded: true, pull: 'available' as const, connectFamily: 'f' }];
  await modelsCommand(['models', 'connect', '--scope', 's'], { root: '/project', env: {}, stdout: { write: () => true } as never, stderr: { write: () => true } as never,
    connectModel: async () => { throw new Error('must not connect'); }, providerConnect: { kinds, seedModels: async () => [{ nativeId: 'm', displayName: 'm' }] } } as never).catch(() => undefined);
  expect(asked[0]).toMatchObject({ initial: 'claude-cli-subscription' });
  expect(asked[1]!.title).toBe('Connect all available priced models?');
});
