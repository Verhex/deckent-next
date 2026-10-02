import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
vi.mock('zod-to-json-schema', { spy: true });
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


it('masks token content and URL passwords through the real application in all config surfaces', async () => {
  const { configCommand, configSlash } = await import('#surfaces/core/config/index.js');
  const { monitorCommand, loadMonitorSurface } = await import('#surfaces/core/monitor/index.js');
  const { configMonitorBlocks } = await loadMonitorSurface();
  const strings = ['--credential sk-ARGVCANARY', 'ghp_GITHUBCANARY', 'Bearer BEARERCANARY', 'password=VALUECANARY', 'eyJCANARY.payload.signature'];
  const passwords = ['ARGVCANARY', 'GITHUBCANARY', 'BEARERCANARY', 'VALUECANARY', 'eyJCANARY', 'URLCANARY'];
  const effective = createDefaultConfig();
  effective.execution = { docker: { executable: strings[0] } } as never;
  effective.toolchains.currency.registryEndpoint = 'https://owner:URLCANARY@example.org';
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } },
    { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  registerConfigSection('argv_view_fixture', z.object({ argv: z.array(z.string()).default(strings) }).strict(), {
    metadata: { descriptionKey: 'config.field.execution', tier: 'custom', since: '1', binding: { state: 'bound', consumers: ['src/engine/core/config'] }, apply: 'live' },
  });
  effective['argv_view_fixture'] = { argv: strings };
  const assertMasked = (output: string) => { for (const value of passwords) expect(output).not.toContain(value); expect(output).toContain('[REDACTED]'); };
  assertMasked(JSON.stringify(await app.inspect()));
  for (const keyPath of ['execution.docker.executable', 'argv_view_fixture', 'argv_view_fixture.argv', 'argv_view_fixture.argv.0', 'toolchains.currency.registryEndpoint']) {
    const value = JSON.stringify(await app.explain({ keyPath }));
    for (const canary of passwords) expect(value).not.toContain(canary);
    expect(value).toContain('[REDACTED]');
  }
  for (const locale of ['en', 'tr'] as const) {
    const output: string[] = [], ctx = { root: '/tmp/config-content', env: {}, configApplication: () => app, stdout: { write: (s: string) => { output.push(s); } } };
    for (const args of [['config'], ['config', '--json'], ['config', 'explain', 'argv_view_fixture.argv.0'], ['config', 'explain', 'argv_view_fixture.argv', '--json'], ['config', 'explain', 'toolchains.currency.registryEndpoint'], ['config', 'explain', 'toolchains.currency.registryEndpoint', '--json']]) {
      output.length = 0; await configCommand([...args, '--lang', locale], ctx); assertMasked(output.join(''));
    }
    assertMasked((await configSlash(ctx.root, '', ctx, {}, locale, 80)).join('\n'));
    for (const json of [false, true]) {
      output.length = 0; await monitorCommand(['monitor', '--config', '--once', '--lang', locale, ...(json ? ['--json'] : [])], ctx); assertMasked(output.join(''));
    }
    const blocks = configMonitorBlocks(await app.inspect(), locale);
    assertMasked(JSON.stringify(blocks));
    for (const block of blocks) if (block.kind === 'table') for (const row of block.rows) for (const canary of passwords) expect(JSON.stringify(row.detail())).not.toContain(canary);
  }
});


it('converts schemas once per registry generation and remasks changing provenance after cache hits', async () => {
  const spy = vi.mocked(zodToJsonSchema); spy.mockClear();
  registerConfigSection('cache_initial_fixture', z.object({ value: z.string().default('SCHEMA_CACHE_CANARY') }).strict(), {
    metadata: { descriptionKey: 'config.field.projectName', tier: 'custom', since: '1', binding: { state: 'bound', consumers: ['src/engine/core/config'] }, apply: 'live' },
  });
  const effective = createDefaultConfig(); effective.layout.resources = { credential: 'PLAINCACHE' };
  effective['cache_initial_fixture'] = { value: 'SCHEMA_CACHE_CANARY' };
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } },
    { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  try {
    await app.inspect(); const initial = spy.mock.calls.length; expect(initial).toBeGreaterThan(0);
    effective['secretPaths'] = ['/layout/resources/credential', '/cache_initial_fixture/value'];
    effective.layout.resources['newName'] = 'NEWPUBLIC';
    const remasked = await app.inspect();
    expect(remasked.fields.find(field => field.key === 'layout.resources.credential')?.value).toBe('[REDACTED]');
    const cachedField = remasked.fields.find(field => field.key === 'cache_initial_fixture.value');
    expect(cachedField?.value).toBe('[REDACTED]');
    expect(JSON.stringify(cachedField?.schema)).not.toContain('SCHEMA_CACHE_CANARY');
    await app.explain({ keyPath: 'layout.resources.credential' }); expect(spy).toHaveBeenCalledTimes(initial);
    registerConfigSection('cache_revision_fixture', z.object({ added: z.string().default('new') }).strict(), {
      metadata: { descriptionKey: 'config.field.projectName', tier: 'custom', since: '1', binding: { state: 'bound', consumers: ['src/engine/core/config'] }, apply: 'live' },
    });
    expect((await app.inspect()).fields.find(field => field.key === 'cache_revision_fixture.added')?.defaultValue).toBe('new');
    expect(spy.mock.calls.length).toBeGreaterThan(initial);
  } finally { spy.mockClear(); }
});
