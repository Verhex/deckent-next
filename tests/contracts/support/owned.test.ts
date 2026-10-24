import { afterEach, expect, it } from 'vitest';
import { childEnv } from './child-env.js';
import { owned, OwnedResources, OwnedTeardownError } from './owned.js';

// Stage B harness proof (process groups and /bin/sh are POSIX; Windows children are stopped one by one): a deadline is a typed failure, not a hang; an orphaned grandchild and a temporary root are seen as leaks until
// teardown removes them; a failing release never skips the next and all failures surface together; owned() tears down after the test.
const ambient = ['OWNED_TEST_CREDENTIAL', 'FORCE_COLOR', 'CLAUDECODE'] as const;
afterEach(() => { for (const name of ambient) delete process.env[name]; });

it('a child past its deadline fails with TEST_CHILD_DEADLINE and its process group is stopped and reaped', async () => {
  const scope = new OwnedResources(), started = Date.now();
  await expect(scope.run(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { env: childEnv(), deadlineMs: 300 }))
    .rejects.toMatchObject({ code: 'TEST_CHILD_DEADLINE' });
  expect(Date.now() - started).toBeLessThan(5_000);
  await scope.teardown();
  expect(await scope.leaks()).toEqual([]);
});

it.skipIf(process.platform === 'win32')('setup that fails after acquiring a root and a child leaves both visible as leaks; teardown releases them all and aggregates every failure', async () => {
  const scope = new OwnedResources(), order: string[] = [];
  const setup = async () => {
    await scope.root('deckent-owned-test-');
    // The shell exits at once; its background sleep stays in the group (an orphaned grandchild).
    const shell = scope.spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { env: childEnv(), deadlineMs: 10_000, stdio: 'ignore' });
    await shell.exit;
    scope.defer('first closer', () => { order.push('first'); });
    scope.defer('failing store', () => { throw new Error('STORE_CLOSE_FAILED'); });
    scope.defer('failing client', async () => { throw new Error('CLIENT_CLOSE_FAILED'); });
    throw new Error('SETUP_FAILED');
  };
  await expect(setup()).rejects.toThrow('SETUP_FAILED');
  expect(await scope.leaks()).toEqual(expect.arrayContaining([expect.stringMatching(/^path /u), expect.stringMatching(/^process \/bin\/sh/u)]));
  const failure = await scope.teardown().then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(OwnedTeardownError);
  expect((failure as OwnedTeardownError).code).toBe('TEST_TEARDOWN_FAILED');
  expect((failure as OwnedTeardownError).errors.map(error => (error as Error).message)).toEqual(['CLIENT_CLOSE_FAILED', 'STORE_CLOSE_FAILED']);
  expect(order).toEqual(['first']);
  expect(await scope.leaks()).toEqual([]);
});

let survivor: number | undefined;
it.skipIf(process.platform === 'win32')('owned() registers the running test teardown', async () => {
  const { child } = owned().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: childEnv(), deadlineMs: 20_000 });
  survivor = child.pid;
  expect(survivor).toBeTypeOf('number');
});
it.skipIf(process.platform === 'win32')('…which reaped that child once the previous test finished', () => {
  expect(survivor).toBeTypeOf('number');
  expect(() => process.kill(-survivor!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('a spawned child inherits only allowlisted variables: no credential, agent marker or FORCE_COLOR; overrides apply', async () => {
  Object.assign(process.env, { OWNED_TEST_CREDENTIAL: 'canary', FORCE_COLOR: '1', CLAUDECODE: '1' });
  const env = childEnv({ HOME: '/nonexistent/home', NO_COLOR: '1' });
  const seen = JSON.parse((await owned().exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env, deadlineMs: 10_000 })).stdout) as Record<string, string>;
  for (const name of ambient) expect(seen).not.toHaveProperty(name);
  expect(seen).toMatchObject({ HOME: '/nonexistent/home', NO_COLOR: '1', PATH: process.env['PATH'] });
});
