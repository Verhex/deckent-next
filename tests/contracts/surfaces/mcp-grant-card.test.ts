import { expect, it } from 'vitest';
import { offerMcpGrants, type SecretGrantCardPort } from '#surfaces/core/terminal-kit/index.js';
import { mcpPanelPort } from '#surfaces/core/cli-terminal/index.js';

// KER-17 audit (lead 2026-10-28): the existing person-only first-use card answers an MCP key that this project has not granted.
const card = (offer = true) => {
  const granted: string[] = [];
  return { granted, port: { offer: async () => offer, question: (name: string, project: string) => ({ title: `Allow ${name}`, prompt: 'y/n', lines: [{ label: 'project', text: project }] }),
    grant: async (name: string) => { granted.push(name); } } satisfies SecretGrantCardPort };
};

it('after a turn the card is offered once per key and session; no keeps it closed; only yes grants; a terminal that may not answer is never asked', async () => {
  const offered = new Set<string>(), asked: string[] = [], c = card();
  const keys = async () => [{ name: 'GH', project: '/p' }, { name: 'DOCS', project: '/p' }];
  expect(await offerMcpGrants(keys, c.port, async question => { asked.push(question.title); return question.title === 'Allow GH'; }, offered, name => `given ${name}`)).toEqual(['given GH']);
  expect(c.granted).toEqual(['GH']); expect(asked).toEqual(['Allow GH', 'Allow DOCS']);
  expect(await offerMcpGrants(keys, c.port, async () => true, offered, name => name)).toEqual([]); // once per key in this session
  const none = card(false), never: string[] = [];
  expect(await offerMcpGrants(keys, none.port, async q => { never.push(q.title); return true; }, new Set(), name => name)).toEqual([]);
  expect(never).toEqual([]); expect(none.granted).toEqual([]);
});

it('/mcp shows "allow its key" only on a server refused for a missing grant, and the action uses the same card', async () => {
  const c = card();
  const run = async (_root: string, request: { verb: string }) => request.verb === 'list' ? { servers: [
    { name: 'gh', scope: 'user', status: 'invalid-launch', reason: 'secret-refused:SECRET_GRANT_REQUIRED:GH' },
    { name: 'docs', scope: 'user', status: 'invalid-launch', reason: 'secret-refused:SECRET_PROJECT_MISSING:DOCS' }], problems: [] } : {};
  const port = mcpPanelPort('/p', run as never, {}, 'en', c.port);
  const list = await port.list();
  expect(list.servers.map(server => server.grantKey)).toEqual(['GH', undefined]);
  expect(await port.grantKey!('gh', 'GH', async () => false)).toEqual([expect.stringContaining('Not now')]); expect(c.granted).toEqual([]);
  expect(await port.grantKey!('gh', 'GH', async () => true)).toEqual([expect.stringContaining('may now be used')]); expect(c.granted).toEqual(['GH']);
  expect((await mcpPanelPort('/p', run as never, {}, 'en').list()).servers.every(server => server.grantKey === undefined)).toBe(true);
});
