import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRun, inspectRun, requestRunCancellation, deliverRunCancellation } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
it.skipIf(process.platform === 'win32')('reports absent policy membership consistently before ledger access or runtime profile disclosure across all Run operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-membership-'));
  try {
    const project = join(root, 'project'); const data = join(root, 'data');
    await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [] }), { mode: 0o600 });
    const options = { env: { HOME: join(root, 'home') } }; const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
    const command = { ...query, commandId: 'cancel', action: 'cancel' as const, expectedRevision: 0 };
    const calls = [
      () => inspectRun(project, query, options),
      () => requestRunCancellation(project, command, options),
      () => deliverRunCancellation(project, command, options),
      () => createRun(project, { ...query, commandId: 'create', graph: { schemaVersion: 2, revision: 1,
        tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['verified'] }],
        criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify purchase', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] } }, options),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await readdir(data)).toEqual(['policy.json']);
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
