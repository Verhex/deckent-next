import { expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigApplication } from '#engine/index.js';
import { createDefaultConfig, registerConfigSection } from '#platform/index.js';
it('never prints a secret-like schema default in inspect or explain JSON', async () => {
  const canary = 'SCHEMA_CREDENTIAL_CANARY';
  registerConfigSection('credential_view_fixture', z.object({ apiToken: z.string().default(canary) }).strict(), {
    metadata: { descriptionKey: 'config.field.projectName', tier: 'custom', since: '1', binding: { state: 'bound', consumers: ['src/engine/core/config'] }, apply: 'live' },
  });
  const effective = createDefaultConfig();
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } },
    { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  expect(JSON.stringify(await app.inspect())).not.toContain(canary);
  expect(JSON.stringify(await app.explain({ keyPath: 'credential_view_fixture.apiToken' }))).not.toContain(canary);
  expect(JSON.stringify(await app.explain({ keyPath: 'credential_view_fixture' }))).not.toContain(canary);
});
it('derives nested union discriminator schema from every registered branch', async () => {
  registerConfigSection('union_view_fixture', z.object({ authentication: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }), z.object({ type: z.literal('bearer'), apiToken: z.string() }),
  ]) }).strict(), {
    metadata: { descriptionKey: 'config.field.projectName', tier: 'custom', since: '1', binding: { state: 'bound', consumers: ['src/engine/core/config'] }, apply: 'live' },
  });
  const effective = { ...createDefaultConfig(), union_view_fixture: { authentication: { type: 'bearer', apiToken: 'UNION_CANARY' } } };
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } },
    { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  const field = await app.explain({ keyPath: 'union_view_fixture.authentication.type' });
  expect(JSON.stringify(field.schema)).toContain('none');
  expect(JSON.stringify(field.schema)).toContain('bearer');
  expect(JSON.stringify(await app.inspect())).not.toContain('UNION_CANARY');
});
