import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const helper = resolve(import.meta.dirname, '../build/Release/shell-overlay-scan');
// The lister prints one NUL-terminated record per entry (type, mode, nlink, size, rdev, flags, path), follows no link, and refuses the
// whole listing past its entry bound (exit 3) or with a relative root (exit 2). Overlay flags need a real overlay: covered by the realm tests.
test('overlay upper lister: records, no link followed, bounds and usage fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'overlay-scan-'));
  try {
    mkdirSync(join(root, 'd')); writeFileSync(join(root, 'd', 'f'), 'abc'); symlinkSync('/etc', join(root, 'link'));
    const records = execFileSync(helper, [root, '10']).toString('utf8').split('\0').filter(Boolean).sort();
    // type, rdev, flags, path (modes, link counts and directory sizes depend on the file system and umask)
    assert.deepEqual(records.map(record => { const [type, , , size, major, minor, flags, path] = record.split(' '); return `${type} ${type === 'd' ? '-' : size} ${major}:${minor} ${flags} ${path}`; }),
      ['d - 0:0 - d', 'f 3 0:0 - d/f', 'l 4 0:0 - link']);
    assert.equal(spawnSync(helper, [root, '2']).status, 3);
    assert.equal(spawnSync(helper, ['relative', '2']).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
