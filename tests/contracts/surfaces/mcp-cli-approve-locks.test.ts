import { expect, it, vi } from 'vitest';
import { mcpCommand } from '#surfaces/core/cli/index.js';

// A person at a terminal (the card is answered here; the Ink card is PTY-proven on the built binary).
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real, cliMode: () => ({ mode: 'interactive' as const, reason: 'tty' as const }), askCliCard: async () => 'yes' };
});

// G3: `deckent mcp approve` without a lock flag gives no alwaysAsk list (the registry keeps the existing locks); releasing locks is explicit.
async function requestOf(...args: string[]) {
  const requests: unknown[] = [];
  await mcpCommand(['mcp', 'approve', 'fx', ...args], { root: '/p', env: {}, stdout: { write: () => true }, stderr: { write: () => true },
    runMcpCommand: async (_root: string, request: unknown) => { requests.push(request); return { schemaVersion: 1, approved: true, name: 'fx', scope: 'local', pinnedTools: 0 }; } } as never);
  return requests[0];
}
it('an approve without lock flags sends no list; --always-ask replaces; --no-always-ask is the explicit release', async () => {
  expect(await requestOf()).toEqual({ verb: 'approve', name: 'fx' });
  expect(await requestOf('--always-ask', 'drop')).toEqual({ verb: 'approve', name: 'fx', alwaysAsk: ['drop'] });
  expect(await requestOf('--no-always-ask')).toEqual({ verb: 'approve', name: 'fx', alwaysAsk: [] });
  // C-MODELS (owner A48-D5/D6): `--yes` never skips the card any more, so it no longer marks the request unattended; the person answers the card.
  expect(await requestOf('--yes', '--always-ask', 'drop')).toEqual({ verb: 'approve', name: 'fx', alwaysAsk: ['drop'] });
});
