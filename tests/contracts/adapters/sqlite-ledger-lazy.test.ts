import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('imports the compiled SDK without loading native SQLite, then loads it only on explicit storage selection', async () => {
  const script = `
    import { registerHooks } from 'node:module';
    let selected = 0;
    registerHooks({ load(url, context, nextLoad) {
      if (url === 'node:sqlite') { selected++; throw new Error('SQLITE_SELECTION_PROBE'); }
      return nextLoad(url, context);
    }});
    await import(process.argv[1]);
    if (selected !== 0) throw new Error('EAGER_SQLITE_LOAD');
    const { openSqliteAttemptStore } = await import(process.argv[2]);
    if (selected !== 0) throw new Error('EAGER_ADAPTER_LOAD');
    let blocked = false;
    try { await openSqliteAttemptStore(':memory:', { busyTimeoutMs: 100, journalMode: 'delete', durability: 'full' }); }
    catch (error) { if (error.message !== 'SQLITE_SELECTION_PROBE') throw error; blocked = true; }
    if (!blocked || selected !== 1) throw new Error('NATIVE_SELECTION_NOT_OBSERVED');
    process.stdout.write(JSON.stringify({ importedWithoutSqlite: true, selected }));
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script,
    pathToFileURL(resolve('dist/index.js')).href, pathToFileURL(resolve('dist/adapters/index.js')).href],
  { timeout: 10_000, maxBuffer: 65_536 });
  expect(JSON.parse(result.stdout)).toEqual({ importedWithoutSqlite: true, selected: 1 });
});
