import { expect, it } from 'vitest';
import { mcpCommand } from '#surfaces/core/cli/index.js';

// G3: `deckent mcp approve` without a lock flag gives no alwaysAsk list (the registry keeps the existing locks); releasing locks is explicit.
async function requestOf(...args: string[]) {
  const requests: unknown[] = [];
  await mcpCommand(['mcp', 'approve', 'fx', ...args], { root: '/p', env: {}, stdout: { write: () => true },
    runMcpCommand: async (_root: string, request: unknown) => { requests.push(request); return { schemaVersion: 1, approved: true, name: 'fx', scope: 'local', pinnedTools: 0 }; } } as never);
  return requests[0];
}
it('an approve without lock flags sends no list; --always-ask replaces; --no-always-ask is the explicit release', async () => {
  expect(await requestOf('--yes')).toEqual({ verb: 'approve', name: 'fx' });
  expect(await requestOf('--yes', '--always-ask', 'drop')).toEqual({ verb: 'approve', name: 'fx', alwaysAsk: ['drop'] });
  expect(await requestOf('--yes', '--no-always-ask')).toEqual({ verb: 'approve', name: 'fx', alwaysAsk: [] });
});
