import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory, writeEvent, readEvent } from './jev-journal.mjs';

test('Windows private journals refuse before creating any state (native Windows; simulated guard elsewhere)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-journal-refusal-'));
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    const journal = join(root, 'absent');
    await assert.rejects(privateDirectory(journal), /JEV_JOURNAL_UNSUPPORTED/);
    await assert.rejects(writeEvent(journal, 'request.json', { schemaVersion: 1 }), /JEV_JOURNAL_UNSUPPORTED/);
    await assert.rejects(readEvent(journal, 'request.json'), /JEV_JOURNAL_UNSUPPORTED/);
    assert.deepEqual(await readdir(root), []);
  } finally { Object.defineProperty(process, 'platform', original); await rm(root, { recursive: true, force: true }); }
});
