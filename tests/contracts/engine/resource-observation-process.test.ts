import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('lets a process exit with an unfinished worker observation instead of waiting for its next poll', async () => {
  const engine = pathToFileURL(resolve('dist/engine/index.js')).href;
  const platform = pathToFileURL(resolve('dist/platform/index.js')).href;
  const root = await mkdtemp(join(tmpdir(), 'resource-observation-exit-')), witness = join(root, 'sampled');
  const program = `
    import { writeFileSync } from 'node:fs';
    import { ResourceCollector, resourceGap } from ${JSON.stringify(engine)};
    import { getConfigFieldDefault } from ${JSON.stringify(platform)};
    const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
    const settings = { ...getConfigFieldDefault('resourceObservation'), intervalMs: 60000 };
    const collector = new ResourceCollector({ async append() { writeFileSync(${JSON.stringify(witness)}, 'sampled'); }, async read() { return { samples: [], trimmedBeforeMs: null }; } }, settings);
    collector.start({ protocolVersion: 1, identity, workspace: '/test', argv: ['worker'] },
      { async readResources() { return resourceGap(identity, Date.now(), 'starting'); } });
  `;
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { timeout: 2000 });
    expect(await readFile(witness, 'utf8')).toBe('sampled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
